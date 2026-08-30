import { NextRequest } from 'next/server'
import { createHash, randomUUID } from 'crypto'
import { ConversationMessage, ModelProvider, ToolCallSummary, ImageAttachment, ContentBlock, ImageBlock } from '@/lib/types'
import {
  createAgentProvider,
  summarizeToolCall,
  estimateOverheadTokens,
  estimateProjectContextOverheadTokens,
} from '@/lib/agent/provider'
import { agentLoop } from '@/lib/agent/loop'
import {
  acknowledgeDequeuedMessages,
  dequeueMessages,
  partitionQueuedMessages,
  releaseQueuedMessagesForRun,
  repairTerminalRootTeamQueueReceipts,
} from '@/lib/agent/message-queue'
import { createWorkspaceInstance } from '@/lib/workspace/instance'
import type { FileEntry } from '@/lib/workspace/types'
import { spatialCreationWorkspace } from '@/lib/workspace/definitions/spatial-creation'
import { loadSkills } from '@/lib/skills/loader'
import { getToolSchemasForCapabilities } from '@/lib/tools/schemas'
import {
  createConversation,
  getConversation,
  initializeConversationProjectGuide,
  updateConversationFields,
  appendConversationMessages,
  updateTitle,
  replaceCompactedMessages,
  setCompactedMessages,
  DocumentTooLargeError,
} from '@/lib/db/repository'
import { ConversationDoc, type ProjectGuideRef } from '@/lib/types'
import { tokenTracker } from '@/lib/agent/token-tracker'
import { registerAbort, unregisterAbort, isConversationRunning } from '@/lib/agent/abort-registry'
import {
  attachSubscriber,
  bindBroadcastRun,
  broadcast as broadcastEvent,
  clearBroadcastBuffer,
  closeBroadcast,
  createBroadcast,
  discardBroadcast,
  getBroadcastRunId,
  hasActiveBroadcast,
} from '@/lib/agent/stream-registry'
import { resolveLocalOwner } from '@/lib/local-owner'
import { checkMessageRate, checkConcurrency, rateLimitResponse } from '@/lib/rate-limit/check'
import { getUserPlan, getUserModelOverrides } from '@/lib/demo-access-policy'
import { ModelAlias, canUseAlias, defaultMainAliasFor, resolveAlias, aliasSupportsVision, resolveMainAliasForUser, getAliasCapabilities } from '@/lib/llm-registry'
import { extractTargetPath } from '@/lib/agent/extract-target-path'
import { claimImageAsset, writeImageAsset } from '@/lib/media/storage'
import { MEDIA_ASSET_ID_PATTERN } from '@/lib/media/public-url'
import { toImageBlock } from '@/lib/media/reference'
import { memoryV2Flags } from '@/lib/memory-v2/flags'
import {
  appendRunEvidence,
  bindMemoryRunToAgentRun,
  createMemoryRun,
  getMemoryRun,
  getOrCreateProfile,
  selectFirstTurnHistory,
  setMemoryRunStatus,
} from '@/lib/memory-v2/repository'
import {
  assistantEvidence,
  boundedExcerpt,
  completionEvidence,
  toolEvidence,
  userEvidence,
} from '@/lib/memory-v2/evidence'
import {
  buildHistoryReminder,
  buildUntrustedDataReminder,
} from '@/lib/agent/system-reminder'
import type { MemoryRuntimeContext } from '@/lib/memory-v2/types'
import {
  AgentRunLeaseLostError,
  ActiveAgentRunError,
  acknowledgeRunPendingInputs,
  advanceRunCheckpoint,
  attachAgentRunTeamIdentity,
  bindMemoryRun,
  claimAgentRun,
  createAgentRun,
  findAgentRunWithInteractionAnswer,
  freezeAgentRunModelAlias,
  getAgentRun,
  getActiveAgentRun,
  getOrCreateConversationRuntime,
  heartbeatAgentRun,
  isRunCancellationRequested,
  newAgentRunId,
  resumeWaitingAgentRun,
  setRunCurrentAction,
  setRunPendingInteraction,
  setRunStatus,
  clearRunLive,
  updateRunLive,
  updateRuntimeCompactionCheckpoint,
  updateRuntimeSafetyState,
  updateRuntimeTelemetry,
  updateRuntimeProfileSnapshot,
  updateRuntimeProjectContextSnapshot,
  validateAgentRunLeaseFence,
} from '@/lib/agent-runtime/repository'
import {
  mergeActiveRunTakeoverTail,
  newMessageId,
  selectActiveRunTakeoverTail,
} from '@/lib/agent-runtime/messages'
import type { AgentRunDocument } from '@/lib/agent-runtime/models'
import { recoverCompactionCheckpoint } from '@/lib/agent-runtime/compaction-recovery'
import {
  buildOrphanedToolRecoveryMessage,
  buildSelectiveToolRecoveryMessage,
  findDurableToolResultMessage,
} from '@/lib/agent-runtime/tool-recovery'
import type { AgentExecutionContext } from '@/lib/agent/execution-context'
import type {
  FrozenProjectContextSnapshot,
  FrozenWorkspaceProjection,
} from '@/lib/agent-runtime/types'
import { classifyAgentRunFailure } from '@/lib/agent-runtime/failure-policy'
import {
  compileProjectGuide,
  validateProjectGuideRef,
} from '@/lib/agent/project-guide'
import {
  projectContextSnapshotMatchesGuide,
  type FrozenProjectContext,
} from '@/lib/agent/project-context'
import { buildWorkspaceProjection } from '@/lib/agent/compaction'
import {
  isAgentRunnerEnabled,
  isInternalAgentRunnerRequest,
  wakeAgentRunner,
} from '@/lib/agent-runtime/runner'
import {
  AGENT_RUNNER_LEASE_OWNER_HEADER,
  AGENT_RUNNER_RUN_ID_HEADER,
  AGENT_RUNNER_SIGNATURE_HEADER,
} from '@/lib/agent-runtime/internal-dispatch-envelope'
import {
  agentTeamService,
  executeAgentTeamTool,
  instrumentAgentProviderForBudget,
  reconcileAgentWaitBoundary,
  validateExecutionFence,
  type AgentTeamRecord,
  type DelegationGrantRecord,
  type TeamAgentRecord,
} from '@/lib/agent-team'
import {
  createMultiAgentWorkspaceBridge,
  MultiAgentWorkspaceRepository,
} from '@/lib/workspace/multi-agent'
import { handoffBackgroundCompaction } from '@/lib/agent-compaction/handoff'
import {
  acquireSourceTurnCompactionGuard,
  activateDurableCompactionJob,
  closeFailedCompactionAfterSynchronousRepair,
  CompactionJobNotUnclaimedQueuedError,
  heartbeatSourceTurnCompactionGuard,
  offerPreparedCompactionSummary,
  releaseSourceTurnCompactionGuard,
} from '@/lib/agent-compaction/repository'
import {
  deferExecutorForCompactionReload,
  enforceExecutorCompactionBarrier,
  ExecutorCompactionBarrierStoppedError,
  failClosedExecutorCompactionPrepare,
} from '@/lib/agent-runtime/compaction-barrier'

export const dynamic = 'force-dynamic'

const INLINE_OWNER_PREFIX = `inline:${process.pid}:${randomUUID()}`

function cloneProjectGuideRef(ref: Readonly<ProjectGuideRef>): ProjectGuideRef {
  return {
    template_id: ref.template_id,
    version: ref.version,
    ...(ref.parameters ? { parameters: { ...ref.parameters } } : {}),
  }
}

function createProjectContextSnapshot(
  ref: ProjectGuideRef,
  workspaceProjection: FrozenWorkspaceProjection,
  epoch: number,
): FrozenProjectContextSnapshot {
  const guide = compileProjectGuide(ref)
  return {
    epoch,
    template_id: guide.template_id,
    version: guide.version,
    ...(Object.keys(guide.parameters).length > 0
      ? { parameters: { ...guide.parameters } }
      : {}),
    guide_title: guide.title,
    compiled_guide: guide.content,
    guide_hash: createHash('sha256').update(guide.content).digest('hex'),
    workspace_projection: workspaceProjection,
  }
}

/** Rehydrate the exact compiled guide stored in Mongo; never recompile here. */
function toFrozenProjectContext(
  snapshot: FrozenProjectContextSnapshot,
): FrozenProjectContext {
  return {
    guide: {
      template_id: snapshot.template_id,
      version: snapshot.version,
      title: snapshot.guide_title,
      parameters: { ...(snapshot.parameters ?? {}) },
      content: snapshot.compiled_guide,
    },
    workspaceProjection: snapshot.workspace_projection.content,
  }
}

