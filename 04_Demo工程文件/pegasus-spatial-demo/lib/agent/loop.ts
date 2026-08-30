// Agent Loop — pure loop logic, no external dependencies

import { createHash, randomUUID } from 'crypto'
import type { ContentBlock, ConversationMessage, ToolResult, ToolCallRecord, TokenUsage, AgentLoopResult, LLMResponse, ToolResultContent, ImageBlock, InlineImageData, ToolSchema } from '../types'
import type { WorkspaceInstance } from '../workspace/types'
import {
  getTotalInputTokens,
  reactiveCompact,
  estimateTokens,
  FULL_COMPACT_PROMPT,
  extractSummaryTag,
  buildAsyncCompactionMessage,
  buildWorkspaceProjection,
  effectiveRequestOverheadTokens,
  estimateRequestInputTokens,
} from './compaction'
import { processImageForContext } from './image-resizer'
import { tokenTracker } from './token-tracker'
import {
  acknowledgeDequeuedMessages,
  dequeueMessages,
  partitionQueuedMessages,
} from './message-queue'
import { buildUntrustedDataReminder } from './system-reminder'
import { logAPICall } from '../db/api-log-repository'
import { foldExpiredToolResults } from './tool-result-folding'
import { admitToolResult } from './tool-result-admission'
import { normalizeAskUserQuestionInput } from './ask-user'
import type { AskUserInteraction } from '../types'
import {
  HippocampusRuntime,
  HippocampusTelemetry,
  type HippocampusSafetyState,
  type HippocampusTelemetryState,
} from './hippocampus-runtime'
import type {
  FrozenProjectContextSnapshot,
  FrozenWorkspaceProjection,
} from '../agent-runtime/types'
import {
  buildProjectContextReminder,
  type FrozenProjectContext,
} from './project-context'
import type { ToolExecutionInvocation } from './execution-context'
import {
  enforceToolInputBoundary,
  enforceVisibleToolInputBoundary,
  isRejectedToolInput,
  rejectedToolInputResultMessage,
  type ToolInputRejection,
} from './tool-input-boundary'
import { isPromptTooLongLLMError } from './llm-api'

// ==================== Interfaces ====================

export interface AgentProvider {
  /** Exact schema set exposed in this Provider's model request. */
  readonly toolSchemas: readonly ToolSchema[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  buildRequest(messages: ConversationMessage[]): any
  /** Build a cache-sharing fork: shared prefix unchanged, uncached instruction appended after its breakpoint. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  buildCompactionRequest(messages: ConversationMessage[], instruction: string, maxTokens: number): any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  callLLM(request: any): Promise<LLMResponse>
  /** Silent LLM call — no SSE callbacks (used for compaction summary generation) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  callLLMSilent(request: any, abortSignal?: AbortSignal): Promise<LLMResponse>
  /** Refresh the frozen Project Context after a compaction merge advances its prompt epoch. */
  setProjectContext?(context?: FrozenProjectContext): void
  executeTool(
    name: string,
    input: Record<string, unknown>,
    invocation?: ToolExecutionInvocation,
  ): Promise<ToolResult>
  onTextChunk?(chunk: string): void
  onToolStart?(tool: string, input: Record<string, unknown>): void
  onToolExecuted?(tool: string, input: Record<string, unknown>, result: ToolResult): void
}

interface FairGateLease {
  release(): void
}

/**
 * FIFO in-process serialization complements (but never replaces) the Mongo
 * source-turn guard. It establishes a deterministic winner between the local
 * background summary offer and the next main-model turn in this process.
 */
class FairAsyncGate {
  private tail: Promise<void> = Promise.resolve()

  async acquire(): Promise<FairGateLease> {
    const previous = this.tail
    let releaseNext!: () => void
    this.tail = new Promise<void>(resolve => { releaseNext = resolve })
    await previous
    let released = false
    return {
      release() {
        if (released) return
        released = true
        releaseNext()
      },
    }
  }
}

export interface AgentLoopCompactionSettlement {
  status: 'merged' | 'failed' | 'cancelled'
  durationMs: number
  userWaitMs: number
  compactedTokens?: number
  removedMessages?: number
  reason?: string
}

export interface BackgroundCompactionHandoffDescriptor {
  /** Stable idempotency key of the already-started local compaction. */
  idempotencyKey: string
  sourceRunId?: string
  /** Registry alias frozen by the caller, when distinct from the resolved model id. */
  modelAliasSnapshot?: string
  /** Resolved provider model used by the local attempt. */
  modelIdSnapshot?: string
  prefixMessages: readonly ConversationMessage[]
  prefixTokens: number
  prefixHash: string
  prefixLength: number
  boundaryMessageId?: string
  projectContextSnapshot?: FrozenProjectContextSnapshot
}

export interface AgentLoopOptions {
  /** Stable top-level run identifier. New messages are stamped with this value. */
  runId?: string
  /** Optional safety valve — no hard limit by default. The loop stops when AI has no tool calls. */
  maxTurns?: number
  /** Model ID for token tracking */
  model?: string
  /** Stable registry alias used to resolve the model across process restarts. */
  modelAlias?: string
  /** Context window size for threshold calculations (default: 200000) */
  contextWindow?: number
  /** Main model output capability O. Request max_tokens is tightened against remaining W. */
  mainMaxOutputTokens?: number
  /** Compression summary output ceiling R. */
  summaryMaxTokens?: number
  /** Workspace instance — required for compaction to snapshot file contents */
  workspace?: WorkspaceInstance
  /** Exact Project Guide and workspace projection frozen for this prompt epoch. */
  projectContextSnapshot?: FrozenProjectContextSnapshot
  /** Called when compaction starts */
  onCompactionStart?: (preTokens: number) => void
  /** Called only after an atomic replacement has actually merged. */
  onCompactionDone?: () => void
  /** Distinguishes every terminal local outcome; handoff is not terminal here. */
  onCompactionSettled?: (info: AgentLoopCompactionSettlement) => void
  /**
   * Persist a restart-safe compaction job when the main loop exits before its
   * local background summary is ready. Returning a job id transfers ownership;
   * throwing or returning no job makes the loop drain locally instead.
   */
  onBackgroundCompactionHandoff?: (
    descriptor: BackgroundCompactionHandoffDescriptor,
  ) => Promise<{ jobId: string } | null | undefined>
  /**
   * Persist a delayed durable shadow before the local summary request starts.
   * The Job must not be claimable until `initialAvailableAt`, but its active
   * key must immediately protect newly-dispatched Runs.
   */
  onBackgroundCompactionPrepare?: (
    descriptor: BackgroundCompactionHandoffDescriptor & { initialAvailableAt: Date },
  ) => Promise<{ jobId: string } | null | undefined>
  /** Make the already-prepared shadow immediately claimable on loop exit. */
  onBackgroundCompactionActivate?: (input: {
    jobId: string
    idempotencyKey: string
  }) => Promise<boolean>
  /**
   * Persist a locally-generated summary into the prepared Job. Once accepted,
   * this process must never merge that summary; the durable worker is the
   * single writer for the owner context.
   */
  onBackgroundCompactionOfferSummary?: (input: {
    jobId: string
    idempotencyKey: string
    prefixHash: string
    summary: string
    usage?: TokenUsage
  }) => Promise<boolean>
  /** Pause/requeue the current Run after the durable Job takes ownership. */
  onBackgroundCompactionPause?: (input: {
    jobId: string
    idempotencyKey: string
  }) => void | Promise<void>
  /**
   * Fence one main-model turn against the durable worker. This guard is
   * independent from the worker lease and must be persisted on the exact Job.
   */
  onBackgroundCompactionAcquireSourceTurnGuard?: (input: {
    jobId: string
    idempotencyKey: string
    sourceRunId: string
  }) => Promise<{ guardToken: string; expiresAt: Date } | null | undefined>
  /** Extend the exact source-turn token; a stale token must return no lease. */
  onBackgroundCompactionHeartbeatSourceTurnGuard?: (input: {
    jobId: string
    idempotencyKey: string
    sourceRunId: string
    guardToken: string
  }) => Promise<{ expiresAt: Date } | null | undefined>
  /** Release only the exact source-turn token; stale releases are no-ops. */
  onBackgroundCompactionReleaseSourceTurnGuard?: (input: {
    jobId: string
    idempotencyKey: string
    sourceRunId: string
    guardToken: string
  }) => Promise<boolean>
  /** Runs only after a synchronous replacement is durably committed. */
  onFailedCompactionRepaired?: (input: {
    replacementCompactionId: string
    replacementMessageId: string
    reason: 'sync_fallback' | 'reactive_413'
  }) => void | Promise<void>
  /** Called when context approaches warning threshold */
  onTokenWarning?: (currentTokens: number, thresholdTokens: number) => void
  /** Called after each LLM call with total input tokens and estimated overhead */
  onTokenUsage?: (totalInputTokens: number) => void
  /** Last known prompt-cache activity for the active prefix. */
  promptCacheLastActivityAt?: Date | string | number | null
  /** Configured prompt-cache TTL; folding is disabled when omitted or <= 0. */
  promptCacheTtlMs?: number
  /** Records the most recent successful request that may have refreshed the prefix cache. */
  onPromptCacheActivity?: (at: Date) => void
  /** Called when expired, reconstructible tool payloads are folded locally. */
  onToolResultsFolded?: (info: { foldedResults: number; tokensFreed: number }) => void
  /** Persisted rolling evidence used by the F/B budget, never user-controlled. */
  hippocampusTelemetry?: Partial<HippocampusTelemetryState> | null
  hippocampusSafetyState?: Partial<HippocampusSafetyState> | null
  onHippocampusTelemetry?: (state: HippocampusTelemetryState) => void | Promise<void>
  onHippocampusSafetyState?: (state: HippocampusSafetyState) => void | Promise<void>
  /** Estimated fixed overhead tokens (system prompt + tools), excluded from progress bar */
  overheadTokens?: number
  /** Project Context's contribution inside overheadTokens, used after it is embedded by compaction. */
  projectContextOverheadTokens?: number
  /** AbortSignal for interruption support */
  abortSignal?: AbortSignal
  /** User ID for API call logging */
  userId?: string
  /** Conversation ID for mid-turn message queue consumption */
  conversationId?: string
  /**
   * Consume only queue entries explicitly addressed to this Run. Member
   * Agents use this mode so unaddressed user follow-ups remain Root-only.
   */
  midTurnQueueTargetedOnly?: boolean
  /** Persist transient tool image bytes and return the asset-backed image block. */
  persistImage?: (image: InlineImageData & { width?: number; height?: number }) => Promise<ImageBlock>
  /** Called when mid-turn messages are consumed from the queue */
  onMidTurnMessage?: (message: string) => void
  /** Persists an AskUserQuestion control boundary before it is exposed to SSE. */
  onAskUser?: (interaction: AskUserInteraction) => void | Promise<void>
  /** Durable action journal. A started action remains present after a process crash. */
  onActionStart?: (action: {
    kind: 'model_request' | 'tool_call' | 'compaction'
    actionId: string
    toolUseId?: string
    toolName?: string
    inputHash?: string
    prefixHash?: string
    attempt: number
    startedAt: Date
  }) => void | Promise<void>
  /** Clears the durable action only after its resulting message checkpoint is stored. */
  onActionComplete?: (info: {
    actionId: string
    checkpointMessageId?: string
  }) => void | Promise<void>
  /** Persists resumable compaction state independently of the transient background promise. */
  onCompactionCheckpoint?: (checkpoint: {
    compactionId: string
    status: 'started' | 'summary_ready' | 'merged' | 'cleared'
    prefixHash: string
    prefixMessageId?: string
    summary?: string
    workspace_projection?: FrozenWorkspaceProjection
    project_context_snapshot?: FrozenProjectContextSnapshot
    replacement_message?: ConversationMessage
    /** Present for `merged`: the exact in-memory context that must become durable. */
    messages?: ConversationMessage[]
  }) => void | Promise<void>
  /** Durable cancellation is sampled at complete model/tool boundaries. */
  isCancellationRequested?: () => boolean | Promise<boolean>
  /**
   * Called after each completed turn (and before abort returns) with messages pushed since the
   * last invocation. Enables incremental persistence so page refresh mid-loop can show progress.
   * The callback is awaited: a completed checkpoint must be durable before the next
   * external action starts.
   */
  onTurnComplete?: (newMessages: ConversationMessage[]) => void | Promise<void>
}

export class AgentLoopCompactionPauseRequiredError extends Error {
  readonly code = 'AGENT_LOOP_COMPACTION_PAUSE_REQUIRED'

  constructor(readonly jobId: string) {
    super(`Run must reload its context after durable compaction Job ${jobId}.`)
    this.name = 'AgentLoopCompactionPauseRequiredError'
  }
}

// ==================== Agent Loop ====================

export async function agentLoop(
  provider: AgentProvider,
  initialMessages: ConversationMessage[],
  options?: AgentLoopOptions
): Promise<AgentLoopResult> {
  // Persisted history is normally trusted JSON, but legacy rows and a process
  // crash during stream assembly can contain a runtime-invalid tool input.
  // Guard it before token estimation, hashing or provider.buildRequest. Legal
  // blocks retain their original object/key ordering; only rejected blocks are
  // replaced in this in-memory request view.
  const messages = guardHistoricalToolInputs(initialMessages)
  const toolCalls: ToolCallRecord[] = []
  const totalUsage: TokenUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  }
  let compacted = false
  let compactionSummary: string | undefined
  let turnCount = 0
  let promptCacheLastActivityAt = options?.promptCacheLastActivityAt
  let currentProjectContextSnapshot = options?.projectContextSnapshot
  let activeCompaction:
    | {
        compactionId: string
        prefixHash: string
        prefixMessageId?: string
        preparedJobId?: string
        summaryOffered?: boolean
    }
    | undefined
  const sourceTurnGate = new FairAsyncGate()
  type ActiveSourceTurnGuard = {
    jobId: string
    idempotencyKey: string
    sourceRunId: string
    guardToken: string
    expiresAt: Date
    gateLease: FairGateLease
    heartbeatTimer?: ReturnType<typeof setTimeout>
    heartbeatInFlight?: Promise<boolean>
    heartbeatFailure?: unknown
    releasing: boolean
  }
  let activeSourceTurnGuard: ActiveSourceTurnGuard | undefined
  // Set only when the model action checkpoint committed but the delayed Job
  // concurrently took ownership before its exact guard token could be
  // released. Text/control responses are already terminal and may return
  // normally. A real tool_use must first receive its durable tool_result, then
  // reload at that complete protocol boundary before another model request.
  let sourceTurnReloadRequired = false

  const telemetry = new HippocampusTelemetry(options?.hippocampusTelemetry)
  let latestReadySummary: string | undefined
  let pendingAsyncMergedSettlement: AgentLoopCompactionSettlement | undefined
  const contextWindow = options?.contextWindow ?? 200_000
  const mainMaxOutputTokens = options?.mainMaxOutputTokens ?? 32_768
  const mainInputAdmissionLimit = contextWindow - mainMaxOutputTokens
  const summaryMaxTokens = options?.summaryMaxTokens ?? 8_000
  const forkInstructionTokens = Math.ceil(FULL_COMPACT_PROMPT.length / 3.5)
  const fullOverheadTokens = options?.overheadTokens ?? 0
  const projectContextOverheadTokens = options?.projectContextOverheadTokens ?? 0
  const durableShadowEnabled = Boolean(
    options?.onBackgroundCompactionPrepare
      && options.onBackgroundCompactionActivate
      && options.onBackgroundCompactionOfferSummary
      && options.onBackgroundCompactionPause
      && options.onBackgroundCompactionAcquireSourceTurnGuard
      && options.onBackgroundCompactionHeartbeatSourceTurnGuard
      && options.onBackgroundCompactionReleaseSourceTurnGuard,
  )
  const currentProjectContextHash = (): string | undefined => {
    const snapshot = currentProjectContextSnapshot
    if (!snapshot) return undefined
    const reminder = buildProjectContextReminder({
      guide: {
        template_id: snapshot.template_id,
        version: snapshot.version,
        title: snapshot.guide_title,
        parameters: snapshot.parameters ?? {},
        content: snapshot.compiled_guide,
      },
      workspaceProjection: snapshot.workspace_projection.content,
    })
    return reminder
      ? createHash('sha256').update(reminder).digest('hex')
      : undefined
  }
  const requestOverheadTokens = (currentMessages: ConversationMessage[]) =>
    effectiveRequestOverheadTokens(
      currentMessages,
      fullOverheadTokens,
      projectContextOverheadTokens,
      currentProjectContextHash(),
    )
  const localRequestInputTokens = (currentMessages: ConversationMessage[]) =>
    estimateRequestInputTokens(
      currentMessages,
      fullOverheadTokens,
      projectContextOverheadTokens,
      currentProjectContextHash(),
    )
  const assertCompactionCandidate = (
    label: string,
    beforeTokens: number,
    candidate: ConversationMessage[],
  ): void => {
    const afterTokens = telemetry.estimateCurrentInput(localRequestInputTokens(candidate))
    if (!(afterTokens < beforeTokens)) {
      throw new Error(`${label} did not reduce request input: ${beforeTokens} -> ${afterTokens}`)
    }
    if (!(afterTokens < mainInputAdmissionLimit)) {
      throw new Error(
        `${label} did not restore main output headroom: ${afterTokens} >= ${mainInputAdmissionLimit}`,
      )
    }
  }
  const assertMainInputHeadroom = (label: string, candidate: ConversationMessage[]): void => {
    const afterTokens = telemetry.estimateCurrentInput(localRequestInputTokens(candidate))
    if (!(afterTokens < mainInputAdmissionLimit)) {
      throw new Error(
        `${label} did not preserve main output headroom: ${afterTokens} >= ${mainInputAdmissionLimit}`,
      )
    }
  }

  /**
   * A workspace projection is a prompt epoch, not a live file browser. Refresh
   * it only when a context summary is actually swapped in. The returned exact
   * replacement is persisted in the compaction checkpoint before it becomes
   * the durable compacted message list.
   */
  const materializeMergedContext = async (
    summary: string,
    previousReplacement?: ConversationMessage,
  ): Promise<{
    workspaceProjection: FrozenWorkspaceProjection
    projectContextSnapshot?: FrozenProjectContextSnapshot
    replacementMessage: ConversationMessage
  }> => {
    if (!options?.workspace) {
      throw new Error('Cannot materialize compacted context without a workspace.')
    }
    const workspaceProjection = await buildWorkspaceProjection(options.workspace)
    const projectContextSnapshot = currentProjectContextSnapshot
      ? {
          ...currentProjectContextSnapshot,
          epoch: currentProjectContextSnapshot.epoch + 1,
          parameters: currentProjectContextSnapshot.parameters
            ? { ...currentProjectContextSnapshot.parameters }
            : undefined,
          workspace_projection: workspaceProjection,
        }
      : undefined
    const replacementMessage = await buildAsyncCompactionMessage(summary, {
      workspaceProjection,
      projectContext: projectContextSnapshot,
      messageId: previousReplacement?.message_id ?? `msg_${randomUUID()}`,
      runId: options.runId,
    })
    currentProjectContextSnapshot = projectContextSnapshot
    provider.setProjectContext?.(projectContextSnapshot
      ? {
          guide: {
            template_id: projectContextSnapshot.template_id,
            version: projectContextSnapshot.version,
            title: projectContextSnapshot.guide_title,
            parameters: projectContextSnapshot.parameters ?? {},
            content: projectContextSnapshot.compiled_guide,
          },
          workspaceProjection: projectContextSnapshot.workspace_projection.content,
        }
      : undefined)
    return { workspaceProjection, projectContextSnapshot, replacementMessage }
  }