export async function POST(req: NextRequest) {
  let body
  try {
    body = await req.json()
  } catch (err) {
    console.error('[chat] Failed to parse request body:', (err as Error).message)
    return new Response(JSON.stringify({ error: 'Request body too large or malformed' }), { status: 413 })
  }
  const internalRunId = typeof body?.run_id === 'string' ? body.run_id : ''
  const internalLeaseOwnerId =
    typeof body?.lease_owner_id === 'string' ? body.lease_owner_id : ''
  const internalHeaderRunId = req.headers.get(AGENT_RUNNER_RUN_ID_HEADER) ?? ''
  const internalHeaderLeaseOwnerId =
    req.headers.get(AGENT_RUNNER_LEASE_OWNER_HEADER) ?? ''
  const internalEnvelopeMatchesBody =
    internalHeaderRunId === internalRunId
    && internalHeaderLeaseOwnerId === internalLeaseOwnerId
  const internalRequestAuthorized = isInternalAgentRunnerRequest(
    req.headers.get(AGENT_RUNNER_SIGNATURE_HEADER),
    internalRunId,
    internalLeaseOwnerId,
  ) && internalEnvelopeMatchesBody
  let internalRunnerRun: AgentRunDocument | null = null
  let userId: string
  if (internalRequestAuthorized) {
    if (!internalRunId || !internalLeaseOwnerId) {
      return Response.json({ error: 'Invalid Agent Runner dispatch envelope' }, { status: 400 })
    }
    internalRunnerRun = await getAgentRun(internalRunId)
    if (
      !internalRunnerRun
      || internalRunnerRun.status !== 'running'
      || internalRunnerRun.lease?.owner_id !== internalLeaseOwnerId
    ) {
      return Response.json({ error: 'Agent Runner dispatch no longer owns this Run' }, { status: 409 })
    }
    userId = internalRunnerRun.user_id
    const latestPendingInput = internalRunnerRun.pending_inputs?.at(-1)
    body = {
      conversation_id: internalRunnerRun.conversation_id,
      message: latestPendingInput?.message ?? internalRunnerRun.request.message,
      images: latestPendingInput?.images ?? internalRunnerRun.request.images,
      interaction_id: latestPendingInput?.interaction_id,
      settings: internalRunnerRun.request.settings,
    }
  } else {
    const authenticatedUserId = await resolveLocalOwner()
    if (authenticatedUserId instanceof Response) return authenticatedUserId
    userId = authenticatedUserId
  }

  const {
    conversation_id: rawConversationId,
    message,
    images,
    settings,
    interaction_id,
    project_guide,
  } = body as {
    // `null` was emitted by the first V1 browser build for a brand-new
    // project. Treat it as an omitted optional field so those tabs can recover
    // after a rolling deploy; all other explicit invalid values stay rejected.
    conversation_id?: string | null
    message: string
    images?: ImageAttachment[]
    settings?: { orchestrator_model?: ModelProvider; research_domain?: string; memory_enabled?: boolean }
    interaction_id?: string
    project_guide?: ProjectGuideRef
  }
  const conversation_id = rawConversationId ?? undefined
  if (typeof message !== 'string' || !message.trim()) {
    return new Response(
      JSON.stringify({ error: 'message is required', code: 'invalid_message' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    )
  }
  if (
    conversation_id !== undefined
    && (typeof conversation_id !== 'string' || !conversation_id.trim())
  ) {
    return Response.json({
      error: 'conversation_id 无效',
      code: 'invalid_conversation_id',
    }, { status: 400 })
  }

  // An explicit Conversation identity is never a create-if-missing hint. Do
  // this ownership-scoped lookup before creating a Run or opening an SSE
  // stream so missing and unauthorized IDs both receive the same HTTP 404.
  const requestedConversation = conversation_id
    ? await getConversation(conversation_id, userId)
    : null
  if (conversation_id && !requestedConversation) {
    return Response.json({
      error: 'Conversation not found',
      code: 'conversation_not_found',
    }, { status: 404 })
  }
  // Cross-conversation Memory V1 is frozen pending a full redesign. Keep the
  // legacy setting in the wire/schema for compatibility, but never allow an
  // old client or conversation document to reactivate it at runtime.
  const frozenSettings = { ...settings, memory_enabled: false }

  // Project Guide selection is an immutable Conversation-creation decision.
  // Runner dispatches never need to replay it because the Conversation is
  // already durable before a detached Run is queued.
  if (conversation_id && project_guide !== undefined) {
    return Response.json({
      error: 'project_guide 只能在创建新对话时设置',
      code: 'project_guide_immutable',
    }, { status: 400 })
  }
  let newConversationProjectGuide: ProjectGuideRef | undefined
  if (!conversation_id) {
    try {
      newConversationProjectGuide = cloneProjectGuideRef(
        validateProjectGuideRef(project_guide),
      )
    } catch (error) {
      return Response.json({
        error: (error as Error).message,
        code: 'invalid_project_guide',
      }, { status: 400 })
    }
  }

  // Per-message validation. Only Pegasus Spatial-issued asset IDs are accepted here;
  // arbitrary remote URLs would turn this endpoint into an SSRF/persistence path.
  const MAX_IMAGES_PER_MESSAGE = 5
  if (Array.isArray(images)) {
    if (images.length > MAX_IMAGES_PER_MESSAGE) {
      return new Response(
        JSON.stringify({ error: `一次最多上传 ${MAX_IMAGES_PER_MESSAGE} 张图片`, code: 'too_many_images' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      )
    }
    for (const img of images) {
      if (!img || !('assetId' in img) || !MEDIA_ASSET_ID_PATTERN.test(img.assetId)) {
        return new Response(
          JSON.stringify({ error: '图片资产引用无效，请重新上传', code: 'invalid_image_asset' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        )
      }
    }
  }

  // Reject new image submissions before a Run is created. Historical images
  // remain readable as text markers for text-only models, but a fresh payload
  // must never enter the durable queue for a model that cannot consume it.
  if (!internalRunnerRun && images?.length) {
    const [plan, overrides] = await Promise.all([
      getUserPlan(userId),
      getUserModelOverrides(userId),
    ])
    let requestedAlias = settings?.orchestrator_model as string | undefined
    if (!requestedAlias && conversation_id) {
      requestedAlias = requestedConversation?.settings?.orchestrator_model as string | undefined
    }
    const preflightAlias = overrides.forced_main_alias
      ? resolveMainAliasForUser(plan, overrides.forced_main_alias)
      : requestedAlias && canUseAlias(plan, requestedAlias)
        ? requestedAlias
        : defaultMainAliasFor(plan)
    if (!aliasSupportsVision(preflightAlias)) {
      return Response.json({
        error: '当前模型不支持图片理解。请移除图片，或切换到支持图片的模型。',
        code: 'model_does_not_support_vision',
      }, { status: 400 })
    }
  }

  console.log('[chat] POST received:', { conversation_id, message: message.slice(0, 50), settings })

  // A failed Root is recoverable when its owner explicitly continues the
  // project. Do this only on the authenticated public-input path, after the
  // ownership check and before the active-Run 409 guard. GET/Team SSE and
  // internal supervision requests must never resurrect Root implicitly.
  if (!internalRunnerRun && conversation_id) {
    // Repair a previous process death after a Root Run became terminal but
    // before its Team-update outbox receipts were untargeted. This is safe to
    // repeat and lets this public turn claim the retained backlog immediately,
    // without waiting for the periodic maintenance sweep.
    await repairTerminalRootTeamQueueReceipts({ conversationId: conversation_id })
    const recovery = await agentTeamService.recoverFailedRootForPublicInput({
      conversationId: conversation_id,
      userId,
    })
    if (recovery.supersededRunId) {
      await releaseQueuedMessagesForRun(recovery.supersededRunId)
    }
  }

  // Reject concurrent runs using Mongo state, not just this Node process.
  // waiting_user and recoverable runs are resumed by the next user request.
  let persistedActiveRun: AgentRunDocument | null = null
  if (internalRunnerRun) {
    persistedActiveRun = internalRunnerRun
  } else if (conversation_id) {
    if (interaction_id) {
      const alreadyAnsweredRun = await findAgentRunWithInteractionAnswer(
        conversation_id,
        userId,
        interaction_id,
      )
      if (alreadyAnsweredRun) {
        return Response.json({
          ok: true,
          duplicate: true,
          run_id: alreadyAnsweredRun.run_id,
        })
      }
    }
    persistedActiveRun = await getActiveAgentRun(conversation_id, userId)
    if (persistedActiveRun && ['queued', 'running'].includes(persistedActiveRun.status)) {
      return new Response(JSON.stringify({
        error: 'Conversation already has an active agent loop',
        code: 'already_running',
        run_id: persistedActiveRun.run_id,
      }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      })
    }
  }

  // Per-user concurrent loop cap. A waiting/recoverable Run is resumed in
  // place, so exclude that same Run instead of treating the user's answer as a
  // second concurrent loop.
  if (!internalRunnerRun) {
    const concurrency = await checkConcurrency(userId, {
      excludeRunId: persistedActiveRun?.run_id,
    })
    if (!concurrency.allowed) return rateLimitResponse(concurrency)
  }

  // Local registry remains a low-latency guard while Mongo is the authority.
  if (!internalRunnerRun && conversation_id && isConversationRunning(conversation_id)) {
    return new Response(JSON.stringify({ error: 'Conversation already has an active agent loop', code: 'already_running' }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // Record message quota only after the payload and active-Run guards accept
  // the request. Invalid payloads and duplicate/concurrent sends must not burn
  // the user's minute/day allowance.
  if (!internalRunnerRun) {
    const rate = await checkMessageRate(userId)
    if (!rate.allowed) return rateLimitResponse(rate)
  }

  // This request's own SSE response (first subscriber). The broadcast channel is created
  // below once we have a stable conversation_id, and events are pushed via broadcastEvent.
  const { readable, writable } = new TransformStream()
  const writer = writable.getWriter()

  // Placeholder until broadcast channel is created. Events queued here are flushed once we know convId.
  const pending: Record<string, unknown>[] = []
  let broadcastId: string | null = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const write = (event: Record<string, any>) => {
    if (broadcastId) {
      broadcastEvent(broadcastId, event)
    } else {
      pending.push(event)
    }
  }

  // Run the async work in the background — the response streams immediately
  ;(async () => {
    // A lease owner is an execution fence, not merely a process identity.
    // A fresh suffix prevents a delayed callback from an earlier inline
    // execution in the same Node process from matching a later takeover.
    const executionOwnerId =
      internalRunnerRun?.lease?.owner_id
      ?? `${INLINE_OWNER_PREFIX}:${randomUUID()}`
    let convId = ''
    let memoryRunId = ''
    let agentRunId = ''
    let userMessageId = ''
    let agentRun: AgentRunDocument | null = null
    let rootTeamContext: {
      team: AgentTeamRecord
      agent: TeamAgentRecord
      grant: DelegationGrantRecord
    } | null = null
    let leaseHeartbeat: ReturnType<typeof setInterval> | null = null
    let livePersistTimer: ReturnType<typeof setTimeout> | null = null
    let livePersistPromise: Promise<void> = Promise.resolve()
    let liveAssistantText = ''
    let liveModelActionId = ''
    let compactionStartedAt: Date | null = null
    let runLeaseValid = false
    try {
      // 1. Get or create conversation
      const conversation = conversation_id
        ? requestedConversation
        : await createConversation(userId, {
            settings: frozenSettings,
            projectGuide: newConversationProjectGuide,
          })
      if (!conversation) throw new Error('Conversation disappeared after request preflight')
      convId = conversation.conversation_id
      // Establish the stream as soon as the Conversation identity is known.
      // Setup failures (runtime index conflict, profile load, media migration)
      // must still reach the caller as SSE instead of leaving an unattached
      // TransformStream open forever.
      if (
        !internalRunnerRun
        || !hasActiveBroadcast(convId)
        || getBroadcastRunId(convId) !== internalRunnerRun.run_id
      ) {
        createBroadcast(convId)
      }
      // Bind the durable Run before profile/project/workspace initialization.
      // A browser reconnect can arrive during that setup window; without this
      // early identity it mistakes the Runner channel for an unrelated stream
      // and permanently falls back to text-only Mongo snapshots.
      if (internalRunnerRun) {
        bindBroadcastRun(convId, internalRunnerRun.run_id)
      }
      attachSubscriber(convId, writer)
      broadcastId = convId
      for (const ev of pending) broadcastEvent(convId, ev)
      pending.length = 0
      if (!conversation_id) {
        write({ type: 'conversation_started', conversation_id: convId })
      }

      const convDoc = conversation.toObject() as unknown as ConversationDoc
      // Legacy Conversations predate Project Guides. Lazily pin the default
      // reference once so every future Run resolves the same immutable
      // template identity instead of depending on registry defaults forever.
      const projectGuideRef = cloneProjectGuideRef(
        validateProjectGuideRef(convDoc.project_guide),
      )
      if (!convDoc.project_guide) {
        convDoc.project_guide = projectGuideRef
        await initializeConversationProjectGuide(convId, userId, projectGuideRef)
      }
      const runtime = await getOrCreateConversationRuntime(
        convId,
        userId,
        convDoc.hippocampus_telemetry ?? null,
      )
      // Every project lazily gains one durable Team + Root identity. Existing
      // Conversations are migrated on first use without rewriting history.
      const team = await agentTeamService.ensureTeam({
        conversationId: convId,
        userId,
        workspaceId: convId,
      })
      const [rootAgent, rootGrant] = await Promise.all([
        agentTeamService.getAgent({
          teamId: team.team_id,
          userId,
          agentId: team.root_agent_id,
        }),
        agentTeamService.getActiveGrant({
          teamId: team.team_id,
          userId,
          agentId: team.root_agent_id,
        }),
      ])
      rootTeamContext = { team, agent: rootAgent, grant: rootGrant }
      persistedActiveRun ??= await getActiveAgentRun(convId, userId)
      if (!persistedActiveRun && convDoc._waiting_for_user) {
        const legacyBoundary = [...((convDoc.messages ?? []) as ConversationMessage[])]
          .reverse()
          .find(item => item.role === 'user')
        const legacyRunId = newAgentRunId()
        try {
          persistedActiveRun = await createAgentRun({
            runId: legacyRunId,
            conversationId: convId,
            userId,
            request: {
              message: '',
              settings: {
                orchestrator_model: convDoc.settings?.orchestrator_model,
                research_domain: convDoc.settings?.research_domain,
                memory_enabled: false,
              },
            },
            startedMessageId:
              legacyBoundary?.message_id
              ?? `legacy_waiting_${convId}_${legacyBoundary?.timestamp?.toString() ?? 'unknown'}`,
            teamId: team.team_id,
            agentId: rootAgent.agent_id,
            agentSessionId: rootAgent.current_session_id,
            policyVersion: team.policy.version,
            rootVisible: true,
            executionMode: 'conversation',
          })
          await setRunStatus(legacyRunId, 'waiting_user')
          persistedActiveRun = await getActiveAgentRun(convId, userId)
        } catch (error) {
          if (error instanceof ActiveAgentRunError) {
            persistedActiveRun = await getActiveAgentRun(convId, userId)
          } else {
            throw error
          }
        }
      }

      // Reserve the one active Run before any expensive preparation or message
      // write. This closes the cross-instance race where two requests could
      // both append user messages before one of them lost the sparse unique
      // active_key insert.
      userMessageId =
        internalRunnerRun?.pending_inputs?.at(-1)?.message_id
        ?? internalRunnerRun?.started_message_id
        ?? newMessageId()
      if (internalRunnerRun) {
        agentRun = internalRunnerRun
        agentRunId = internalRunnerRun.run_id
      } else if (persistedActiveRun && ['waiting_user', 'waiting_agents', 'recoverable'].includes(persistedActiveRun.status)) {
        agentRun = await resumeWaitingAgentRun(
          persistedActiveRun.run_id,
          userId,
          {
            message_id: userMessageId,
            message,
            images,
            interaction_id,
            created_at: new Date(),
          },
        )
        if (!agentRun) {
          throw new Error('AgentRun could not be resumed because its state changed')
        }
        agentRunId = agentRun.run_id
      } else {
        agentRunId = newAgentRunId()
        try {
          agentRun = await createAgentRun({
            runId: agentRunId,
            conversationId: convId,
            userId,
            request: { message, images, settings: frozenSettings },
            startedMessageId: userMessageId,
            teamId: rootTeamContext.team.team_id,
            agentId: rootTeamContext.agent.agent_id,
            agentSessionId: rootTeamContext.agent.current_session_id,
            policyVersion: rootTeamContext.team.policy.version,
            rootVisible: true,
            executionMode: 'conversation',
          })
        } catch (error) {
          if (error instanceof ActiveAgentRunError) {
            throw new Error(`Conversation already has active run ${error.runId ?? ''}`.trim())
          }
          throw error
        }
      }

      if (!agentRun.team_id || !agentRun.agent_id || !agentRun.agent_session_id) {
        agentRun = await attachAgentRunTeamIdentity({
          runId: agentRun.run_id,
          userId,
          teamId: rootTeamContext.team.team_id,
          agentId: rootTeamContext.agent.agent_id,
          agentSessionId: rootTeamContext.agent.current_session_id,
          policyVersion: rootTeamContext.team.policy.version,
        })
        if (!agentRun) throw new Error('Agent Run disappeared while binding its Root identity')
      }

      if (isAgentRunnerEnabled() && !internalRunnerRun) {
        bindBroadcastRun(convId, agentRunId)
        write({ type: 'run_started', run_id: agentRunId, conversation_id: convId })
        if (!conversation_id) {
          const title = message.length > 30 ? `${message.slice(0, 30)}...` : message
          await updateTitle(convId, userId, title)
        }
        wakeAgentRunner()
        write({
          type: 'run_detached',
          run_id: agentRunId,
          conversation_id: convId,
          message: 'Agent Run 已进入持久队列，客户端将切换到可重连运行流。',
        })
        // Finish the submission transport before waking the executor. The
        // durable Run—not this short-lived channel—is the hand-off boundary.
        // The Runner creates a fresh execution broadcast; reconnects that race
        // ahead of it safely fall back to Mongo polling.
        // This channel contains only submission/run_detached events. Remove it
        // immediately so the reconnect endpoint waits for the Runner's rich
        // Root execution stream instead of replaying this completed hand-off.
        discardBroadcast(convId)
        return
      }

      const claimedRun = await claimAgentRun(agentRunId, executionOwnerId)
      if (!claimedRun) {
        throw new Error(`AgentRun ${agentRunId} could not acquire its execution lease`)
      }
      agentRun = claimedRun
      const activeAgentRun = claimedRun
      const isInternalAgentInput = !!activeAgentRun.request.internal
      tokenTracker.startRequest(userId, convId, {
        runId: agentRunId,
        teamId: claimedRun.team_id,
        agentId: claimedRun.agent_id,
        taskId: claimedRun.task_id,
      })
      runLeaseValid = true
      const continuingPersistedRun = !!persistedActiveRun && (
        ['waiting_user', 'waiting_agents', 'recoverable'].includes(persistedActiveRun.status)
        || !!persistedActiveRun.memory_run_id
        || (persistedActiveRun.pending_inputs?.length ?? 0) > 0
        || persistedActiveRun.checkpoint_seq > 0
        || persistedActiveRun.recovery_count > 0
      )
      const recoveringPersistedRun = !!persistedActiveRun && (
        persistedActiveRun.status === 'recoverable'
        || persistedActiveRun.recovery_count > 0
        || !!persistedActiveRun.current_action
        || !!runtime.hippocampus?.active_compaction
      )
      // The in-process controller is a latency optimization, but it must also
      // stop this executor immediately if Mongo says the lease no longer
      // belongs to it. Continuing after lease loss could duplicate model or
      // tool side effects on another instance.
      const abortController = new AbortController()
      leaseHeartbeat = setInterval(() => {
        heartbeatAgentRun(agentRunId, executionOwnerId)
          .then(controlState => {
            if (controlState === 'cancellation_requested') {
              if (!abortController.signal.aborted) {
                console.log(`[agent-run] persistent cancellation observed for ${agentRunId}`)
                abortController.abort('interrupt')
              }
              return
            }
            if (controlState === 'lost') {
              console.error(`[agent-run] lease lost for ${agentRunId}; aborting inline executor`)
              runLeaseValid = false
              abortController.abort('agent_run_lease_lost')
            }
          })
          .catch(error => {
            console.error('[agent-run] lease heartbeat failed; aborting inline executor:', (error as Error).message)
            runLeaseValid = false
            abortController.abort('agent_run_lease_heartbeat_failed')
          })
      }, 15_000)
      leaseHeartbeat.unref?.()

      // The process-local AbortController is only a latency optimization. The
      // persisted cancellation flag remains authoritative across instances.
      registerAbort(convId, abortController, userId)
      const requireRunLease = (): void => {
        if (!runLeaseValid) throw new AgentRunLeaseLostError(agentRunId)
      }
      const commitRuntimeWrite = async (
        writeAction: () => Promise<boolean>,
      ): Promise<void> => {
        requireRunLease()
        const stored = await writeAction()
        if (!stored) {
          runLeaseValid = false
          throw new AgentRunLeaseLostError(agentRunId)
        }
      }

      // Memory V2 state is independent from persisted message history. A run
      // continues across AskUserQuestion pauses; all other top-level requests
      // start a fresh evidence journal.
      let memoryEvidenceChain: Promise<void> = Promise.resolve()
      if (memoryV2Flags.extraction() && !isInternalAgentInput) {
        const existingRunId = persistedActiveRun?.memory_run_id ?? convDoc.memory_context?.active_run_id
        const existingRun = (
          continuingPersistedRun
          && existingRunId
        )
          ? await getMemoryRun(existingRunId, userId)
          : null
        const run = existingRun && ['recording', 'awaiting_user'].includes(existingRun.status)
          ? existingRun
          : await createMemoryRun(userId, convId, agentRunId)
        memoryRunId = run.run_id
        const memoryEvidence = []
        const rememberedUserExcerpts = new Set(
          run.evidence
            .filter(item => item.role === 'user')
            .map(item => item.excerpt),
        )
        const startedMessageAlreadyPersisted = [
          ...((convDoc.messages ?? []) as ConversationMessage[]),
          ...((convDoc.compacted_messages ?? []) as ConversationMessage[]),
        ].some(item => item.message_id === activeAgentRun.started_message_id)
        if (
          recoveringPersistedRun
          && activeAgentRun.checkpoint_seq === 0
          && !startedMessageAlreadyPersisted
          && !rememberedUserExcerpts.has(boundedExcerpt(activeAgentRun.request.message))
        ) {
          memoryEvidence.push(userEvidence(activeAgentRun.request.message, convDoc.messages?.length))
          rememberedUserExcerpts.add(boundedExcerpt(activeAgentRun.request.message))
        }
        const pendingEvidenceInputs = activeAgentRun.pending_inputs ?? []
        const evidenceInputs = pendingEvidenceInputs.length > 0
          ? pendingEvidenceInputs.map(input => input.message)
          : [message]
        for (const evidenceInput of evidenceInputs) {
          const excerpt = boundedExcerpt(evidenceInput)
          if (!rememberedUserExcerpts.has(excerpt)) {
            memoryEvidence.push(userEvidence(evidenceInput, convDoc.messages?.length))
            rememberedUserExcerpts.add(excerpt)
          }
        }
        await appendRunEvidence(memoryRunId, userId, memoryEvidence)
        convDoc.memory_context = {
          ...(convDoc.memory_context ?? {}),
          active_run_id: memoryRunId,
        }
        await updateConversationFields(convId, userId, { memory_context: convDoc.memory_context })
      }

      // 2. Update user input immediately. Also persist the per-turn settings
      // (orchestrator_model / research_domain) so refreshing or reopening
      // the project rehydrates the picker with the user's last choice — the
      // initial model written by createConversation() goes stale once the
      // user switches mid-conversation.
      await updateConversationFields(convId, userId, {
        ...(!isInternalAgentInput ? { user_input: message } : {}),
        ...(settings?.orchestrator_model
          ? { 'settings.orchestrator_model': settings.orchestrator_model }
          : {}),
        ...(settings?.research_domain
          ? { 'settings.research_domain': settings.research_domain }
          : {}),
        'settings.memory_enabled': false,
      })

      // 3. Create workspace instance backed by GridFS.
      //
      // Track a (path → gridfs_id) signature so we emit files_update SSE
      // whenever EITHER the set of paths OR a file's content changes. The
      // earlier optimization that only watched paths missed in-place
      // overwrites, leaving the client's GridFS content cache stuck on the
      // old version until a manual page refresh.
      //
      // In-place overwrites are rare and worth the extra SSE update.
      let lastFilesKeySignature = ''
      const outputFiles = (convDoc.output as Record<string, unknown> | undefined)?.files as Record<string, FileEntry> | undefined
      const outputManifest = (convDoc.output as Record<string, unknown> | undefined)?.manifest as Record<string, { current_version: number; versions: { v: number; path: string; note: string; created_at: string }[] }> | undefined
      const rootTeamForWorkspace = rootTeamContext
      if (!rootTeamForWorkspace) throw new Error('Root Team context is unavailable')
      const workspaceRepository = new MultiAgentWorkspaceRepository({
        fenceValidator: async ({ writer }) => {
          const runFenceValid = await validateAgentRunLeaseFence(
            writer.run_id,
            writer.execution_fence_token,
          )
          if (
            !runFenceValid
            || !internalRunnerRun?.team_id
            || !internalRunnerRun.agent_id
            || !internalRunnerRun.agent_session_id
          ) return runFenceValid
          return validateExecutionFence({
            teamId: rootTeamForWorkspace.team.team_id,
            userId,
            agentId: rootTeamForWorkspace.agent.agent_id,
            sessionId: rootTeamForWorkspace.agent.current_session_id,
            runId: writer.run_id,
            ownerId: writer.execution_fence_token,
          })
        },
      })
      const workspaceBridge = await createMultiAgentWorkspaceBridge({
        repository: workspaceRepository,
        workspaceId: rootTeamContext.team.workspace_id,
        actor: {
          teamId: rootTeamContext.team.team_id,
          agentId: rootTeamContext.agent.agent_id,
          rootAgentId: rootTeamContext.team.root_agent_id,
          role: 'root',
          managedReferenceTool: true,
        },
        writer: {
          team_id: rootTeamContext.team.team_id,
          agent_id: rootTeamContext.agent.agent_id,
          task_id: activeAgentRun.task_id,
          run_id: agentRunId,
          execution_fence_token: executionOwnerId,
        },
        legacyFiles: outputFiles,
      })
      const workspace = createWorkspaceInstance(spatialCreationWorkspace, workspaceBridge.projectedFiles, outputManifest, {
        conversationId: convId,
        ownerUserId: userId,
        onFileMutations: workspaceBridge.onFileMutations,
        onFileSetBegin: workspaceBridge.onFileSetBegin,
        onFileSetFinalize: workspaceBridge.onFileSetFinalize,
        onFileSetAbort: workspaceBridge.onFileSetAbort,
        onFilesUpdate: async (files, manifest) => {
          // WorkspaceFile heads are authoritative. Keep this callback only as
          // a live projection for SSE; rewriting Conversation.output.files
          // would reintroduce whole-map lost updates between Agents.
          const signature = Object.entries(files)
            .map(([path, entry]) => `${path}=${'asset_id' in entry ? entry.asset_id : entry.gridfs_id}`)
            .sort()
            .join('|')
          if (signature !== lastFilesKeySignature) {
            lastFilesKeySignature = signature
            write({ type: 'files_update', files, manifest })
          }
        },
      })

      // Project Context is a prompt epoch, not a live directory listing. It is
      // created once for a legacy/new Conversation and then reused verbatim
      // across top-level Runs. A successful compaction merge refreshes it and
      // persists the next epoch through the checkpoint callback below.
      let projectContextSnapshot = runtime.project_context_snapshot ?? null
      if (
        !projectContextSnapshot
        || (
          !continuingPersistedRun
          && !runtime.hippocampus?.active_compaction
          && !projectContextSnapshotMatchesGuide(projectGuideRef, projectContextSnapshot)
        )
      ) {
        const workspaceProjection = await buildWorkspaceProjection(workspace)
        projectContextSnapshot = createProjectContextSnapshot(
          projectGuideRef,
          workspaceProjection,
          (projectContextSnapshot?.epoch ?? 0) + 1,
        )
        await commitRuntimeWrite(() =>
          updateRuntimeProjectContextSnapshot(
            convId,
            userId,
            projectContextSnapshot,
            agentRunId,
            executionOwnerId,
          )
        )
      }
      let projectContext = toFrozenProjectContext(projectContextSnapshot)

      // 4. Load skills
      const skills = loadSkills({ projectGuideTemplateId: projectGuideRef.template_id })

      // 4b. Freeze the account profile and the first-turn history snapshot for
      // this top-level loop. Compaction forks reuse this exact context.
      const resumingExistingRun = continuingPersistedRun
      const frozenProfile = runtime.profile_snapshot
      const latestProfile = memoryV2Flags.profileInjection() && !(
        resumingExistingRun
        && frozenProfile
        && typeof frozenProfile.compiled_text === 'string'
      )
        ? await getOrCreateProfile(userId)
        : null
      const profileSnapshot = memoryV2Flags.profileInjection()
        ? (
            resumingExistingRun
            && frozenProfile
            && typeof frozenProfile.compiled_text === 'string'
          )
          ? frozenProfile
          : latestProfile
            ? {
                version: latestProfile.version,
                token_count: latestProfile.token_count,
                compiled_text: latestProfile.compiled_text,
              }
            : null
        : null
      if (!resumingExistingRun || !frozenProfile) {
        await commitRuntimeWrite(() =>
          updateRuntimeProfileSnapshot(
            convId,
            userId,
            profileSnapshot,
            agentRunId,
            executionOwnerId,
          )
        )
      }
      let historyReminder = ''
      if (memoryV2Flags.historyInjection() && (convDoc.compaction_count ?? 0) === 0) {
        const existingSnapshot = convDoc.memory_context?.first_turn_history
        if (existingSnapshot?.status === 'injected') {
          historyReminder = existingSnapshot.reminder
        } else if ((convDoc.messages?.length ?? 0) === 0) {
          const events = await selectFirstTurnHistory(userId, message, 4)
          historyReminder = buildHistoryReminder(events)
          convDoc.memory_context = {
            ...(convDoc.memory_context ?? {}),
            first_turn_history: {
              status: 'injected',
              reminder: historyReminder,
              event_ids: events.map(event => event.event_id),
              profile_version: profileSnapshot?.version ?? 0,
              injected_at: new Date(),
            },
          }
          await updateConversationFields(convId, userId, { memory_context: convDoc.memory_context })
        }
      }
      const memoryContext: MemoryRuntimeContext = {
        userId,
        profileText: profileSnapshot?.compiled_text ?? '',
        profileVersion: profileSnapshot?.version ?? 0,
        historyReminder,
      }

      // 5. Resolve main-loop alias → { realModel, apiKey }
      // Settings/conversation stores ALIAS (e.g. "main_pro") not raw model IDs.
      // Legacy conversations may still carry raw IDs; we fall back to plan default.
      //
      // Test-period override: if the user has `forced_main_alias` set, that
      // overrides any in-app selection AND any plan-level visibility check —
      // the alias is admin-pinned for blind A/B testing, so we respect it
      // unconditionally (resolveMainAliasForUser still validates it exists in
      // the registry, falling back to plan default with a warn if not).
      const plan = await getUserPlan(userId)
      const overrides = await getUserModelOverrides(userId)
      let alias: ModelAlias
      if (overrides.forced_main_alias) {
        alias = resolveMainAliasForUser(plan, overrides.forced_main_alias)
      } else {
        const requestedAlias = (settings?.orchestrator_model ?? convDoc.settings.orchestrator_model) as string | undefined
        if (requestedAlias && canUseAlias(plan, requestedAlias as ModelAlias)) {
          alias = requestedAlias as ModelAlias
        } else {
          alias = defaultMainAliasFor(plan)
          if (requestedAlias && requestedAlias !== alias) {
            console.log(`[chat] requested orchestrator "${requestedAlias}" not allowed for plan "${plan}", falling back to "${alias}"`)
          }
        }
      }
      alias = await freezeAgentRunModelAlias(
        agentRunId,
        userId,
        executionOwnerId,
        alias,
      ) as ModelAlias
      let modelProvider: string
      let orchestratorKey: string
      const modelCapabilities = getAliasCapabilities(alias)
      try {
        const resolved = resolveAlias(alias)
        modelProvider = resolved.model
        orchestratorKey = resolved.apiKey
      } catch (err) {
        throw new Error(`Orchestrator model config error: ${(err as Error).message}`)
      }
      console.log('[chat] Creating provider alias=', alias, 'model=', modelProvider, 'plan=', plan)

      const toolCallSummaries: ToolCallSummary[] = []
      const persistLiveText = () => {
        if (!agentRunId) return
        const snapshot = liveAssistantText
        livePersistPromise = livePersistPromise
          .then(async () => {
            const stored = await updateRunLive(agentRunId, snapshot, executionOwnerId)
            if (!stored) {
              runLeaseValid = false
              abortController.abort('agent_run_lease_lost')
            }
          })
          .catch(error => {
            console.error('[agent-run] Failed to persist live assistant text:', (error as Error).message)
          })
      }
      const scheduleLiveTextPersistence = () => {
        if (livePersistTimer) return
        livePersistTimer = setTimeout(() => {
          livePersistTimer = null
          persistLiveText()
        }, 400)
        livePersistTimer.unref?.()
      }

      const rootExecutionContext: AgentExecutionContext = {
        userId,
        conversationId: convId,
        runId: agentRunId,
        teamId: rootTeamContext?.team.team_id,
        agentId: rootTeamContext?.agent.agent_id,
        agentSessionId: rootTeamContext?.agent.current_session_id,
        taskId: activeAgentRun.task_id,
        isRoot: true,
        policyVersion: rootTeamContext?.team.policy.version,
        workspaceId: rootTeamContext?.team.workspace_id,
        executionFenceToken: executionOwnerId,
        teamFenceRequired: Boolean(
          internalRunnerRun?.team_id
          && internalRunnerRun.agent_id
          && internalRunnerRun.agent_session_id,
        ),
        agentAlias: rootTeamContext?.agent.display_name,
        agentRole: rootTeamContext?.agent.role,
        agentInstructions: rootTeamContext?.agent.instructions ?? undefined,
        canDelegateTasks: true,
      }
      const buildProvider = (frozenProjectContext: FrozenProjectContext) => instrumentAgentProviderForBudget(createAgentProvider(
        workspace,
        skills,
        {
          model: modelProvider,
          apiKey: orchestratorKey,
          maxTokens: modelCapabilities.maxOutputTokens,
          temperature: 1,
          conversationId: convId,
          abortSignal: abortController.signal,
          supportsVision: aliasSupportsVision(alias),
          executionContext: rootExecutionContext,
        },
        {
          onTextChunk(chunk) {
            liveAssistantText += chunk
            scheduleLiveTextPersistence()
            write({ type: 'text_delta', text: chunk })
          },
          onToolUseStart(toolName) {
            write({ type: 'tool_start', tool: toolName })
          },
          // Fired right before tool execution, with full input args resolved.
          // We use this to compute the target file path and emit tool_target
          // SSE so the frontend can flag the matching artifact tab as
          // "Pegasus Spatial is editing this file..." until the tool completes.
          onToolStart(tool, input) {
            const targetPath = extractTargetPath(tool, input)
            if (targetPath) {
              write({ type: 'tool_target', tool, target_path: targetPath })
            }
          },
          onToolExecuted(tool, input, result) {
            const summary = summarizeToolCall(tool, input, !!result.is_error)
            toolCallSummaries.push(summary)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const evt: any = {
              type: 'tool_done',
              tool: summary.tool,
              file_path: summary.file_path,
              action: summary.action,
              is_error: summary.is_error,
            }
            // For Write tool, include content for frontend artifact extraction
            if (tool === 'Write' && !result.is_error) {
              evt.content = input.content
            }
            // For Edit tool, include updated file content for workspace sync
            if (tool === 'Edit' && !result.is_error && result.updatedContent) {
              evt.content = result.updatedContent
            }
            write(evt)
            if (
              (tool === 'ReviewWorkspaceChanges' || tool === 'ReviewAgentResult')
              && !result.is_error
            ) {
              write({ type: 'workspace_refresh' })
            }
            if (memoryRunId) {
              memoryEvidenceChain = memoryEvidenceChain.then(() =>
                appendRunEvidence(memoryRunId, userId, toolEvidence([{ tool, input, result }]))
              )
            }
          },
          onThinkingDelta(chunk) {
            write({ type: 'thinking_delta', text: chunk })
          },
          onRedactedThinking() {
            write({ type: 'redacted_thinking' })
          },
        },
        memoryContext,
        frozenProjectContext,
      ), {
        context: {
          teamId: rootTeamContext!.team.team_id,
          conversationId: convId,
          userId,
          agentId: rootTeamContext!.agent.agent_id,
          taskId: activeAgentRun.task_id,
          runId: agentRunId,
          executionOwnerId,
          agentSessionId: rootTeamContext!.agent.current_session_id,
          teamFenceRequired: Boolean(
            internalRunnerRun?.team_id
            && internalRunnerRun.agent_id
            && internalRunnerRun.agent_session_id,
          ),
        },
        model: modelProvider,
      })

      // 6. Build messages — prefer compacted_messages if available (post-compaction)
      const compactedMsgs = (convDoc.compacted_messages ?? []) as ConversationMessage[]
      let hasActiveCompactedContext = compactedMsgs.length > 0
      let historyMessages = compactedMsgs.length > 0
        ? compactedMsgs
        : (convDoc.messages ?? []) as ConversationMessage[]
      if (
        recoveringPersistedRun
        && runtime.hippocampus?.active_compaction
      ) {
        const recoveredCompaction = await recoverCompactionCheckpoint(
          runtime.hippocampus.active_compaction,
          historyMessages,
          workspace,
          activeAgentRun.run_id,
          projectContextSnapshot,
        )
        if (recoveredCompaction.action === 'merged') {
          // Recovery may have upgraded a legacy summary-only checkpoint by
          // freezing the current projection and composing one exact
          // replacement message. Persist that checkpoint before swapping the
          // Conversation context so a crash in between remains idempotent.
          if (recoveredCompaction.checkpointUpgrade) {
            await commitRuntimeWrite(() =>
              updateRuntimeCompactionCheckpoint(
                convId,
                userId,
                recoveredCompaction.checkpointUpgrade!,
                agentRunId,
                executionOwnerId,
              )
            )
          }
          const recoveredProjectContext =
            recoveredCompaction.checkpointUpgrade?.project_context_snapshot
            ?? runtime.hippocampus.active_compaction.project_context_snapshot
          if (recoveredProjectContext) {
            projectContextSnapshot = recoveredProjectContext
            projectContext = toFrozenProjectContext(recoveredProjectContext)
            await commitRuntimeWrite(() =>
              updateRuntimeProjectContextSnapshot(
                convId,
                userId,
                recoveredProjectContext,
                agentRunId,
                executionOwnerId,
              )
            )
          }
          historyMessages = recoveredCompaction.messages
          hasActiveCompactedContext = true
          await replaceCompactedMessages(convId, userId, historyMessages)
          await commitRuntimeWrite(() =>
            updateRuntimeCompactionCheckpoint(
              convId,
              userId,
              null,
              agentRunId,
              executionOwnerId,
            )
          )
        } else if (
          recoveredCompaction.action === 'retry'
          || recoveredCompaction.action === 'invalid'
        ) {
          if (recoveredCompaction.reason) {
            console.warn('[agent-run] Discarding stale compaction checkpoint:', recoveredCompaction.reason)
          }
          await commitRuntimeWrite(() =>
            updateRuntimeCompactionCheckpoint(
              convId,
              userId,
              null,
              agentRunId,
              executionOwnerId,
            )
          )
        }
      }
      // Recovery can advance the Project Context epoch before the next model
      // request. Build the Provider only after that upgrade so both reminder
      // injection and admission accounting use the exact persisted snapshot.
      const provider = buildProvider(projectContext)
      let nextRunMessageSequence = historyMessages.reduce((max, historyMessage) => (
        historyMessage.run_id === agentRunId && typeof historyMessage.sequence === 'number'
          ? Math.max(max, historyMessage.sequence + 1)
          : max
      ), 0)

      // Only asset references enter conversation history. The provider adapter
      // resolves them to public URL image blocks at request time. Claim is
      // idempotent for the same Conversation, which also makes crash recovery
      // of an unpersisted starting request safe.
      const buildUserContent = async (
        text: string,
        attachments?: ImageAttachment[],
      ): Promise<ContentBlock[]> => {
        const content: ContentBlock[] = []
        for (const image of attachments ?? []) {
          if (!('assetId' in image)) continue
          const claimed = await claimImageAsset(image.assetId, userId, convId)
          if (!claimed) {
            throw new Error('图片资产不存在、已被占用或不属于当前用户，请重新上传')
          }
          content.push(toImageBlock(claimed))
        }
        content.push({ type: 'text', text })
        return content
      }

      // A process may stop after reserving an AgentRun but before the initial
      // user message is appended. AgentRun.request is the durable input
      // envelope for that narrow window. Reconstruct it exactly once before
      // accepting the user's resume message.
      const persistedMessages = [
        ...((convDoc.messages ?? []) as ConversationMessage[]),
        ...((convDoc.compacted_messages ?? []) as ConversationMessage[]),
      ]
      const restoreStartedMessage =
        activeAgentRun.checkpoint_seq === 0
        && !persistedMessages.some(item => item.message_id === activeAgentRun.started_message_id)
      const restoredStartedMessages: ConversationMessage[] = restoreStartedMessage
        ? [{
            role: 'user',
            content: await buildUserContent(
              activeAgentRun.request.message,
              activeAgentRun.request.images,
            ),
            timestamp: activeAgentRun.created_at,
            message_id: activeAgentRun.started_message_id,
            run_id: agentRunId,
            sequence: nextRunMessageSequence++,
            visibility: activeAgentRun.request.internal ? 'internal' : 'public',
          }]
        : []

      const pendingRunInputs = activeAgentRun.pending_inputs ?? []
      const pendingRunInputIds = new Set(
        pendingRunInputs.map(input => input.message_id),
      )
      const currentInputUsesRunEnvelope =
        pendingRunInputIds.has(userMessageId)
        || userMessageId === activeAgentRun.started_message_id

      const claimedInitialQueued = await dequeueMessages(convId, agentRunId)
      const {
        fresh: initialQueued,
        duplicate: duplicateInitialQueued,
      } = partitionQueuedMessages(persistedMessages, claimedInitialQueued)
      // Releases before this version wrote `messages` and the active
      // `compacted_messages` in two calls. On takeover, repair only the
      // current incomplete checkpoint tail; blindly unioning full history
      // would re-introduce a prefix that compaction intentionally replaced.
      const takeoverTail = recoveringPersistedRun && hasActiveCompactedContext
        ? selectActiveRunTakeoverTail({
            fullMessages: (convDoc.messages ?? []) as ConversationMessage[],
            compactedMessages: compactedMsgs,
            runId: agentRunId,
            checkpointMessageId: activeAgentRun.checkpoint_message_id,
            currentActionKind: activeAgentRun.current_action?.kind,
            currentToolUseId: activeAgentRun.current_action?.tool_use_id,
            requiredMessageIds: [
              ...(activeAgentRun.checkpoint_seq === 0
                ? [activeAgentRun.started_message_id]
                : []),
              ...pendingRunInputs.map(input => input.message_id),
              ...duplicateInitialQueued.map(item => item.messageId),
            ],
          })
        : []
      if (takeoverTail.length > 0) {
        historyMessages = mergeActiveRunTakeoverTail(historyMessages, takeoverTail)
        nextRunMessageSequence = historyMessages.reduce((max, historyMessage) => (
          historyMessage.run_id === agentRunId && typeof historyMessage.sequence === 'number'
            ? Math.max(max, historyMessage.sequence + 1)
            : max
        ), nextRunMessageSequence)
      }
      const recoveryMessages: ConversationMessage[] = []
      const interruptedAction = recoveringPersistedRun
        ? activeAgentRun.current_action
        : null
      const durableInterruptedResult = findDurableToolResultMessage(
        interruptedAction,
        persistedMessages,
      )
      const interruptedToolRecovery = await buildSelectiveToolRecoveryMessage({
        action: interruptedAction,
        messages: persistedMessages,
        runId: agentRunId,
        sequence: nextRunMessageSequence,
        visibleToolSchemas: getToolSchemasForCapabilities({
          supportsVision: aliasSupportsVision(alias),
          includeRecallHistory: memoryV2Flags.recallTool(),
          allowAskUser: true,
        }),
        replayAgentTeamTool: async replay => {
          requireRunLease()
          return executeAgentTeamTool(
            replay.name,
            replay.input,
            rootExecutionContext,
            {
              toolUseId: replay.toolUseId,
              actionId: replay.actionId,
              turn: 0,
            },
          )
        },
      })
      if (interruptedToolRecovery) {
        recoveryMessages.push(interruptedToolRecovery)
        nextRunMessageSequence += 1
      }
      const orphanedToolRecovery = recoveringPersistedRun
        ? buildOrphanedToolRecoveryMessage({
            messages: interruptedToolRecovery
              ? [...persistedMessages, interruptedToolRecovery]
              : persistedMessages,
            runId: agentRunId,
            sequence: nextRunMessageSequence,
          })
        : null
      if (orphanedToolRecovery) {
        recoveryMessages.push(orphanedToolRecovery)
        nextRunMessageSequence += 1
      }
      const initialQueuedMessages: ConversationMessage[] = initialQueued.map(queuedMessage => {
        const queuedContent: ContentBlock[] = []
        for (const image of queuedMessage.images ?? []) {
          if ('assetId' in image) {
            queuedContent.push({
              type: 'image',
              source: {
                type: 'asset',
                asset_id: image.assetId,
                media_type: image.mimeType,
                width: image.width,
                height: image.height,
                ...(image.storageDriver ? { storage_driver: image.storageDriver } : {}),
              },
            })
          }
        }
        queuedContent.push({
          type: 'text',
          text: queuedMessage.sourceKind === 'user'
            ? `<system-reminder>\nThe user sent this follow-up before the previous run could consume it:\n\n${queuedMessage.content}\n\nTreat it as user input that arrived before the current message.\n</system-reminder>`
            : buildUntrustedDataReminder('team_updates', {
                source: queuedMessage.sourceKind ?? 'agent',
                content: queuedMessage.content,
              }),
        })
        return {
          role: 'user',
          content: queuedContent,
          timestamp: new Date(),
          message_id: queuedMessage.messageId,
          run_id: agentRunId,
          sequence: nextRunMessageSequence++,
          source_queue_id: queuedMessage.queueId,
          visibility: queuedMessage.visibility,
        }
      })
      const persistedMessageIds = new Set(
        persistedMessages
          .map(persistedMessage => persistedMessage.message_id)
          .filter((messageId): messageId is string => Boolean(messageId)),
      )
      const pendingInputMessages: ConversationMessage[] = []
      for (const pendingInput of pendingRunInputs) {
        if (persistedMessageIds.has(pendingInput.message_id)) continue
        pendingInputMessages.push({
          role: 'user',
          content: await buildUserContent(
            pendingInput.source_kind && pendingInput.source_kind !== 'user'
              ? buildUntrustedDataReminder('team_updates', {
                  source: pendingInput.source_kind,
                  content: pendingInput.message,
                })
              : pendingInput.message,
            pendingInput.images,
          ),
          timestamp: pendingInput.created_at,
          message_id: pendingInput.message_id,
          run_id: agentRunId,
          sequence: nextRunMessageSequence++,
          visibility: pendingInput.visibility,
        })
      }
      const directUserMessage: ConversationMessage | null = currentInputUsesRunEnvelope
        ? null
        : {
            role: 'user',
            content: await buildUserContent(message, images),
            timestamp: new Date(),
            message_id: userMessageId,
            run_id: agentRunId,
            sequence: nextRunMessageSequence++,
          }

      const allMessages = [
        ...historyMessages,
        ...restoredStartedMessages,
        ...recoveryMessages,
        ...initialQueuedMessages,
        ...pendingInputMessages,
        ...(directUserMessage ? [directUserMessage] : []),
      ]

      // Save user message (without reminder) to DB immediately
      const initialRunMessages = [
        ...restoredStartedMessages,
        ...recoveryMessages,
        ...initialQueuedMessages,
        ...pendingInputMessages,
        ...(directUserMessage ? [directUserMessage] : []),
      ]
      await appendConversationMessages(
        convId,
        userId,
        [...takeoverTail, ...initialRunMessages],
        hasActiveCompactedContext,
      )
      if (duplicateInitialQueued.length > 0) {
        await acknowledgeDequeuedMessages(
          duplicateInitialQueued.map(item => item.queueId),
          duplicateInitialQueued[0].claimId,
        )
      }
      if (pendingRunInputs.length > 0) {
        const acknowledged = await acknowledgeRunPendingInputs(
          agentRunId,
          pendingRunInputs.map(input => input.message_id),
          executionOwnerId,
        )
        if (!acknowledged) {
          runLeaseValid = false
          throw new AgentRunLeaseLostError(agentRunId)
        }
      }
      if (initialQueued.length > 0) {
        await acknowledgeDequeuedMessages(
          initialQueued.map(item => item.queueId),
          initialQueued[0].claimId,
        )
        if (memoryRunId) {
          await appendRunEvidence(
            memoryRunId,
            userId,
            initialQueued.map(item => userEvidence(item.content)),
          )
        }
      }
      if (recoveryMessages.length > 0) {
        if (activeAgentRun.current_action?.action_id) {
          const advanced = await advanceRunCheckpoint(
            agentRunId,
            activeAgentRun.current_action.action_id,
            recoveryMessages[recoveryMessages.length - 1].message_id,
            executionOwnerId,
          )
          if (!advanced) {
            runLeaseValid = false
            throw new AgentRunLeaseLostError(agentRunId)
          }
        }
      } else if (recoveringPersistedRun && activeAgentRun.current_action) {
        // model_request is safe to retry from the last complete message. A
        // compaction action is reconstructed from its persistent checkpoint.
        // If the tool_result was already durable before the crash, advance the
        // checkpoint without appending or replaying it a second time.
        const completed = durableInterruptedResult
          ? await advanceRunCheckpoint(
              agentRunId,
              activeAgentRun.current_action.action_id,
              durableInterruptedResult.message_id,
              executionOwnerId,
            )
          : await setRunCurrentAction(agentRunId, null, executionOwnerId)
        if (!completed) {
          runLeaseValid = false
          throw new AgentRunLeaseLostError(agentRunId)
        }
      }
      if (memoryRunId) {
        await Promise.all([
          bindMemoryRun(agentRunId, memoryRunId),
          bindMemoryRunToAgentRun(memoryRunId, userId, agentRunId),
        ])
      }
      bindBroadcastRun(convId, agentRunId)
      write({ type: 'run_started', run_id: agentRunId, conversation_id: convId })

      // 6b. Estimate request-only overhead. Memory and skill reminders are
      // injected by the provider but intentionally absent from persisted
      // message history, so admission has to reserve them explicitly while
      // growth telemetry remains based on durable conversation messages.
      const skillMetadata = Array.from(skills.values()).map(skill => ({
        name: skill.name,
        description: skill.description,
      }))
      const overheadTokens = estimateOverheadTokens(
        getToolSchemasForCapabilities({
          supportsVision: aliasSupportsVision(alias),
          includeRecallHistory: memoryV2Flags.recallTool(),
        }),
        skillMetadata,
        memoryContext,
        projectContext,
        rootExecutionContext,
      )
      const projectContextOverheadTokens = estimateProjectContextOverheadTokens(projectContext)

      // 6c. Incremental persistence: save each turn's new messages to DB as soon as the turn completes,
      // so a page refresh mid-loop reloads completed turns instead of losing all in-flight work.
      // Saves are serialized through a promise chain to avoid racing $push operations.
      let incrementallySavedCount = allMessages.length
      let lastSave: Promise<void> = Promise.resolve()
      let compactionMergePersisted = false

      // 7. Run agent loop (saves all messages after completion)
      let promptCacheActivityAt: Date | undefined
      const compactionOwner = {
        kind: 'conversation' as const,
        conversationId: convId,
        userId,
      }
      // Set only after this live executor durably creates its own delayed
      // shadow. Recovery starts with this undefined and therefore observes
      // the Job as a real context barrier.
      let localShadowIntent: { jobId: string; before: Date } | undefined
      // Runner checks before/after Team-lease acquisition. This final executor
      // read closes the remaining HTTP-dispatch race before Hippocampus can
      // start either a main or silent provider request.
      const initialCompactionBarrier = await enforceExecutorCompactionBarrier(
        activeAgentRun,
        executionOwnerId,
      )
      let failedCompactionRepair = initialCompactionBarrier.kind === 'open'
        && initialCompactionBarrier.repairRequired
        && initialCompactionBarrier.terminalJobId
        && initialCompactionBarrier.terminalIdempotencyKey
        ? {
            jobId: initialCompactionBarrier.terminalJobId,
            idempotencyKey: initialCompactionBarrier.terminalIdempotencyKey,
          }
        : undefined
      const result = await agentLoop(provider, allMessages, {
        runId: agentRunId,
        maxTurns: 50,
        model: modelProvider,
        modelAlias: alias,
        abortSignal: abortController.signal,
        userId,
        conversationId: convId,
        async persistImage(image): Promise<ImageBlock> {
          const stored = await writeImageAsset({
            ownerUserId: userId,
            conversationId: convId,
            buffer: Buffer.from(image.base64, 'base64'),
            mimeType: image.mimeType,
            width: image.width ?? 0,
            height: image.height ?? 0,
            source: 'tool_output',
          })
          return toImageBlock(stored)
        },
        workspace,
        contextWindow: modelCapabilities.contextWindow,
        mainMaxOutputTokens: modelCapabilities.maxOutputTokens,
        summaryMaxTokens: modelCapabilities.compactionMaxOutputTokens,
        projectContextSnapshot,
        async onBackgroundCompactionPrepare(descriptor) {
          requireRunLease()
          localShadowIntent = undefined
          let prepared: { jobId: string } | undefined
          try {
            prepared = await handoffBackgroundCompaction({
              owner: compactionOwner,
              sourceRunId: agentRunId,
              modelAliasSnapshot: alias,
              descriptor,
              notBefore: descriptor.initialAvailableAt,
            })
          } catch (error) {
            await failClosedExecutorCompactionPrepare(
              activeAgentRun,
              executionOwnerId,
              error,
            )
          }
          if (!prepared) throw new Error('durable compaction prepare did not return a Job')
          localShadowIntent = {
            jobId: prepared.jobId,
            before: descriptor.initialAvailableAt,
          }
          // The shadow Job exists before the local summary request. Publish
          // that real durable state immediately so polling survives a hard
          // process exit before normal loop-finalization/activation.
          write({
            type: 'compaction_status',
            status: 'queued',
            job_id: prepared.jobId,
            run_id: agentRunId,
            conversation_id: convId,
          })
          return prepared
        },
        async onBackgroundCompactionActivate(input) {
          requireRunLease()
          const activated = await activateDurableCompactionJob({
            jobId: input.jobId,
            owner: compactionOwner,
            idempotencyKey: input.idempotencyKey,
          })
          const durableOwns = [
            'queued',
            'summarizing',
            'summary_ready',
            'merge_prepared',
            'retryable',
            'merged',
          ].includes(activated.job.status)
          localShadowIntent = undefined
          if (durableOwns) {
            write({
              type: 'compaction_status',
              status: activated.job.status,
              job_id: activated.job.job_id,
              run_id: agentRunId,
              conversation_id: convId,
            })
          }
          return durableOwns
        },
        async onBackgroundCompactionOfferSummary(input) {
          requireRunLease()
          const offered = await offerPreparedCompactionSummary({
            jobId: input.jobId,
            owner: compactionOwner,
            idempotencyKey: input.idempotencyKey,
            expectedPrefixHash: input.prefixHash,
            summary: input.summary,
            usage: input.usage,
          })
          localShadowIntent = undefined
          write({
            type: 'compaction_status',
            status: offered.job.status,
            job_id: offered.job.job_id,
            run_id: agentRunId,
            conversation_id: convId,
          })
          return offered.outcome === 'accepted' || offered.outcome === 'already_offered'
        },
        async onBackgroundCompactionPause(input) {
          requireRunLease()
          localShadowIntent = undefined
          await deferExecutorForCompactionReload(
            activeAgentRun,
            executionOwnerId,
            input.jobId,
          )
        },
        async onBackgroundCompactionAcquireSourceTurnGuard(input) {
          requireRunLease()
          let acquired: Awaited<ReturnType<typeof acquireSourceTurnCompactionGuard>>
          try {
            acquired = await acquireSourceTurnCompactionGuard({
              jobId: input.jobId,
              owner: compactionOwner,
              idempotencyKey: input.idempotencyKey,
              sourceRunId: input.sourceRunId,
              guardOwnerId: executionOwnerId,
            })
          } catch (error) {
            if (error instanceof CompactionJobNotUnclaimedQueuedError) return null
            throw error
          }
          return {
            guardToken: acquired.guardToken,
            expiresAt: acquired.expiresAt,
          }
        },
        async onBackgroundCompactionHeartbeatSourceTurnGuard(input) {
          requireRunLease()
          const expiresAt = await heartbeatSourceTurnCompactionGuard({
            jobId: input.jobId,
            owner: compactionOwner,
            idempotencyKey: input.idempotencyKey,
            sourceRunId: input.sourceRunId,
            guardOwnerId: executionOwnerId,
            guardToken: input.guardToken,
          })
          return expiresAt ? { expiresAt } : null
        },
        async onBackgroundCompactionReleaseSourceTurnGuard(input) {
          requireRunLease()
          return releaseSourceTurnCompactionGuard({
            jobId: input.jobId,
            owner: compactionOwner,
            idempotencyKey: input.idempotencyKey,
            sourceRunId: input.sourceRunId,
            guardOwnerId: executionOwnerId,
            guardToken: input.guardToken,
          })
        },
        async onFailedCompactionRepaired(input) {
          requireRunLease()
          if (!failedCompactionRepair) return
          const repaired = await closeFailedCompactionAfterSynchronousRepair({
            jobId: failedCompactionRepair.jobId,
            owner: compactionOwner,
            idempotencyKey: failedCompactionRepair.idempotencyKey,
            replacementMessageId: input.replacementMessageId,
          })
          failedCompactionRepair = undefined
          write({
            type: 'compaction_status',
            status: repaired.job.status,
            job_id: repaired.job.job_id,
            run_id: agentRunId,
            conversation_id: convId,
          })
        },
        async onBackgroundCompactionHandoff(descriptor) {
          requireRunLease()
          const handoff = await handoffBackgroundCompaction({
            owner: compactionOwner,
            sourceRunId: agentRunId,
            // `modelProvider` is the resolved provider ID. Durable recovery
            // must instead replay the exact registry alias frozen on AgentRun.
            modelAliasSnapshot: alias,
            descriptor,
          })
          // This reports a real durable transition, not completion. The Job
          // remains the source of truth and will emit merged/failed later.
          write({
            type: 'compaction_status',
            status: 'queued',
            job_id: handoff.jobId,
            run_id: agentRunId,
            conversation_id: convId,
          })
          return handoff
        },
        promptCacheLastActivityAt:
          convDoc.prompt_cache_last_activity_at ?? convDoc.updated_at,
        promptCacheTtlMs: modelCapabilities.promptCacheTtlMs,
        hippocampusTelemetry:
          runtime.hippocampus?.telemetry ?? convDoc.hippocampus_telemetry,
        hippocampusSafetyState:
          runtime.hippocampus?.breaker_state ?? null,
        overheadTokens,
        projectContextOverheadTokens,
        onCompactionStart(preTokens) {
          write({ type: 'compaction_start', input_tokens: preTokens })
        },
        onCompactionDone() {
          write({ type: 'compaction_done' })
        },
        onTokenUsage(totalInputTokens) {
          write({
            type: 'token_usage',
            total_input_tokens: totalInputTokens,
            overhead_tokens: overheadTokens,
            context_window: modelCapabilities.contextWindow,
            input_limit_tokens: Math.max(
              1,
              modelCapabilities.contextWindow - modelCapabilities.maxOutputTokens,
            ),
            max_output_tokens: modelCapabilities.maxOutputTokens,
          })
        },
        onPromptCacheActivity(at) {
          promptCacheActivityAt = at
        },
        onToolResultsFolded(info) {
          write({ type: 'tool_results_folded', ...info })
        },
        async onHippocampusTelemetry(state) {
          // The just-finished API response is now the exact anchor. Persist it
          // before the loop can construct another request.
          await commitRuntimeWrite(() =>
            updateRuntimeTelemetry(
              convId,
              userId,
              state,
              agentRunId,
              executionOwnerId,
            )
          )
        },
        async onHippocampusSafetyState(state) {
          await commitRuntimeWrite(() =>
            updateRuntimeSafetyState(
              convId,
              userId,
              state,
              agentRunId,
              executionOwnerId,
            )
          )
        },
        onMidTurnMessage(msg) {
          write({ type: 'mid_turn_received', message: msg })
        },
        async onAskUser(interaction) {
          const stored = await setRunPendingInteraction(agentRunId, {
            ...interaction,
            created_at: new Date(),
          }, executionOwnerId)
          if (!stored) {
            runLeaseValid = false
            throw new AgentRunLeaseLostError(agentRunId)
          }
          write({ type: 'ask_user', ...interaction })
        },
        async onActionStart(action) {
          if (action.kind === 'model_request') {
            // Defensive request-boundary recheck. The pre-loop check prevents
            // a background compaction call; this one also guards later turns.
            await enforceExecutorCompactionBarrier(activeAgentRun, executionOwnerId, {
              ignoreActiveJobId: localShadowIntent?.jobId,
              ignoreActiveJobBefore: localShadowIntent?.before,
            })
          }
          requireRunLease()
          if (action.kind === 'model_request') {
            liveModelActionId = action.actionId
            liveAssistantText = ''
            if (livePersistTimer) {
              clearTimeout(livePersistTimer)
              livePersistTimer = null
            }
            const cleared = await clearRunLive(agentRunId, executionOwnerId)
            if (!cleared) {
              runLeaseValid = false
              throw new AgentRunLeaseLostError(agentRunId)
            }
          }
          const actionStored = await setRunCurrentAction(agentRunId, {
            kind: action.kind,
            action_id: action.actionId,
            tool_use_id: action.toolUseId,
            tool_name: action.toolName,
            input_hash: action.inputHash,
            prefix_hash: action.prefixHash,
            attempt: action.attempt,
            started_at: action.startedAt,
          }, executionOwnerId)
          if (!actionStored) {
            runLeaseValid = false
            throw new AgentRunLeaseLostError(agentRunId)
          }
        },
        async onActionComplete(info) {
          requireRunLease()
          if (info.actionId === liveModelActionId) {
            if (livePersistTimer) {
              clearTimeout(livePersistTimer)
              livePersistTimer = null
            }
            await livePersistPromise
            const cleared = await clearRunLive(agentRunId, executionOwnerId)
            if (!cleared) {
              runLeaseValid = false
              throw new AgentRunLeaseLostError(agentRunId)
            }
            liveModelActionId = ''
            liveAssistantText = ''
          }
          const advanced = await advanceRunCheckpoint(
            agentRunId,
            info.actionId,
            info.checkpointMessageId,
            executionOwnerId,
          )
          if (!advanced) {
            runLeaseValid = false
            throw new AgentRunLeaseLostError(agentRunId)
          }
        },
        async onCompactionCheckpoint(checkpoint) {
          if (checkpoint.status === 'cleared') {
            await commitRuntimeWrite(() =>
              updateRuntimeCompactionCheckpoint(
                convId,
                userId,
                null,
                agentRunId,
                executionOwnerId,
              )
            )
            compactionStartedAt = null
            return
          }
          const now = new Date()
          const checkpointStatus = checkpoint.status
          const startedAt =
            checkpointStatus === 'started' || !compactionStartedAt
              ? now
              : compactionStartedAt
          compactionStartedAt = startedAt
          await commitRuntimeWrite(() =>
            updateRuntimeCompactionCheckpoint(convId, userId, {
              compaction_id: checkpoint.compactionId,
              status: checkpointStatus,
              prefix_hash: checkpoint.prefixHash,
              prefix_message_id: checkpoint.prefixMessageId,
              summary: checkpoint.summary,
              workspace_projection: checkpoint.workspace_projection,
              project_context_snapshot: checkpoint.project_context_snapshot,
              replacement_message: checkpoint.replacement_message,
              started_at: startedAt,
              updated_at: now,
            }, agentRunId, executionOwnerId)
          )
          if (checkpointStatus === 'merged') {
            if (!checkpoint.messages) {
              throw new Error('Merged compaction checkpoint is missing durable messages')
            }
            if (checkpoint.project_context_snapshot) {
              projectContextSnapshot = checkpoint.project_context_snapshot
              await commitRuntimeWrite(() =>
                updateRuntimeProjectContextSnapshot(
                  convId,
                  userId,
                  checkpoint.project_context_snapshot!,
                  agentRunId,
                  executionOwnerId,
                )
              )
            }
            // The Runtime checkpoint remains present until the exact swapped
            // context is durable. A crash in this window can therefore replay
            // the frozen summary instead of losing the in-memory merge.
            await replaceCompactedMessages(convId, userId, checkpoint.messages)
            hasActiveCompactedContext = true
            compactionMergePersisted = true
            await commitRuntimeWrite(() =>
              updateRuntimeCompactionCheckpoint(
                convId,
                userId,
                null,
                agentRunId,
                executionOwnerId,
              )
            )
            compactionStartedAt = null
          }
        },
        isCancellationRequested() {
          return isRunCancellationRequested(agentRunId)
        },
        async onTurnComplete(newMessages) {
          requireRunLease()
          if (newMessages.length === 0) return
          incrementallySavedCount += newMessages.length
          if (memoryRunId) {
            const evidence = assistantEvidence(newMessages)
            memoryEvidenceChain = memoryEvidenceChain.then(() =>
              appendRunEvidence(memoryRunId, userId, evidence)
            )
          }
          lastSave = (async () => {
            try {
              await appendConversationMessages(
                convId,
                userId,
                newMessages,
                hasActiveCompactedContext,
              )
              // Now that this checkpoint is durable, buffered SSE may be
              // discarded; reconnecting clients recover it from messages.
              clearBroadcastBuffer(convId)
            } catch (err) {
              if (err instanceof DocumentTooLargeError) {
                console.warn('[chat] DocumentTooLarge — aborting loop:', err.currentBytes, '+', err.addedBytes)
                write({ type: 'error', message: err.message })
                abortController.abort()
              }
              throw err
            }
          })()
          await lastSave
        },
      })
      console.log('[chat] Agent loop completed. Tool calls:', result.toolCalls.length)
      requireRunLease()

      if (promptCacheActivityAt) {
        await updateConversationFields(convId, userId, {
          prompt_cache_last_activity_at: promptCacheActivityAt,
        })
      }

      // 8. Save messages
      // Wait for any pending incremental saves to settle before the final save.
      await lastSave
      if (result.compacted) {
        // A merged checkpoint already incremented compaction_count and made
        // the swap durable. Only synchronize the later verbatim tail here.
        // Reactive tool-result folding without a merge still counts as the
        // first creation of a compacted context.
        if (compactionMergePersisted) {
          await setCompactedMessages(convId, userId, result.messages)
          console.log('[chat] Synchronized compacted messages after durable merge.')
        } else {
          await replaceCompactedMessages(convId, userId, result.messages)
          console.log('[chat] Saved compacted messages. Compaction count incremented.')
        }
      } else {
        // Append any messages not yet written by incremental saves (e.g. the final assistant
        // response from a normal end-of-loop return, or abort-backfilled messages).
        const remaining = result.messages.slice(incrementallySavedCount)
        if (remaining.length > 0) {
          await appendConversationMessages(
            convId,
            userId,
            remaining,
            hasActiveCompactedContext,
          )
        }
      }

      // AgentRun is the lifecycle authority. Legacy Conversation flags are no
      // longer written; the Conversation APIs derive their compatibility
      // fields from the latest Run and only fall back for pre-V2 records.
      let runReachedTerminalState = false
      if (result.waitingForUser) {
        const statusStored = await setRunStatus(
          agentRunId,
          'waiting_user',
          { leaseOwnerId: executionOwnerId },
        )
        if (!statusStored) throw new AgentRunLeaseLostError(agentRunId)
      } else if (result.waitingForAgents) {
        const statusStored = await setRunStatus(
          agentRunId,
          'waiting_agents',
          { leaseOwnerId: executionOwnerId },
        )
        if (!statusStored) throw new AgentRunLeaseLostError(agentRunId)
        if (activeAgentRun.team_id) {
          await reconcileAgentWaitBoundary({
            teamId: activeAgentRun.team_id,
            userId,
            runId: agentRunId,
          })
        }
      } else if (result.aborted) {
        const userCancelled =
          abortController.signal.reason === 'interrupt'
          || await isRunCancellationRequested(agentRunId)
        const statusStored = await setRunStatus(
          agentRunId,
          userCancelled ? 'cancelled' : 'recoverable',
          userCancelled
            ? {
                terminationReason: 'user_cancelled',
                releaseActive: true,
                leaseOwnerId: executionOwnerId,
              }
            : {
                error: 'Execution interrupted before a terminal model response.',
                leaseOwnerId: executionOwnerId,
              },
        )
        if (!statusStored) throw new AgentRunLeaseLostError(agentRunId)
        runReachedTerminalState = userCancelled
      } else if (result.truncated) {
        const runLimitError = new Error('Agent loop reached the configured safety limit.')
        const statusStored = await setRunStatus(agentRunId, 'failed', {
          terminationReason: 'max_turns',
          error: runLimitError.message,
          ...classifyAgentRunFailure(runLimitError, 'max_turns'),
          releaseActive: true,
          leaseOwnerId: executionOwnerId,
        })
        if (!statusStored) throw new AgentRunLeaseLostError(agentRunId)
        runReachedTerminalState = true
      } else {
        const statusStored = await setRunStatus(agentRunId, 'completed', {
          terminationReason: 'model_finished',
          releaseActive: true,
          leaseOwnerId: executionOwnerId,
        })
        if (!statusStored) throw new AgentRunLeaseLostError(agentRunId)
        runReachedTerminalState = true
      }
      if (runReachedTerminalState) {
        await releaseQueuedMessagesForRun(agentRunId)
      }

      // Queue memory extraction only after a clean, complete loop. Waiting
      // preserves the run for the user's answer; aborts and truncations are
      // explicitly discarded and never inferred from partial output.
      if (memoryRunId) {
        await memoryEvidenceChain
        if (result.aborted || result.truncated) {
          await setMemoryRunStatus(memoryRunId, userId, 'discarded')
        } else if (result.waitingForUser) {
          await setMemoryRunStatus(memoryRunId, userId, 'awaiting_user')
        } else {
          await appendRunEvidence(memoryRunId, userId, [completionEvidence('completed')])
          await setMemoryRunStatus(memoryRunId, userId, 'queued')
          await updateConversationFields(convId, userId, {
            'memory_context.active_run_id': null,
            ...(result.compacted ? { 'memory_context.first_turn_history.status': 'consumed' } : {}),
          })
        }
      }

      // 9. Auto-generate title
      if (!conversation_id) {
        const title = message.length > 30 ? message.slice(0, 30) + '...' : message
        await updateTitle(convId, userId, title)
      }

      // 10. Done event (or waiting_for_user if AskUserQuestion paused the loop)
      write({
        type: result.waitingForUser ? 'waiting_for_user' : 'done',
        conversation_id: convId,
        run_id: agentRunId,
        tool_calls: toolCallSummaries,
        usage: result.usage,
      })
      console.log('[chat] Done.')

      // 10b. Print token usage report
      tokenTracker.printReport()

      // Memory V1 background extraction/write-back is frozen. This is separate
      // from Hippocampus fork compaction, which remains active inside agentLoop.
    } catch (err) {
      const error = err as Error
      if (error instanceof ExecutorCompactionBarrierStoppedError) {
        // The barrier transition already changed the leased Run atomically.
        // Do not run ordinary failure recovery, release queued input, or alter
        // Memory state. Runner will release Team fences when this 2xx stream
        // closes and will re-lease the same Run after the Job terminalizes.
        runLeaseValid = false
        if (error.stop.kind === 'deferred') {
          write({
            type: 'run_deferred',
            reason: 'context_compaction',
            run_id: agentRunId,
            conversation_id: convId,
            compaction_job_id: error.stop.jobId,
            retry_at: error.stop.retryAt,
            message: '上下文压缩正在完成；当前运行已安全排队，将在合并后自动继续。',
          })
        } else if (error.stop.kind === 'failed') {
          write({
            type: 'error',
            code: 'context_compaction_failed',
            run_id: agentRunId,
            conversation_id: convId,
            compaction_job_id: error.stop.jobId,
            message: error.stop.error,
          })
        } else {
          write({
            type: 'run_detached',
            reason: 'context_compaction_lease_changed',
            run_id: agentRunId,
            conversation_id: convId,
            compaction_job_id: error.stop.jobId,
            message: '运行租约已在上下文压缩边界发生变化，将由持久执行器接管。',
          })
        }
        return
      }
      const leaseLost = error instanceof AgentRunLeaseLostError
      let userCancelled = error.message === 'interrupt'
      if (agentRunId && !leaseLost && !userCancelled) {
        try {
          userCancelled = await isRunCancellationRequested(agentRunId)
        } catch (cancellationError) {
          console.error(
            '[agent-run] Failed to read cancellation state after execution error:',
            (cancellationError as Error).message,
          )
        }
      }
      const processInterrupted =
        !userCancelled
        && typeof error.message === 'string'
        && /abort|terminated|shutdown/i.test(error.message)
      console.error(
        '[chat] ERROR:',
        error.stack ?? error.message,
        error.cause ? `| Cause: ${(error.cause as Error)?.message ?? error.cause}` : '',
      )
      // The Run request is the durable input envelope for the narrow failure
      // window before appendMessages. Preserve that user-visible turn even
      // when setup (model config, profile load, media migration, etc.) fails.
      if (agentRun && convId && !leaseLost) {
        try {
          const latestConversation = await getConversation(convId, userId)
          const persisted = [
            ...((latestConversation?.messages ?? []) as ConversationMessage[]),
            ...((latestConversation?.compacted_messages ?? []) as ConversationMessage[]),
          ]
          const knownMessageIds = new Set(persisted.map(item => item.message_id).filter(Boolean))
          let nextSequence = persisted.reduce((max, item) => (
            item.run_id === agentRun!.run_id && typeof item.sequence === 'number'
              ? Math.max(max, item.sequence + 1)
              : max
          ), 0)
          const buildRecoveryContent = async (
            text: string,
            attachments?: ImageAttachment[],
          ): Promise<ContentBlock[]> => {
            const content: ContentBlock[] = []
            for (const image of attachments ?? []) {
              if (!('assetId' in image)) continue
              const claimed = await claimImageAsset(image.assetId, userId, convId)
              if (claimed) content.push(toImageBlock(claimed))
            }
            content.push({ type: 'text', text })
            return content
          }
          const missingInputs: ConversationMessage[] = []
          if (!knownMessageIds.has(agentRun.started_message_id)) {
            missingInputs.push({
              role: 'user',
              content: await buildRecoveryContent(
                agentRun.request.message,
                agentRun.request.images,
              ),
              timestamp: agentRun.created_at,
              message_id: agentRun.started_message_id,
              run_id: agentRun.run_id,
              sequence: nextSequence++,
              visibility: agentRun.request.internal ? 'internal' : 'public',
            })
            knownMessageIds.add(agentRun.started_message_id)
          }
          // waiting_user/recoverable resumes persist every user answer in the
          // Run before execution begins. If setup crashes, replay those
          // envelopes with their stable IDs instead of losing the answer.
          for (const pendingInput of agentRun.pending_inputs ?? []) {
            if (knownMessageIds.has(pendingInput.message_id)) continue
            missingInputs.push({
              role: 'user',
              content: await buildRecoveryContent(
                pendingInput.message,
                pendingInput.images,
              ),
              timestamp: pendingInput.created_at,
              message_id: pendingInput.message_id,
              run_id: agentRun.run_id,
              sequence: nextSequence++,
              visibility: pendingInput.visibility,
            })
            knownMessageIds.add(pendingInput.message_id)
          }
          // A newly-created Run uses request as its durable envelope rather
          // than pending_inputs. Keep the local fallback for setup errors that
          // happen before the AgentRun document is reloaded.
          const currentInputIsPending = (agentRun.pending_inputs ?? [])
            .some(input => input.message_id === userMessageId)
          if (!currentInputIsPending && !knownMessageIds.has(userMessageId)) {
            missingInputs.push({
              role: 'user',
              content: await buildRecoveryContent(message, images),
              timestamp: new Date(),
              message_id: userMessageId,
              run_id: agentRun.run_id,
              sequence: nextSequence++,
            })
          }
          if (missingInputs.length > 0) {
            await appendConversationMessages(
              convId,
              userId,
              missingInputs,
              (latestConversation?.compacted_messages?.length ?? 0) > 0,
            )
          }
        } catch (inputError) {
          console.error(
            '[agent-run] Failed to persist starting user input after setup error:',
            (inputError as Error).message,
          )
        }
      }
      const failureTerminationReason = /model|provider|openrouter|anthropic/i.test(error.message)
        ? 'model_error' as const
        : 'runtime_error' as const
      const failureMetadata = classifyAgentRunFailure(error, failureTerminationReason)
      let runStatePersisted = !agentRunId
      if (agentRunId && !leaseLost) {
        try {
          runStatePersisted = await setRunStatus(
            agentRunId,
            userCancelled
              ? 'cancelled'
              : processInterrupted
                ? 'recoverable'
                : 'failed',
            userCancelled
              ? {
                  terminationReason: 'user_cancelled',
                  releaseActive: true,
                  ...(runLeaseValid
                    ? { leaseOwnerId: executionOwnerId }
                    : { onlyIfUnleased: true }),
                }
              : processInterrupted
              ? {
                  error: error.message,
                  ...(runLeaseValid
                    ? { leaseOwnerId: executionOwnerId }
                    : { onlyIfUnleased: true }),
                }
              : {
                  terminationReason: failureTerminationReason,
                  error: error.message,
                  ...failureMetadata,
                  releaseActive: true,
                  ...(runLeaseValid
                    ? { leaseOwnerId: executionOwnerId }
                    : { onlyIfUnleased: true }),
                },
          )
          if (!runStatePersisted) {
            runLeaseValid = false
          }
          if (userCancelled || !processInterrupted) {
            await releaseQueuedMessagesForRun(agentRunId)
          }
        } catch (runError) {
          console.error('[agent-run] Failed to persist terminal error:', (runError as Error).message)
        }
      }
      const detached = leaseLost || (!!agentRunId && !runStatePersisted)
      write(detached
        ? {
            type: 'run_detached',
            message: '当前请求已由另一个执行器接管，或正在等待持久状态接管。',
            ...(agentRunId ? { run_id: agentRunId } : {}),
            ...(convId ? { conversation_id: convId } : {}),
          }
        : userCancelled
          ? {
              type: 'interrupted',
              ...(agentRunId ? { run_id: agentRunId } : {}),
              ...(convId ? { conversation_id: convId } : {}),
            }
          : processInterrupted
            ? {
                type: 'run_recoverable',
                message: '执行已停在最近的完整检查点，可以安全恢复。',
                ...(agentRunId ? { run_id: agentRunId } : {}),
                ...(convId ? { conversation_id: convId } : {}),
              }
            : {
                type: 'error',
                message: error.message,
                ...(agentRunId ? { run_id: agentRunId } : {}),
                ...(convId ? { conversation_id: convId } : {}),
              })
      if (memoryRunId && !leaseLost) {
        setMemoryRunStatus(memoryRunId, userId, 'discarded', error.message)
          .catch(memoryError => console.error('[memory-v2] Failed to discard errored run:', (memoryError as Error).message))
      }
    } finally {
      if (leaseHeartbeat) clearInterval(leaseHeartbeat)
      if (livePersistTimer) clearTimeout(livePersistTimer)
      await livePersistPromise
      if (convId) {
        unregisterAbort(convId)
      }
      if (broadcastId) {
        // Close the broadcast channel — all subscribers (this request + any reconnected tabs)
        // receive the final events and their streams are closed. Channel is GC'd after a delay.
        closeBroadcast(broadcastId)
      } else {
        // Error before a broadcast subscriber was attached — close our own
        // writer directly so the request cannot hang.
        try { await writer.close() } catch { /* already closed */ }
      }
    }
  })()

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