  const heartbeatSourceTurnGuard = async (
    guard: ActiveSourceTurnGuard,
  ): Promise<boolean> => {
    if (activeSourceTurnGuard !== guard || guard.releasing) return false
    if (guard.heartbeatFailure) return false
    if (guard.heartbeatInFlight) return guard.heartbeatInFlight
    const heartbeat = (async (): Promise<boolean> => {
      try {
        const renewed = await options!.onBackgroundCompactionHeartbeatSourceTurnGuard!({
          jobId: guard.jobId,
          idempotencyKey: guard.idempotencyKey,
          sourceRunId: guard.sourceRunId,
          guardToken: guard.guardToken,
        })
        if (
          !renewed
          || !(renewed.expiresAt instanceof Date)
          || !Number.isFinite(renewed.expiresAt.getTime())
          || renewed.expiresAt.getTime() <= Date.now()
        ) {
          guard.heartbeatFailure = new Error(
            `Source-turn guard ${guard.guardToken} is no longer live.`,
          )
          return false
        }
        guard.expiresAt = renewed.expiresAt
        return true
      } catch (error) {
        guard.heartbeatFailure = error
        return false
      }
    })()
    guard.heartbeatInFlight = heartbeat
    try {
      return await heartbeat
    } finally {
      if (guard.heartbeatInFlight === heartbeat) guard.heartbeatInFlight = undefined
    }
  }

  const scheduleSourceTurnHeartbeat = (guard: ActiveSourceTurnGuard): void => {
    if (activeSourceTurnGuard !== guard || guard.releasing || guard.heartbeatFailure) return
    const remainingMs = guard.expiresAt.getTime() - Date.now()
    const delayMs = Math.max(100, Math.min(5_000, Math.floor(remainingMs / 3)))
    guard.heartbeatTimer = setTimeout(() => {
      guard.heartbeatTimer = undefined
      void heartbeatSourceTurnGuard(guard).then(live => {
        if (live) scheduleSourceTurnHeartbeat(guard)
      })
    }, delayMs)
    ;(guard.heartbeatTimer as { unref?: () => void }).unref?.()
  }

  const releaseActiveSourceTurnGuard = async (): Promise<boolean> => {
    const guard = activeSourceTurnGuard
    if (!guard) return true
    guard.releasing = true
    if (guard.heartbeatTimer) clearTimeout(guard.heartbeatTimer)
    guard.heartbeatTimer = undefined
    // Do not wait behind an external heartbeat request during shutdown. Both
    // commands are exact-token CAS operations: release-before-heartbeat makes
    // the late heartbeat a no-op; heartbeat-before-release is then cleared.
    let released = false
    try {
      released = await options!.onBackgroundCompactionReleaseSourceTurnGuard!({
        jobId: guard.jobId,
        idempotencyKey: guard.idempotencyKey,
        sourceRunId: guard.sourceRunId,
        guardToken: guard.guardToken,
      })
      return released
    } finally {
      if (activeSourceTurnGuard === guard) activeSourceTurnGuard = undefined
      guard.gateLease.release()
    }
  }

  const acquireMainSourceTurnGuard = async (): Promise<'none' | 'acquired' | 'durable_owned'> => {
    const compaction = activeCompaction
    if (!compaction?.preparedJobId) return 'none'
    const gateLease = await sourceTurnGate.acquire()
    if (activeCompaction !== compaction || compaction.summaryOffered) {
      gateLease.release()
      return 'durable_owned'
    }
    const sourceRunId = options?.runId?.trim()
    if (!sourceRunId) {
      gateLease.release()
      throw new Error('A durable source-turn guard requires the active Run ID.')
    }
    let acquired: { guardToken: string; expiresAt: Date } | null | undefined
    try {
      acquired = await options!.onBackgroundCompactionAcquireSourceTurnGuard!({
        jobId: compaction.preparedJobId,
        idempotencyKey: compaction.compactionId,
        sourceRunId,
      })
    } catch (error) {
      gateLease.release()
      throw error
    }
    if (!acquired) {
      gateLease.release()
      return 'durable_owned'
    }
    if (
      !acquired.guardToken.trim()
      || !(acquired.expiresAt instanceof Date)
      || !Number.isFinite(acquired.expiresAt.getTime())
      || acquired.expiresAt.getTime() <= Date.now()
    ) {
      gateLease.release()
      throw new Error('Durable source-turn guard returned an invalid lease.')
    }
    const guard: ActiveSourceTurnGuard = {
      jobId: compaction.preparedJobId,
      idempotencyKey: compaction.compactionId,
      sourceRunId,
      guardToken: acquired.guardToken,
      expiresAt: acquired.expiresAt,
      gateLease,
      releasing: false,
    }
    activeSourceTurnGuard = guard
    scheduleSourceTurnHeartbeat(guard)
    return 'acquired'
  }

  const hippocampus = options?.workspace
    ? new HippocampusRuntime({
        contextWindow,
        staticOverheadTokens: fullOverheadTokens,
        mainMaxOutputTokens,
        summaryMaxTokens,
        forkInstructionTokens,
        timing: () => telemetry.profile(),
        initialSafetyState: options?.hippocampusSafetyState,
        estimateInputTokens: currentMessages => telemetry.estimateCurrentInput(
          localRequestInputTokens(currentMessages),
        ),
        compact: async (prefix, signal) => {
          const compaction = activeCompaction
          if (!compaction || compaction.prefixHash !== hashValue(prefix)) {
            throw new Error('background compaction started without its frozen durable intent')
          }
          const { compactionId, prefixHash, prefixMessageId } = compaction
          if (signal.aborted) throw new Error('compaction handed off before provider call')
          const compactionStartedAt = Date.now()
          const request = provider.buildCompactionRequest(
            prefix as ConversationMessage[],
            FULL_COMPACT_PROMPT,
            summaryMaxTokens,
          )
          const response = await provider.callLLMSilent(request, signal)
          if (signal.aborted) throw new Error('compaction aborted')

          const fullText = response.content
            .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
            .map(block => block.text)
            .join('\n')
          const summary = extractSummaryTag(fullText)
          if (!summary.trim()) throw new Error('empty compaction summary')

          const durationMs = Date.now() - compactionStartedAt
          telemetry.recordCompaction(durationMs, response.usage.output_tokens)
          await options?.onHippocampusTelemetry?.(telemetry.snapshot())
          accumulateUsage(totalUsage, response.usage)
          tokenTracker.record({
            source: 'compaction',
            model: options?.model || 'unknown',
            input_tokens: response.usage.input_tokens,
            output_tokens: response.usage.output_tokens,
            cache_creation_input_tokens: response.usage.cache_creation_input_tokens,
            cache_read_input_tokens: response.usage.cache_read_input_tokens,
          })

          if (options?.userId && options?.conversationId) {
            logAPICall({
              user_id: options.userId,
              conversation_id: options.conversationId,
              source: 'compaction',
              model: options.model || 'unknown',
              usage: response.usage,
              duration_ms: durationMs,
              status: 'success',
              turn_number: turnCount,
              request_body: request,
              response,
            }).catch(err => console.error('[api-log] compaction log failed:', (err as Error).message))
          }

          if (signal.aborted) throw new Error('compaction aborted before durable summary offer')
          if (compaction.preparedJobId) {
            const gateLease = await sourceTurnGate.acquire()
            try {
              if (signal.aborted) throw new Error('compaction aborted before serialized summary offer')
              if (activeCompaction !== compaction) {
                throw new Error('durable compaction intent changed before summary offer')
              }
              const accepted = await options!.onBackgroundCompactionOfferSummary!({
                jobId: compaction.preparedJobId,
                idempotencyKey: compaction.compactionId,
                prefixHash: compaction.prefixHash,
                summary,
                usage: response.usage,
              })
              if (!accepted) {
                throw new Error('durable compaction owner rejected the local summary offer')
              }
              compaction.summaryOffered = true
              return { handedOff: true, usage: response.usage }
            } finally {
              gateLease.release()
            }
          }

          latestReadySummary = summary
          await options?.onCompactionCheckpoint?.({
            compactionId,
            status: 'summary_ready',
            prefixHash,
            prefixMessageId,
            summary,
          })
          const outcome = {
            summary,
            // Provisional only. The live workspace projection is deliberately
            // captured later, at the atomic merge boundary.
            wrappedMessage: await buildAsyncCompactionMessage(summary, {
              workspaceProjection: currentProjectContextSnapshot?.workspace_projection,
              projectContext: currentProjectContextSnapshot,
              runId: options?.runId,
            }),
            usage: response.usage,
          }
          return outcome
        },
        events: {
          async onStart(info) {
            options?.onCompactionStart?.(info.snapshotTokens)
            const compactionId = `cmp_${randomUUID()}`
            const prefixMessages = structuredClone(info.prefixMessages)
            const prefixHash = hashValue(prefixMessages)
            const prefixMessageId = prefixMessages[prefixMessages.length - 1]?.message_id
            const compaction: NonNullable<typeof activeCompaction> = {
              compactionId,
              prefixHash,
              prefixMessageId,
            }
            activeCompaction = compaction
            // Background compaction deliberately does not occupy the Run's
            // single current_action slot. Its own delayed durable Job exists
            // before the silent provider request, so a hard process crash can
            // be recovered without pretending the parent Run is still alive.
            if (durableShadowEnabled) {
              const prepared = await options!.onBackgroundCompactionPrepare!({
                idempotencyKey: compactionId,
                sourceRunId: options?.runId,
                modelAliasSnapshot: options?.modelAlias,
                modelIdSnapshot: options?.model,
                prefixMessages,
                prefixTokens: info.snapshotTokens,
                prefixHash,
                prefixLength: info.spliceIndex,
                boundaryMessageId: prefixMessageId,
                projectContextSnapshot: currentProjectContextSnapshot
                  ? structuredClone(currentProjectContextSnapshot)
                  : undefined,
                initialAvailableAt: info.initialAvailableAt,
              })
              if (!prepared?.jobId) {
                throw new Error('durable shadow prepare returned no exact Job')
              }
              if (activeCompaction === compaction) {
                compaction.preparedJobId = prepared.jobId
              }
            }
            await options?.onCompactionCheckpoint?.({
              compactionId,
              status: 'started',
              prefixHash,
              prefixMessageId,
            })
          },
          onDone(info) {
            if (info.status === 'merged') {
              compacted = true
              compactionSummary = latestReadySummary
              pendingAsyncMergedSettlement = info
            } else {
              options?.onCompactionSettled?.(info)
            }
          },
          onBreaker(info) {
            console.warn(`[hippocampus] breaker ${info.kind}: ${info.detail}`)
          },
        },
      })
    : null

  // Incremental persistence: index up to which messages have been flushed via onTurnComplete.
  // Initialized to initialMessages.length — history + current user message are already persisted by the caller.
  let savedUpTo = messages.length
  let nextRunSequence = options?.runId
    ? messages.reduce((max, message) => (
        message.run_id === options.runId && typeof message.sequence === 'number'
          ? Math.max(max, message.sequence + 1)
          : max
      ), 0)
    : 0
  const flushIncremental = async (): Promise<string | undefined> => {
    if (messages.length <= savedUpTo) return messages[messages.length - 1]?.message_id
    if (options?.runId) {
      for (let index = savedUpTo; index < messages.length; index++) {
        const message = messages[index]
        message.message_id ??= `msg_${randomUUID()}`
        message.run_id ??= options.runId
        message.sequence ??= nextRunSequence++
      }
    }
    const slice = messages.slice(savedUpTo)
    if (options?.onTurnComplete) {
      await options.onTurnComplete(slice)
    }
    savedUpTo = messages.length
    return messages[messages.length - 1]?.message_id
  }

  const cancellationRequested = async (): Promise<boolean> =>
    abortSignal?.aborted || !!(await options?.isCancellationRequested?.())

  const abortSignal = options?.abortSignal
  const persistHippocampusSafety = async (): Promise<void> => {
    if (hippocampus) {
      await options?.onHippocampusSafetyState?.(hippocampus.safetySnapshot())
    }
  }
  let hippocampusFinalized = false
  const abortHippocampus = async (reason: string): Promise<void> => {
    const compaction = activeCompaction
    if (compaction?.preparedJobId) {
      throw new Error('cannot abort a prepared durable compaction for local takeover')
    }
    hippocampus?.abort(reason)
    await persistHippocampusSafety()
    if (activeCompaction) {
      await options?.onCompactionCheckpoint?.({
        compactionId: activeCompaction.compactionId,
        status: 'cleared',
        prefixHash: activeCompaction.prefixHash,
        prefixMessageId: activeCompaction.prefixMessageId,
        summary: latestReadySummary,
      })
      activeCompaction = undefined
      latestReadySummary = undefined
    }
  }
  const finalizeHippocampus = async (): Promise<void> => {
    if (hippocampusFinalized) return
    hippocampusFinalized = true
    if (!hippocampus) return
    const canHandoff = Boolean(
      activeCompaction
        && ((activeCompaction.preparedJobId
          && options?.onBackgroundCompactionActivate)
          || options?.onBackgroundCompactionHandoff),
    )
    const exit = await hippocampus.onLoopExit(
      messages,
      canHandoff
        ? async snapshot => {
            if (!activeCompaction) return false
            if (
              activeCompaction.preparedJobId
              && options?.onBackgroundCompactionActivate
            ) {
              return options.onBackgroundCompactionActivate({
                jobId: activeCompaction.preparedJobId,
                idempotencyKey: activeCompaction.compactionId,
              })
            }
            if (!options?.onBackgroundCompactionHandoff) return false
            const accepted = await options.onBackgroundCompactionHandoff({
              idempotencyKey: activeCompaction.compactionId,
              sourceRunId: options.runId,
              modelAliasSnapshot: options.modelAlias,
              modelIdSnapshot: options.model,
              prefixMessages: structuredClone(snapshot.prefixMessages),
              prefixTokens: snapshot.prefixTokens,
              prefixHash: activeCompaction.prefixHash,
              prefixLength: snapshot.prefixLength,
              boundaryMessageId: activeCompaction.prefixMessageId,
              projectContextSnapshot: currentProjectContextSnapshot
                ? structuredClone(currentProjectContextSnapshot)
                : undefined,
            })
            return Boolean(accepted?.jobId)
          }
        : undefined,
    )
    await persistHippocampusSafety()
    if (!activeCompaction) return
    if (
      exit.status !== 'merged'
      && exit.status !== 'handed_off'
      && activeCompaction.preparedJobId
      && options?.onBackgroundCompactionActivate
    ) {
      const activated = await options.onBackgroundCompactionActivate({
        jobId: activeCompaction.preparedJobId,
        idempotencyKey: activeCompaction.compactionId,
      })
      if (!activated) {
        throw new Error('prepared durable compaction could not be activated on loop exit')
      }
      await options?.onCompactionCheckpoint?.({
        compactionId: activeCompaction.compactionId,
        status: 'cleared',
        prefixHash: activeCompaction.prefixHash,
        prefixMessageId: activeCompaction.prefixMessageId,
      })
      activeCompaction = undefined
      latestReadySummary = undefined
      return
    }
    if (exit.status === 'handed_off') {
      // The durable job now owns the frozen prefix. Clear only the old Run's
      // transient action/checkpoint; do not emit compaction_done and do not
      // mutate the active message list.
      await options?.onCompactionCheckpoint?.({
        compactionId: activeCompaction.compactionId,
        status: 'cleared',
        prefixHash: activeCompaction.prefixHash,
        prefixMessageId: activeCompaction.prefixMessageId,
      })
      activeCompaction = undefined
      latestReadySummary = undefined
      return
    }
    const mergedContext = exit.merged && latestReadySummary
      ? await materializeMergedContext(latestReadySummary, messages[0])
      : undefined
    if (mergedContext) messages[0] = mergedContext.replacementMessage
    if (exit.merged) assertMainInputHeadroom('Loop-exit compaction merge', messages)
    await options?.onCompactionCheckpoint?.({
      compactionId: activeCompaction.compactionId,
      status: exit.merged ? 'merged' : 'cleared',
      prefixHash: activeCompaction.prefixHash,
      prefixMessageId: activeCompaction.prefixMessageId,
      summary: latestReadySummary,
      ...(mergedContext
        ? {
            workspace_projection: mergedContext.workspaceProjection,
            project_context_snapshot: mergedContext.projectContextSnapshot,
            replacement_message: mergedContext.replacementMessage,
            messages: [...messages],
          }
        : {}),
    })
    activeCompaction = undefined
    latestReadySummary = undefined
    if (exit.merged) {
      if (pendingAsyncMergedSettlement) {
        options?.onCompactionSettled?.(pendingAsyncMergedSettlement)
        pendingAsyncMergedSettlement = undefined
      }
      options?.onCompactionDone?.()
    }
  }
  const pauseForPreparedCompaction = async (): Promise<never> => {
    const compaction = activeCompaction
    if (!compaction?.preparedJobId || !options?.onBackgroundCompactionPause) {
      throw new Error('durable compaction pause requested without an exact prepared Job')
    }
    const jobId = compaction.preparedJobId
    const idempotencyKey = compaction.compactionId
    await finalizeHippocampus()
    await options.onBackgroundCompactionPause({ jobId, idempotencyKey })
    // A production pause hook durably defers the Run and throws its normal
    // non-error control signal. Returning would risk using stale in-memory
    // messages if the worker merged between checks, so fail closed.
    throw new AgentLoopCompactionPauseRequiredError(jobId)
  }
  const ensureSourceTurnGuardBeforePersistence = async (): Promise<void> => {
    const guard = activeSourceTurnGuard
    if (!guard) return
    if (await heartbeatSourceTurnGuard(guard)) return
    await releaseActiveSourceTurnGuard().catch(() => false)
    await pauseForPreparedCompaction()
  }

  /**
   * Finish the source-turn fence after both halves of the model checkpoint are
   * durable: the assistant/tool_use append and onActionComplete. From here a
   * lost token is evidence of concurrent durable ownership, not permission to
   * replay the completed model action. Conversation/member appends and the
   * worker merge share a context-revision CAS, so either ordering preserves
   * this newly committed message as the frozen prefix's tail.
   */
  const releaseSourceTurnGuardAfterModelCheckpoint = async (): Promise<void> => {
    if (!activeSourceTurnGuard) return
    let released = false
    try {
      released = await releaseActiveSourceTurnGuard()
    } catch (error) {
      // The checkpoint is already durable. Treat an indeterminate release like
      // takeover and let the idempotent Job/owner CAS converge; surfacing this
      // as a Run failure would replay an action that has already committed.
      console.warn(
        '[agent-loop] source-turn guard release failed after durable model checkpoint; '
          + 'continuing from the committed checkpoint:',
        error,
      )
    }
    if (!released) {
      sourceTurnReloadRequired = true
      console.warn(
        '[agent-loop] durable compaction took ownership after the model checkpoint; '
          + 'the completed model action will not be replayed.',
      )
    }
  }

  // Core loop: runs until AI stops calling tools (needsFollowUp = false).
  // Every exit path, including an unexpected provider/tool/persistence throw,
  // gets one chance to activate the durable shadow. The original exception
  // always has priority over cleanup failures.
  let primaryFailure: unknown
  try {
    while (true) {
      turnCount++

    // ==================== Abort check — top of loop ====================
    if (await cancellationRequested()) {
      console.log(`[agent-loop] Aborted before turn ${turnCount}`)
      // Mark the last assistant message so loadConversation can show an interruption marker
      for (let j = messages.length - 1; j >= 0; j--) {
        if (messages[j].role === 'assistant') { messages[j]._interrupted = true; break }
      }
      await flushIncremental()
      return { messages, text: '', toolCalls, usage: totalUsage, compacted, compactionSummary, turnsUsed: turnCount, aborted: true }
    }

    // ==================== ① Prompt-cache-safe payload folding ====================
    // Never rewrite a potentially cached prefix. Once the configured TTL has
    // definitely elapsed, fold only large reconstructible tool payloads while
    // preserving every tool_use/tool_result pair and operation receipt.
    if ((options?.promptCacheTtlMs ?? 0) > 0) {
      const folded = foldExpiredToolResults(messages, {
        contextWindow: options?.contextWindow ?? 200_000,
        cacheLastActivityAt: promptCacheLastActivityAt,
        cacheTtlMs: options!.promptCacheTtlMs!,
      })
      if (folded.foldedResults > 0) {
        messages.length = 0
        messages.push(...folded.messages)
        savedUpTo = messages.length
        compacted = true
        console.log(
          `[tool-result-folding] Folded ${folded.foldedResults} result(s), freed ~${folded.tokensFreed.toLocaleString()} tokens`,
        )
        options?.onToolResultsFolded?.({
          foldedResults: folded.foldedResults,
          tokensFreed: folded.tokensFreed,
        })
      }
    }

    // Hippocampus runs at complete-turn boundaries, before the main request is
    // constructed. It may start a background fork, atomically swap a ready
    // summary at B, or refuse admission when a discrete tool result jumped
    // beyond the fork-capacity line.
    if (hippocampus) {
      const decision = await hippocampus.beforeRequest(messages)
      await options?.onHippocampusSafetyState?.(hippocampus.safetySnapshot())
      if (decision.action === 'durable-handoff') {
        await pauseForPreparedCompaction()
      } else if (decision.action === 'merged') {
        const mergedContext = latestReadySummary
          ? await materializeMergedContext(latestReadySummary, messages[0])
          : undefined
        if (mergedContext) messages[0] = mergedContext.replacementMessage
        assertMainInputHeadroom('Asynchronous compaction merge', messages)
        savedUpTo = messages.length
        if (activeCompaction) {
          await options?.onCompactionCheckpoint?.({
            compactionId: activeCompaction.compactionId,
            status: 'merged',
            prefixHash: activeCompaction.prefixHash,
            prefixMessageId: activeCompaction.prefixMessageId,
            summary: latestReadySummary,
            workspace_projection: mergedContext?.workspaceProjection,
            project_context_snapshot: mergedContext?.projectContextSnapshot,
            replacement_message: mergedContext?.replacementMessage,
            messages: [...messages],
          })
          activeCompaction = undefined
          latestReadySummary = undefined
        }
        if (pendingAsyncMergedSettlement) {
          options?.onCompactionSettled?.(pendingAsyncMergedSettlement)
          pendingAsyncMergedSettlement = undefined
        }
        options?.onCompactionDone?.()
      } else if (decision.action === 'sync-fallback') {
        if (activeCompaction?.preparedJobId) {
          await pauseForPreparedCompaction()
        }
        await abortHippocampus('sync fallback')
        const beforeFallback = telemetry.estimateCurrentInput(
          localRequestInputTokens(messages),
        )
        options?.onCompactionStart?.(beforeFallback)
        const fallbackCompactionId = `cmp_${randomUUID()}`
        const fallbackActionId = `act_${randomUUID()}`
        const fallbackPrefixHash = hashValue(messages)
        const fallbackPrefixMessageId = messages[messages.length - 1]?.message_id
        const fallbackPrefixLength = messages.length
        const fallbackStartedAt = new Date()
        await options?.onActionStart?.({
          kind: 'compaction',
          actionId: fallbackActionId,
          prefixHash: fallbackPrefixHash,
          attempt: 1,
          startedAt: fallbackStartedAt,
        })
        await options?.onCompactionCheckpoint?.({
          compactionId: fallbackCompactionId,
          status: 'started',
          prefixHash: fallbackPrefixHash,
          prefixMessageId: fallbackPrefixMessageId,
        })
        const fallback = await reactiveCompact(
          provider,
          messages,
          options!.workspace!,
          beforeFallback,
          {
            contextWindow,
            staticOverheadTokens: requestOverheadTokens(messages),
            summaryMaxTokens,
            estimateInputTokens: candidate => telemetry.estimateCurrentInput(
              localRequestInputTokens(candidate),
            ),
            outputHeadroomTokens: mainMaxOutputTokens,
          },
        )
        if (fallback.usage) {
          telemetry.recordCompaction(
            Date.now() - fallbackStartedAt.getTime(),
            fallback.usage.output_tokens,
          )
          await options?.onHippocampusTelemetry?.(telemetry.snapshot())
        }
        await options?.onCompactionCheckpoint?.({
          compactionId: fallbackCompactionId,
          status: 'summary_ready',
          prefixHash: fallbackPrefixHash,
          prefixMessageId: fallbackPrefixMessageId,
          summary: fallback.summary,
        })
        const fallbackMergedContext = fallback.workspaceProjection
          ? await materializeMergedContext(fallback.summary, fallback.compactedMessages[0])
          : undefined
        const fallbackCandidate = fallbackMergedContext
          ? [fallbackMergedContext.replacementMessage]
          : fallback.compactedMessages
        assertCompactionCandidate('Synchronous compaction', beforeFallback, fallbackCandidate)
        messages.length = 0
        messages.push(...fallbackCandidate)
        savedUpTo = messages.length
        compacted = true
        compactionSummary = fallback.summary
        if (fallback.usage) {
          accumulateUsage(totalUsage, fallback.usage)
          tokenTracker.record({
            source: 'compaction',
            model: options?.model || 'unknown',
            input_tokens: fallback.usage.input_tokens,
            output_tokens: fallback.usage.output_tokens,
            cache_creation_input_tokens: fallback.usage.cache_creation_input_tokens,
            cache_read_input_tokens: fallback.usage.cache_read_input_tokens,
          })
        }
        await options?.onCompactionCheckpoint?.({
          compactionId: fallbackCompactionId,
          status: 'merged',
          prefixHash: fallbackPrefixHash,
          prefixMessageId: fallbackPrefixMessageId,
          summary: fallback.summary,
          workspace_projection: fallbackMergedContext?.workspaceProjection,
          project_context_snapshot: fallbackMergedContext?.projectContextSnapshot,
          replacement_message: fallbackMergedContext?.replacementMessage,
          messages: [...messages],
        })
        await options?.onActionComplete?.({
          actionId: fallbackActionId,
          checkpointMessageId: messages[0]?.message_id,
        })
        if (options?.onFailedCompactionRepaired) {
          const replacementMessageId = messages[0]?.message_id
          if (!replacementMessageId) {
            throw new Error('synchronous compaction committed without a replacement message ID')
          }
          await options.onFailedCompactionRepaired({
            replacementCompactionId: fallbackCompactionId,
            replacementMessageId,
            reason: 'sync_fallback',
          })
        }
        options?.onCompactionSettled?.({
          status: 'merged',
          durationMs: Date.now() - fallbackStartedAt.getTime(),
          userWaitMs: 0,
          compactedTokens: beforeFallback,
          removedMessages: fallbackPrefixLength,
        })
        options?.onCompactionDone?.()
      }
    }

    // ==================== ② LLM Call ====================
    const request = provider.buildRequest(messages)
    const requestLocalInputTokens = localRequestInputTokens(messages)
    const requestInputTokens = telemetry.estimateCurrentInput(requestLocalInputTokens)
    const remainingOutputCapacity = contextWindow - requestInputTokens
    if (remainingOutputCapacity <= 0) {
      throw new Error(
        `Context admission failed after compaction: ${requestInputTokens} input tokens >= ${contextWindow} window`,
      )
    }
    request.max_tokens = Math.max(
      1,
      Math.min(mainMaxOutputTokens, remainingOutputCapacity),
    )

    let response: LLMResponse
    let responseToolInputRejections = new Map<number, ToolInputRejection>()
    const modelActionId = `act_${randomUUID()}`
    await options?.onActionStart?.({
      kind: 'model_request',
      actionId: modelActionId,
      inputHash: hashValue(request),
      attempt: 1,
      startedAt: new Date(),
    })
    const sourceTurnGuardState = await acquireMainSourceTurnGuard()
    if (sourceTurnGuardState === 'durable_owned') {
      await pauseForPreparedCompaction()
    }
    const llmStartTime = Date.now()
    try {
      response = await provider.callLLM(request)
      await ensureSourceTurnGuardBeforePersistence()
      // This is the first trust boundary after the provider returns. Never let
      // a runtime-invalid tool input reach logging, assistant persistence,
      // action hashing or executeTool.
      const guardedResponse = guardToolUseInputs(response.content, provider.toolSchemas, {
        source: 'llm_response',
        turn: turnCount,
      })
      responseToolInputRejections = guardedResponse.rejections
      if (guardedResponse.content !== response.content) {
        response = { ...response, content: guardedResponse.content }
      }
    } catch (err) {
      const llmDuration = Date.now() - llmStartTime
      // The provider may fail, abort, or return a 413 while the source-turn
      // guard is live. Release it before any handoff/reactive decision; a
      // cleanup failure never replaces the provider's primary error.
      if (activeSourceTurnGuard) {
        await releaseActiveSourceTurnGuard().catch(releaseError => {
          console.error('[agent-loop] source-turn guard release failed after provider error:', releaseError)
          return false
        })
      }
      // Layer 4: Reactive compact — only handle a structured prompt-size
      // failure. Never infer HTTP 413 from arbitrary digits in an opaque
      // provider request id.
      const errMsg = (err as Error).message || ''
      if (isPromptTooLongLLMError(err)) {
        if (options?.workspace) {
          const hasCompactableHistory = messages.length > 1 && messages.some(message => (
            message.role === 'assistant'
            || message.content.some(block => block.type === 'tool_result')
          ))
          if (!hasCompactableHistory) {
            console.error('[agent-loop] Prompt-size failure has no compactable history; preserving the first user request.')
            throw err
          }
          console.log('[agent-loop] 413 error detected, triggering reactive compact...')
          if (activeCompaction?.preparedJobId) {
            await pauseForPreparedCompaction()
          }
          await abortHippocampus('reactive 413')
          // Log the failed API call
          if (options?.userId && options?.conversationId) {
            logAPICall({
              user_id: options.userId,
              conversation_id: options.conversationId,
              source: 'agent-loop',
              model: options.model || 'unknown',
              usage: { input_tokens: 0, output_tokens: 0 },
              duration_ms: llmDuration,
              status: 'error',
              error_message: errMsg,
              turn_number: turnCount,
              request_body: request,
              response: null,
            }).catch(logErr => console.error('[api-log] Failed to log 413 error:', (logErr as Error).message))
          }
          const currentTokens = telemetry.estimateCurrentInput(
            localRequestInputTokens(messages),
          )
          options.onCompactionStart?.(currentTokens)
          await options?.onActionComplete?.({
            actionId: modelActionId,
            checkpointMessageId: messages[messages.length - 1]?.message_id,
          })
          const reactiveCompactionId = `cmp_${randomUUID()}`
          const reactiveActionId = `act_${randomUUID()}`
          const reactivePrefixHash = hashValue(messages)
          const reactivePrefixMessageId = messages[messages.length - 1]?.message_id
          const reactivePrefixLength = messages.length
          const reactiveStartedAt = new Date()
          await options?.onActionStart?.({
            kind: 'compaction',
            actionId: reactiveActionId,
            prefixHash: reactivePrefixHash,
            attempt: 1,
            startedAt: reactiveStartedAt,
          })
          await options?.onCompactionCheckpoint?.({
            compactionId: reactiveCompactionId,
            status: 'started',
            prefixHash: reactivePrefixHash,
            prefixMessageId: reactivePrefixMessageId,
          })
          const rcResult = await reactiveCompact(
            provider,
            messages,
            options.workspace,
            currentTokens,
            {
              contextWindow,
              staticOverheadTokens: requestOverheadTokens(messages),
              summaryMaxTokens,
              estimateInputTokens: candidate => telemetry.estimateCurrentInput(
                localRequestInputTokens(candidate),
              ),
              outputHeadroomTokens: mainMaxOutputTokens,
            },
          )
          if (rcResult.usage) {
            telemetry.recordCompaction(
              Date.now() - reactiveStartedAt.getTime(),
              rcResult.usage.output_tokens,
            )
            await options?.onHippocampusTelemetry?.(telemetry.snapshot())
          }
          await options?.onCompactionCheckpoint?.({
            compactionId: reactiveCompactionId,
            status: 'summary_ready',
            prefixHash: reactivePrefixHash,
            prefixMessageId: reactivePrefixMessageId,
            summary: rcResult.summary,
          })
          const reactiveMergedContext = rcResult.workspaceProjection
            ? await materializeMergedContext(rcResult.summary, rcResult.compactedMessages[0])
            : undefined
          const reactiveCandidate = reactiveMergedContext
            ? [reactiveMergedContext.replacementMessage]
            : rcResult.compactedMessages
          assertCompactionCandidate('Reactive 413 compaction', currentTokens, reactiveCandidate)
          messages.length = 0
          messages.push(...reactiveCandidate)
          // After compaction, in-memory messages diverge from DB messages; subsequent incremental
          // saves must not append the compacted form. route.ts's replaceCompactedMessages handles persistence.
          savedUpTo = messages.length
          if (rcResult.usage) {
            accumulateUsage(totalUsage, rcResult.usage)
            tokenTracker.record({
              source: 'compaction',
              model: options?.model || 'unknown',
              input_tokens: rcResult.usage.input_tokens,
              output_tokens: rcResult.usage.output_tokens,
              cache_creation_input_tokens: rcResult.usage.cache_creation_input_tokens,
              cache_read_input_tokens: rcResult.usage.cache_read_input_tokens,
            })
            // Log compaction API call
            if (options?.userId && options?.conversationId) {
              logAPICall({
                user_id: options.userId,
                conversation_id: options.conversationId,
                source: 'compaction',
                model: options.model || 'unknown',
                usage: rcResult.usage,
                duration_ms: 0,
                status: 'success',
                turn_number: turnCount,
                request_body: null,
                response: { content: [{ type: 'text', text: rcResult.summary || '' }], stop_reason: 'end_turn', usage: rcResult.usage },
              }).catch(err => console.error('[api-log] compaction log failed:', (err as Error).message))
            }
          }
          compacted = true
          compactionSummary = rcResult.summary
          await options?.onCompactionCheckpoint?.({
            compactionId: reactiveCompactionId,
            status: 'merged',
            prefixHash: reactivePrefixHash,
            prefixMessageId: reactivePrefixMessageId,
            summary: rcResult.summary,
            workspace_projection: reactiveMergedContext?.workspaceProjection,
            project_context_snapshot: reactiveMergedContext?.projectContextSnapshot,
            replacement_message: reactiveMergedContext?.replacementMessage,
            messages: [...messages],
          })
          await options?.onActionComplete?.({
            actionId: reactiveActionId,
            checkpointMessageId: messages[0]?.message_id,
          })
          if (options?.onFailedCompactionRepaired) {
            const replacementMessageId = messages[0]?.message_id
            if (!replacementMessageId) {
              throw new Error('reactive compaction committed without a replacement message ID')
            }
            await options.onFailedCompactionRepaired({
              replacementCompactionId: reactiveCompactionId,
              replacementMessageId,
              reason: 'reactive_413',
            })
          }
          options?.onCompactionSettled?.({
            status: 'merged',
            durationMs: Date.now() - reactiveStartedAt.getTime(),
            userWaitMs: 0,
            compactedTokens: currentTokens,
            removedMessages: reactivePrefixLength,
          })
          options.onCompactionDone?.()
          continue // Retry with compacted messages
        }
      }
      // Log non-413 errors before re-throwing
      if (options?.userId && options?.conversationId) {
        logAPICall({
          user_id: options.userId,
          conversation_id: options.conversationId,
          source: 'agent-loop',
          model: options.model || 'unknown',
          usage: { input_tokens: 0, output_tokens: 0 },
          duration_ms: llmDuration,
          status: 'error',
          error_message: errMsg,
          turn_number: turnCount,
          request_body: request,
          response: null,
        }).catch(logErr => console.error('[api-log] Failed to log error:', (logErr as Error).message))
      }
      throw err // Re-throw non-413 errors
    }
    const llmDuration = Date.now() - llmStartTime

    // A successful cache-marked request may create or refresh the active
    // prefix cache. Keep this in memory immediately; the route persists the
    // final value once, avoiding one Mongo write per agent turn.
    const cacheActivityAt = new Date()
    promptCacheLastActivityAt = cacheActivityAt
    options?.onPromptCacheActivity?.(cacheActivityAt)

    // ==================== ③ Token tracking ====================
    accumulateUsage(totalUsage, response.usage)

    tokenTracker.record({
      source: 'agent-loop',
      model: options?.model || 'unknown',
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_creation_input_tokens: response.usage.cache_creation_input_tokens,
      cache_read_input_tokens: response.usage.cache_read_input_tokens,
    })

    // ==================== ②b API call logging (fire-and-forget) ====================
    if (options?.userId && options?.conversationId) {
      logAPICall({
        user_id: options.userId,
        conversation_id: options.conversationId,
        source: 'agent-loop',
        model: options.model || 'unknown',
        usage: response.usage,
        duration_ms: llmDuration,
        status: 'success',
        turn_number: turnCount,
        request_body: request,
        response,
      }).catch(err => console.error('[api-log] Failed to log API call:', (err as Error).message))
    }

    // Compute both local estimate and API-reported totals for this turn.
    // The just-finished request was admitted using a local estimate plus the
    // previous API correction. Its returned usage now becomes the exact anchor;
    // later in-flight requests add only their locally estimated delta.
    const lastInputTokens = estimateTokens(messages)
    const apiReportedTokens = getTotalInputTokens(response.usage)
    const correctedInputTokens = apiReportedTokens > 0
      ? apiReportedTokens
      : requestInputTokens
    telemetry.recordMain(
      correctedInputTokens,
      requestLocalInputTokens,
      response.usage.output_tokens,
      llmDuration,
    )
    await options?.onHippocampusTelemetry?.(telemetry.snapshot())
    console.log(`[agent-loop] Token usage: local_est=${lastInputTokens.toLocaleString()}, anchored_est=${requestInputTokens.toLocaleString()}, api_reported=${apiReportedTokens.toLocaleString()}, messages=${messages.length}, turn=${turnCount}`)
    options?.onTokenUsage?.(correctedInputTokens)

    // Warning callback
    if (options?.onTokenWarning && hippocampus) {
      const currentWithOverhead = telemetry.estimateCurrentInput(
        localRequestInputTokens(messages),
      )
      if (currentWithOverhead >= hippocampus.budget.observationGateTokens) {
        options.onTokenWarning(currentWithOverhead, hippocampus.budget.triggerTokens)
      }
    }

    // ==================== Abort check — after LLM call ====================
    const cancelledAfterLlm = await cancellationRequested()
    // Telemetry and cancellation checks may themselves await external state.
    // Re-fence immediately before either interrupted or normal assistant
    // content can be appended to the canonical owner history.
    await ensureSourceTurnGuardBeforePersistence()
    if (cancelledAfterLlm) {
      console.log(`[agent-loop] Aborted after LLM call in turn ${turnCount}`)
      // If the partial response has tool_use blocks, we need to add the assistant message
      // and backfill missing tool_results to keep message history valid
      if (response.content.length > 0) {
        messages.push({ role: 'assistant', content: response.content, timestamp: new Date(), _interrupted: true })
        const missingResults = buildMissingToolResults(response.content)
        if (missingResults.length > 0) {
          messages.push({ role: 'user', content: missingResults, timestamp: new Date() })
        }
      } else {
        // No new content — mark the last assistant message from previous turn
        for (let j = messages.length - 1; j >= 0; j--) {
          if (messages[j].role === 'assistant') { messages[j]._interrupted = true; break }
        }
      }
      const checkpointMessageId = await flushIncremental()
      await options?.onActionComplete?.({ actionId: modelActionId, checkpointMessageId })
      await releaseSourceTurnGuardAfterModelCheckpoint()
      return { messages, text: '', toolCalls, usage: totalUsage, compacted, compactionSummary, turnsUsed: turnCount, aborted: true }
    }

    // ==================== ④ Append assistant message ====================
    messages.push({
      role: 'assistant',
      content: response.content,
      timestamp: new Date(),
    })

    // ==================== ⑤ needsFollowUp — sole termination signal ====================
    // AI has tool_use blocks = needs follow-up. No tool_use = task complete.
    // This is the only way the loop ends normally (inspired by Claude Code's QueryEngine).
    const toolUses = extractToolUses(response, responseToolInputRejections)
    const needsFollowUp = toolUses.length > 0

    if (!needsFollowUp) {
      // AI produced no tool calls — it considers the task done
      // Persist the uncompressed final assistant response into the full audit
      // trail before onLoopExit may replace the active prefix with a summary.
      const checkpointMessageId = await flushIncremental()
      await options?.onActionComplete?.({ actionId: modelActionId, checkpointMessageId })
      await releaseSourceTurnGuardAfterModelCheckpoint()
      await finalizeHippocampus()
      return { messages, text: extractText(response), toolCalls, usage: totalUsage, compacted, compactionSummary, turnsUsed: turnCount }
    }

    // ==================== ⑥ AskUserQuestion special handling ====================
    // AskUserQuestion is NOT a real tool — it only fires an SSE event.
    // We strip it from the assistant message and skip its tool_result,
    // so the user's answer arrives as a plain text message, maintaining
    // clean assistant[text] → user[text] alternation.
    // A response containing any rejected input stays on the ordinary
    // tool_result repair path. In particular, a valid AskUserQuestion mixed
    // with an invalid tool must not strip that invalid call from the audit.
    const askUserTools = toolUses.filter(tu => tu.name === 'AskUserQuestion')
    const invalidAskUserBatch = askUserTools.length > 0 && toolUses.length !== 1
    const askUserTool = !invalidAskUserBatch && askUserTools.length === 1 && !askUserTools[0].inputRejection
      ? askUserTools[0]
      : undefined
    const regularTools = askUserTool
      ? []
      : toolUses
    let askInteraction: AskUserInteraction | null = null

    if (askUserTool) {
      // AskUserQuestion is a control signal rather than a persisted tool_use.
      // First make the assistant text checkpoint durable and finish the model
      // action; only then journal the short control action. This prevents crash
      // recovery from creating an orphan tool_result for a tool_use that was
      // intentionally stripped from history.
      const lastMsg = messages[messages.length - 1]
      if (lastMsg.role === 'assistant') {
        lastMsg.content = lastMsg.content.filter(
          block => block.type !== 'tool_use'
        )
      }
      const modelCheckpointMessageId = await flushIncremental()
      await options?.onActionComplete?.({
        actionId: modelActionId,
        checkpointMessageId: modelCheckpointMessageId,
      })
      await releaseSourceTurnGuardAfterModelCheckpoint()

      try {
        askInteraction = normalizeAskUserQuestionInput(askUserTool.input)
        await options?.onAskUser?.(askInteraction)
      } catch (error) {
        // A callback failure means the interaction boundary was not durably
        // exposed. Do not return waitingForUser with a phantom interaction;
        // persist the repair instruction and reload through the unified
        // post-takeover barrier instead.
        askInteraction = null
        messages.push({
          role: 'user',
          content: [{
            type: 'text',
            text: `<system-reminder>AskUserQuestion input was invalid: ${error instanceof Error ? error.message : String(error)}. Re-issue one valid form and do not mix it with other tools.</system-reminder>`,
          }],
          timestamp: new Date(),
        })
        await flushIncremental()
      }
    } else {
      const checkpointMessageId = await flushIncremental()
      await options?.onActionComplete?.({ actionId: modelActionId, checkpointMessageId })
      await releaseSourceTurnGuardAfterModelCheckpoint()
    }

    // ==================== ⑦ Execute regular tools ====================
    if (regularTools.length > 0) {
      const executedIds = new Set<string>()
      let controlBoundary: ToolResult['control'] | undefined
      const durableBoundaryTools = regularTools.filter(tool => (
        tool.name === 'WaitForAgents' || tool.name === 'SubmitAgentResult'
      ))
      const invalidControlBatch = durableBoundaryTools.length > 0 && regularTools.length !== 1
      const invalidBatchReason = invalidAskUserBatch
        ? 'AskUserQuestion is a user-interaction boundary and must be the only tool in a model response. No tools in this batch were executed; re-issue either the question or the intended tool calls in a separate response.'
        : invalidControlBatch
          ? 'WaitForAgents and SubmitAgentResult are durable control boundaries and must be called alone in a model response. No tools in this batch were executed; issue the intended calls again in a valid order.'
          : undefined
      for (const tu of regularTools) {
        // Abort check before each tool execution
        if (await cancellationRequested()) {
          console.log(`[agent-loop] Aborted during tool execution in turn ${turnCount}, backfilling remaining tool_results`)
          // Mark current turn's assistant message as interrupted
          for (let j = messages.length - 1; j >= 0; j--) {
            if (messages[j].role === 'assistant') { messages[j]._interrupted = true; break }
          }
          // Backfill error results for remaining unexecuted tools
          const interruptedResults: ContentBlock[] = []
          for (const remaining of regularTools) {
            if (!executedIds.has(remaining.id)) {
              interruptedResults.push({
                type: 'tool_result' as const,
                tool_use_id: remaining.id,
                content: 'Tool execution interrupted by user.',
                is_error: true,
              })
            }
          }
          messages.push({ role: 'user', content: interruptedResults, timestamp: new Date() })
          await flushIncremental()
          return { messages, text: '', toolCalls, usage: totalUsage, compacted, compactionSummary, turnsUsed: turnCount, aborted: true }
        }

        const toolActionId = `act_${randomUUID()}`
        const willExecute = !tu.inputRejection && !invalidBatchReason
        // A durable tool_call action is execution authority for selective
        // recovery. Synthetic schema/batch rejections must never create that
        // authority; if the process stops before their error result is stored,
        // orphan recovery closes the pair without replay.
        if (willExecute) {
          await options?.onActionStart?.({
            kind: 'tool_call',
            actionId: toolActionId,
            toolUseId: tu.id,
            toolName: tu.name,
            inputHash: hashValue(tu.input),
            attempt: 1,
            startedAt: new Date(),
          })
        }
        provider.onToolStart?.(tu.name, tu.input)
        const result: ToolResult = tu.inputRejection
          ? {
              content: rejectedToolInputResultMessage(tu.inputRejection),
              is_error: true,
            }
          : invalidBatchReason
            ? {
              content: invalidBatchReason,
              is_error: true,
            }
            : await provider.executeTool(tu.name, tu.input, {
                toolUseId: tu.id,
                actionId: toolActionId,
                turn: turnCount,
              })
        controlBoundary ??= result.control
        toolCalls.push({ tool: tu.name, input: tu.input, result })
        provider.onToolExecuted?.(tu.name, tu.input, result)
        // Build tool_result content. URL-backed media becomes persistable asset
        // blocks directly; no bytes pass through the loop or SSE.
        let toolResultContent: ToolResultContent = result.content
        if (result.media && result.media.length > 0) {
          const imageBlocks: ImageBlock[] = result.media.map(media => ({
            type: 'image',
            source: {
              type: 'asset',
              asset_id: media.assetId,
              media_type: media.mimeType,
              width: media.width,
              height: media.height,
              size_bytes: media.sizeBytes,
            },
          }))
          toolResultContent = [...imageBlocks, { type: 'text', text: result.content }]
        } else if (result.images && result.images.length > 0) {
          const validImages = result.images.filter(img =>
            img.base64 && img.base64.length > 0 && /^[A-Za-z0-9+/=\s]+$/.test(img.base64)
          )
          if (validImages.length > 0) {
            const processedImages = await Promise.all(
              validImages.map(async (img) => {
                const cleanBase64 = img.base64.replace(/\s/g, '')
                const processed = await processImageForContext(cleanBase64, detectMimeType(cleanBase64, img.mimeType))
                return processed
              })
            )
            const imageBlocks: ImageBlock[] = options?.persistImage
              ? await Promise.all(processedImages.map(img => options.persistImage!({
                  base64: img.base64,
                  mimeType: img.mimeType,
                  width: img.width,
                  height: img.height,
                })))
              : processedImages.map(img => ({
                  type: 'image' as const,
                  source: {
                    type: 'base64' as const,
                    media_type: img.mimeType,
                    data: img.base64,
                  },
                }))
            toolResultContent = [
              ...imageBlocks,
              { type: 'text' as const, text: result.content },
            ]
          }
        }

        const rawToolResult = {
          type: 'tool_result' as const,
          tool_use_id: tu.id,
          content: toolResultContent,
          is_error: result.is_error,
        }
        const admission = admitToolResult({
          messages,
          pendingResults: [],
          result: rawToolResult,
          toolName: tu.name,
          toolInput: tu.input,
          contextWindow,
          staticOverheadTokens: requestOverheadTokens(messages),
          inputTokenCorrection: telemetry.inputTokenCorrection(),
          mainMaxOutputTokens,
          maxNextInputTokens: hippocampus?.toolResultAdmissionLimitTokens,
          maxContextGrowthTokens: hippocampus?.budget.observationGateConstrained
            ? hippocampus.budget.maxContextGrowthTokensAtGate
            : undefined,
        })
        if (admission.guarded) {
          console.warn(
            `[tool-result-admission] guarded ${tu.name}; projected next input=${admission.projectedInputTokens.toLocaleString()}/${contextWindow.toLocaleString()}`,
          )
        }
        // Persist each tool result as its own checkpoint. Provider.buildRequest
        // merges consecutive user messages at the wire boundary, preserving the
        // existing model protocol while making completed side effects durable.
        admission.result.cache_control = { type: 'ephemeral' }
        messages.push({
          role: 'user',
          content: [admission.result],
          timestamp: new Date(),
        })
        const checkpointMessageId = await flushIncremental()
        if (willExecute) {
          await options?.onActionComplete?.({ actionId: toolActionId, checkpointMessageId })
        }
        executedIds.add(tu.id)
      }

      if (controlBoundary) {
        await flushIncremental()
        await finalizeHippocampus()
        return {
          messages,
          text: '',
          toolCalls,
          usage: totalUsage,
          waitingForAgents: controlBoundary === 'wait_agents',
          taskSubmitted: controlBoundary === 'task_submitted',
          compacted,
          compactionSummary,
          turnsUsed: turnCount,
        }
      }

    }

    // Unified next-request barrier after a post-checkpoint takeover. Ordinary
    // tools have now persisted every paired tool_result. A failed AskUser
    // normalization/callback has persisted its repair reminder. In either
    // case reload before another model request can observe the stale prefix.
    // Successful AskUser and durable control tools returned through their
    // terminal branches and therefore never reach this barrier.
    if (sourceTurnReloadRequired && !askInteraction) {
      await pauseForPreparedCompaction()
    }

    // ==================== ⑦b Consume mid-turn message queue ====================
    let queuedClaimToAcknowledge: { claimId: string; queueIds: string[] } | null = null
    if (options?.conversationId) {
      try {
        const claimedQueued = await dequeueMessages(
          options.conversationId,
          options.runId,
          { targetedOnly: options.midTurnQueueTargetedOnly },
        )
        const {
          fresh: queued,
          duplicate: duplicateQueued,
        } = partitionQueuedMessages(messages, claimedQueued)
        if (duplicateQueued.length > 0) {
          await acknowledgeDequeuedMessages(
            duplicateQueued.map(item => item.queueId),
            duplicateQueued[0].claimId,
          )
        }
        if (queued.length > 0) {
          // Persist supplements as their own user checkpoint. The provider
          // merges consecutive user messages before sending the request.
          for (const qm of queued) {
            const queuedContent: ContentBlock[] = []
            if (qm.images?.length) {
              for (const img of qm.images) {
                if ('assetId' in img) {
                  queuedContent.push({
                      type: 'image',
                      source: {
                        type: 'asset',
                        asset_id: img.assetId,
                        media_type: img.mimeType,
                        ...(img.storageDriver ? { storage_driver: img.storageDriver } : {}),
                        width: img.width,
                        height: img.height,
                      },
                  })
                } else {
                  queuedContent.push({
                      type: 'image',
                      source: { type: 'url', url: img.url },
                  })
                }
              }
            }
            queuedContent.push({
              type: 'text',
              text: qm.sourceKind === 'user'
                ? `<system-reminder>\nThe user sent a follow-up message while you were executing tools:\n\n${qm.content}\n\nTake this into account in your next response.\n</system-reminder>`
                : buildUntrustedDataReminder('team_updates', {
                    source: qm.sourceKind ?? 'agent',
                    content: qm.content,
                  }),
            })
            messages.push({
              role: 'user',
              content: queuedContent,
              timestamp: new Date(),
              message_id: qm.messageId,
              source_queue_id: qm.queueId,
              visibility: qm.visibility,
            })
          }
          const summary = queued.map(q => q.content).join('\n')
          queuedClaimToAcknowledge = {
            claimId: queued[0].claimId,
            queueIds: queued.map(item => item.queueId),
          }
          console.log(`[agent-loop] Consumed ${queued.length} mid-turn message(s): "${summary.slice(0, 80)}"`)
          options.onMidTurnMessage?.(summary)
        }
      } catch (err) {
        console.error('[agent-loop] Failed to dequeue mid-turn messages:', (err as Error).message)
      }
    }

    // ==================== ⑦c Incremental persistence ====================
    // Flush this turn's new messages (assistant + tool_results + any mid-turn injections)
    // so a page refresh mid-loop can render progress up to the last completed turn.
    await flushIncremental()
    if (queuedClaimToAcknowledge) {
      await acknowledgeDequeuedMessages(
        queuedClaimToAcknowledge.queueIds,
        queuedClaimToAcknowledge.claimId,
      )
    }

    // ==================== ⑧ AskUserQuestion pauses the loop ====================
    if (askInteraction) {
      await finalizeHippocampus()
      return { messages, text: '', toolCalls, usage: totalUsage, waitingForUser: true, compacted, compactionSummary, turnsUsed: turnCount }
    }

    // ==================== ⑨ maxTurns safety valve ====================
    if (options?.maxTurns && turnCount >= options.maxTurns) {
      console.log(`[agent-loop] maxTurns safety valve reached (${turnCount}/${options.maxTurns})`)
      await finalizeHippocampus()
      return { messages, text: '', toolCalls, usage: totalUsage, truncated: true, compacted, compactionSummary, turnsUsed: turnCount }
    }

      // continue → back to while(true) top
    }
  } catch (error) {
    primaryFailure = error
    throw error
  } finally {
    if (!hippocampusFinalized) {
      let cleanupFailure: unknown
      try {
        // Flush any final assistant/tool pair before its frozen background
        // prefix is handed to another process.
        await flushIncremental()
      } catch (error) {
        cleanupFailure = error
      }
      try {
        if (!await releaseActiveSourceTurnGuard()) {
          cleanupFailure ??= new Error('Source-turn guard was lost before loop finalization.')
        }
      } catch (error) {
        cleanupFailure ??= error
      }
      try {
        await finalizeHippocampus()
      } catch (error) {
        cleanupFailure ??= error
      }
      if (cleanupFailure) {
        if (primaryFailure) {
          console.error(
            '[agent-loop] background compaction finalization failed after primary error:',
            cleanupFailure,
          )
        } else {
          throw cleanupFailure
        }
      }
    }
  }
}

// ==================== Helpers ====================

function extractText(response: LLMResponse): string {
  return response.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map(b => b.text)
    .join('\n')
}

interface ExtractedToolUse {
  id: string
  name: string
  input: Record<string, unknown>
  inputRejection?: ToolInputRejection
}

interface GuardedToolUseContent {
  content: ContentBlock[]
  /** Content-block index -> rejection; indexes remain stable after guarding. */
  rejections: Map<number, ToolInputRejection>
}

interface ToolInputDiagnosticContext {
  source: 'llm_response' | 'history'
  turn?: number
  messageIndex?: number
}

function diagnosticLabel(value: unknown): string {
  if (typeof value !== 'string') return `<${typeof value}>`
  return value.length <= 160 ? value : `${value.slice(0, 157)}...`
}

function guardToolUseInputs(
  content: ContentBlock[],
  visibleSchemas: readonly ToolSchema[] | undefined,
  diagnostic?: ToolInputDiagnosticContext,
): GuardedToolUseContent {
  let guardedContent: ContentBlock[] | undefined
  const rejections = new Map<number, ToolInputRejection>()

  for (let index = 0; index < content.length; index += 1) {
    const block = content[index]
    if (block.type !== 'tool_use') continue
    const boundary = visibleSchemas
      ? enforceVisibleToolInputBoundary(
          block.name,
          (block as { input?: unknown }).input,
          visibleSchemas,
        )
      : enforceToolInputBoundary((block as { input?: unknown }).input)
    if (boundary.ok) continue

    rejections.set(index, boundary.rejection)
    // Metadata only: never serialize or interpolate the rejected input value.
    console.warn('[agent-loop] tool-input-boundary rejection', JSON.stringify({
      source: diagnostic?.source ?? 'unknown',
      turn: diagnostic?.turn,
      message_index: diagnostic?.messageIndex,
      block_index: index,
      tool_use_id: diagnosticLabel(block.id),
      tool_name: diagnosticLabel(block.name),
      code: boundary.rejection.code,
      path: diagnosticLabel(boundary.rejection.path),
    }))
    guardedContent ??= [...content]
    guardedContent[index] = {
      type: 'tool_use',
      id: block.id,
      name: block.name,
      input: boundary.persistedInput,
    }
  }

  return {
    content: guardedContent ?? content,
    rejections,
  }
}

function guardHistoricalToolInputs(
  initialMessages: ConversationMessage[],
): ConversationMessage[] {
  const messages = [...initialMessages]
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    // A rejection marker is already the durable, JSON-safe audit form of a
    // model-produced input that failed the execution boundary. Re-guarding it
    // would replace its original rejection (for example `invalid_schema`) with
    // a new `rejected_marker` rejection. Besides losing audit fidelity, that
    // silently changes the in-memory history after Mongo persistence, so a
    // later durable compaction cannot prove that its frozen prefix matches the
    // active context. Preserve completed rejection records byte-for-byte.
    if (message.content.some(block => (
      block.type === 'tool_use' && isRejectedToolInput(block.input)
    ))) {
      const guardedContent = message.content.map(block => {
        if (block.type !== 'tool_use' || isRejectedToolInput(block.input)) return block
        const guarded = guardToolUseInputs([block], undefined, {
          source: 'history',
          messageIndex: index,
        })
        return guarded.content[0] ?? block
      })
      if (guardedContent.some((block, blockIndex) => block !== message.content[blockIndex])) {
        messages[index] = { ...message, content: guardedContent }
      }
      continue
    }
    const guarded = guardToolUseInputs(message.content, undefined, {
      source: 'history',
      messageIndex: index,
    })
    if (guarded.content === message.content) continue
    messages[index] = { ...message, content: guarded.content }
  }
  return messages
}

function extractToolUses(
  response: LLMResponse,
  rejections: ReadonlyMap<number, ToolInputRejection> = new Map(),
): ExtractedToolUse[] {
  return response.content
    .flatMap((block, index): ExtractedToolUse[] => block.type === 'tool_use'
      ? [{
          id: block.id,
          name: block.name,
          input: block.input,
          inputRejection: rejections.get(index),
        }]
      : [])
}

/** Detect actual image MIME type from base64 magic bytes, falling back to the declared type */
function detectMimeType(base64: string, declared: string): string {
  const prefix = base64.replace(/\s/g, '').slice(0, 16)
  // JPEG: starts with /9j/ (FF D8 FF)
  if (prefix.startsWith('/9j/')) return 'image/jpeg'
  // PNG: starts with iVBOR (89 50 4E 47)
  if (prefix.startsWith('iVBOR')) return 'image/png'
  // GIF: starts with R0lG (47 49 46)
  if (prefix.startsWith('R0lG')) return 'image/gif'
  // WebP: starts with UklG (52 49 46 46)
  if (prefix.startsWith('UklG')) return 'image/webp'
  return declared
}

/** Build error tool_result blocks for any tool_use blocks that don't have matching results */
function buildMissingToolResults(assistantContent: ContentBlock[]): ContentBlock[] {
  const toolUseBlocks = assistantContent.filter(b => b.type === 'tool_use') as { type: 'tool_use'; id: string; name: string }[]
  if (toolUseBlocks.length === 0) return []
  return toolUseBlocks.map(tu => ({
    type: 'tool_result' as const,
    tool_use_id: tu.id,
    content: 'Tool execution interrupted by user.',
    is_error: true,
  }))
}

function hashValue(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex')
}

function accumulateUsage(total: TokenUsage, delta: TokenUsage) {
  total.input_tokens += delta.input_tokens || 0
  total.output_tokens += delta.output_tokens || 0
  total.cache_creation_input_tokens = (total.cache_creation_input_tokens || 0) + (delta.cache_creation_input_tokens || 0)
  total.cache_read_input_tokens = (total.cache_read_input_tokens || 0) + (delta.cache_read_input_tokens || 0)
}
