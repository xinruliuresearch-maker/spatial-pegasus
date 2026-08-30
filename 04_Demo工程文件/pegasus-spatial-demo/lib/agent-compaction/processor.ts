import type { AgentProvider } from '../agent/loop'
import {
  extractSummaryTag,
  FULL_COMPACT_PROMPT,
} from '../agent/compaction'
import { tokenTracker } from '../agent/token-tracker'
import { createAgentProvider } from '../agent/provider'
import type { FrozenProjectContext } from '../agent/project-context'
import type { WorkspaceInstance } from '../workspace/types'
import {
  resolveApiKeyForChannel,
  resolveAuthoritativeModelSnapshot,
  type FrozenModelResolutionSnapshot,
  type KeyChannel,
} from '../llm-registry'
import { logAPICall } from '../db/api-log-repository'
import { AgentRun } from '../agent-runtime/models'
import { AgentTeamModel } from '../agent-team/models'
import { DurableCompactionJobModel } from './models'
import { freezeClaimedCompactionModelResolution } from './repository'
import {
  MongoAgentExecutionBudgetLedger,
  instrumentAgentProviderForBudget,
} from '../agent-team/execution-budget'
import type {
  AgentExecutionBudgetContext,
  AgentExecutionBudgetGate,
  AgentExecutionFenceValidator,
} from '../agent-team/execution-budget'
import type { AgentTeamRecord } from '../agent-team/types'
import type { LLMResponse } from '../types'
import type {
  DurableCompactionJobRecord,
  DurableCompactionProcessor,
} from './types'

/**
 * The worker needs only the Provider's request conversion and silent model call.
 * No tool can execute because the request is forced to `tools: []`, so a
 * Workspace implementation must never be captured from the Run that handed the
 * Job off. Keeping this sentinel module-local makes that invariant explicit.
 */
const NON_EXECUTING_WORKSPACE = Object.freeze({}) as WorkspaceInstance

export type DurableCompactionFailureRecoverability = 'transient' | 'fatal'

/** A classified failure understood by the durable service retry policy. */
export class DurableCompactionProcessorError extends Error {
  readonly code = 'DURABLE_COMPACTION_PROCESSOR_ERROR'

  constructor(
    message: string,
    readonly recoverability: DurableCompactionFailureRecoverability,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'DurableCompactionProcessorError'
  }
}

interface ResolvedCompactionIdentity {
  teamId: string
  agentId: string
  taskId?: string
  runId: string
}

export interface ProductionDurableCompactionProcessorDependencies {
  resolveApiKeyChannel?: (channel: KeyChannel, alias?: string) => string
  resolveAuthoritativeModel?: (
    alias: string,
  ) => Promise<FrozenModelResolutionSnapshot>
  freezeModelResolution?: (
    job: DurableCompactionJobRecord,
    snapshot: FrozenModelResolutionSnapshot,
  ) => Promise<DurableCompactionJobRecord | null>
  createProvider?: typeof createAgentProvider
  resolveIdentity?: (
    job: DurableCompactionJobRecord,
  ) => Promise<ResolvedCompactionIdentity>
  createBudgetGate?: (
    job: DurableCompactionJobRecord,
  ) => AgentExecutionBudgetGate
  logAPICall?: typeof logAPICall
}

async function freezeLegacyModelResolution(
  job: DurableCompactionJobRecord,
  snapshot: FrozenModelResolutionSnapshot,
): Promise<DurableCompactionJobRecord | null> {
  const lease = job.lease
  if (!lease) return null
  return freezeClaimedCompactionModelResolution({
    job,
    ownerId: lease.owner_id,
    fenceToken: lease.fence_token,
  }, snapshot)
}

function requireFrozenModelResolution(
  job: DurableCompactionJobRecord,
): FrozenModelResolutionSnapshot {
  const alias = job.model_alias_snapshot?.trim()
  const snapshot = job.model_resolution_snapshot
  if (!alias || !snapshot || snapshot.snapshot_version !== 1 || snapshot.alias !== alias) {
    throw new DurableCompactionProcessorError(
      `CompactionJob ${job.job_id} has no valid model_resolution_snapshot.`,
      'fatal',
    )
  }
  if (
    !snapshot.real_model.trim()
    || (snapshot.key_channel !== 'orchestrator' && snapshot.key_channel !== 'tools')
    || !Number.isSafeInteger(snapshot.context_window)
    || snapshot.context_window <= 0
    || !Number.isSafeInteger(snapshot.max_output_tokens)
    || snapshot.max_output_tokens <= 0
    || !Number.isSafeInteger(snapshot.compaction_max_output_tokens)
    || snapshot.compaction_max_output_tokens <= 0
    || snapshot.max_output_tokens >= snapshot.context_window
    || snapshot.compaction_max_output_tokens >= snapshot.context_window
    || !['5m', '1h', 'none'].includes(snapshot.prompt_cache_ttl)
    || !snapshot.registry_revision.trim()
    || !/^[a-f0-9]{64}$/i.test(snapshot.registry_hash)
  ) {
    throw new DurableCompactionProcessorError(
      `CompactionJob ${job.job_id} has an invalid model_resolution_snapshot.`,
      'fatal',
    )
  }
  return snapshot
}

function frozenProjectContext(
  job: DurableCompactionJobRecord,
): FrozenProjectContext | undefined {
  const snapshot = job.project_context_snapshot
  if (!snapshot) return undefined
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

function safeErrorMessage(error: unknown, apiKey?: string): string {
  const raw = error instanceof Error ? error.message : String(error)
  const withoutKey = apiKey ? raw.replaceAll(apiKey, '[redacted]') : raw
  // Persisting an entire gateway body can leak echoed request material and can
  // grow the Job without bound. Codes and a bounded diagnostic are sufficient.
  return withoutKey.slice(0, 2_000)
}

function classifyFailure(error: unknown): DurableCompactionFailureRecoverability {
  if (error instanceof DurableCompactionProcessorError) return error.recoverability
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase()
  if (
    message.includes('model_alias_snapshot')
    || message.includes('unknown model alias')
    || message.includes('api key not configured')
    || message.includes('llm_base_url is not configured')
    || (message.includes('execution budget') && message.includes('exceed'))
    || /llm api error (400|401|403|404|413)\b/.test(message)
  ) {
    return 'fatal'
  }
  return 'transient'
}

async function resolveCompactionIdentity(
  job: DurableCompactionJobRecord,
): Promise<ResolvedCompactionIdentity> {
  const run = job.source_run_id
    ? await AgentRun.findOne({
        run_id: job.source_run_id,
        conversation_id: job.conversation_id,
        user_id: job.user_id,
      }).select('team_id agent_id task_id').lean<{
        team_id?: string
        agent_id?: string
        task_id?: string
      }>()
    : null

  const knownTeamId = job.team_id ?? run?.team_id
  const team = await AgentTeamModel.findOne({
    ...(knownTeamId ? { team_id: knownTeamId } : {}),
    conversation_id: job.conversation_id,
    user_id: job.user_id,
  }).select('team_id root_agent_id').lean<Pick<
    AgentTeamRecord,
    'team_id' | 'root_agent_id'
  >>()
  if (!team) {
    throw new DurableCompactionProcessorError(
      `AgentTeam is not available for CompactionJob ${job.job_id}.`,
      'transient',
    )
  }

  return {
    teamId: team.team_id,
    agentId: job.agent_id ?? run?.agent_id ?? team.root_agent_id,
    ...(run?.task_id ? { taskId: run.task_id } : {}),
    // Detached execution identity. The source AgentRun can already be closed;
    // budget recovery recognizes this prefix and validates the Job lease.
    runId: `compaction:${job.job_id}`,
  }
}

/**
 * Fence budget admission with the CompactionJob lease, not the expired
 * AgentRun lease. This preserves the existing atomic Team/Agent/Task budget
 * ledger while allowing compaction to outlive a Run and without consuming an
 * Agent execution slot.
 */
function createDetachedCompactionBudgetGate(
  job: DurableCompactionJobRecord,
): AgentExecutionBudgetGate {
  const expectedOwner = job.lease?.owner_id
  const expectedFence = job.lease?.fence_token
  if (!expectedOwner || !expectedFence) {
    throw new DurableCompactionProcessorError(
      `CompactionJob ${job.job_id} has no active worker lease.`,
      'transient',
    )
  }
  const validateLease = async (ownerId: string): Promise<boolean> => Boolean(
    ownerId === expectedOwner
    && await DurableCompactionJobModel.exists({
      job_id: job.job_id,
      status: { $in: ['summarizing', 'summary_ready', 'merge_prepared'] },
      'lease.owner_id': expectedOwner,
      'lease.fence_token': expectedFence,
      'lease.expires_at': { $gt: new Date() },
    }),
  )
  const validator: AgentExecutionFenceValidator = {
    validateRun: async (_runId, ownerId) => validateLease(ownerId),
    validateTeam: async input => validateLease(input.ownerId),
  }
  return new MongoAgentExecutionBudgetLedger(validator)
}

/**
 * Defense in depth around Provider request construction. The production
 * Provider already produces a tool-free compaction fork, but the durable
 * boundary asserts and overwrites the fields that must never drift.
 */
export function buildProductionCompactionRequest(
  provider: AgentProvider,
  job: DurableCompactionJobRecord,
  maxOutputTokens: number,
): ReturnType<AgentProvider['buildCompactionRequest']> {
  const request = provider.buildCompactionRequest(
    job.frozen_prefix.messages,
    FULL_COMPACT_PROMPT,
    maxOutputTokens,
  )
  request.tools = []
  request.max_tokens = maxOutputTokens
  return request
}

/**
 * Rebuild a summary-only Provider from persisted Job data on every attempt.
 * It intentionally captures no Run callbacks, abort controller, Workspace, or
 * provider closure, so another process can take over after lease expiry.
 */
export function createProductionDurableCompactionProcessor(
  dependencies: ProductionDurableCompactionProcessorDependencies = {},
): DurableCompactionProcessor {
  const resolveKeyChannel = dependencies.resolveApiKeyChannel ?? resolveApiKeyForChannel
  const resolveAuthoritativeModel = dependencies.resolveAuthoritativeModel
    ?? resolveAuthoritativeModelSnapshot
  const freezeModelResolution = dependencies.freezeModelResolution
    ?? freezeLegacyModelResolution
  const providerFactory = dependencies.createProvider ?? createAgentProvider
  const resolveIdentity = dependencies.resolveIdentity ?? resolveCompactionIdentity
  const createBudgetGate = dependencies.createBudgetGate ?? createDetachedCompactionBudgetGate
  const writeApiLog = dependencies.logAPICall ?? logAPICall

  return {
    async summarize(job, signal) {
      const alias = job.model_alias_snapshot?.trim()
      if (!alias) {
        throw new DurableCompactionProcessorError(
          `CompactionJob ${job.job_id} is missing model_alias_snapshot.`,
          'fatal',
        )
      }

      let apiKey: string | undefined
      let request: ReturnType<AgentProvider['buildCompactionRequest']> | null = null
      let model = alias
      let identity: ResolvedCompactionIdentity | undefined
      let activeJob = job
      const startedAt = Date.now()
      try {
        if (!activeJob.model_resolution_snapshot) {
          const resolved = await resolveAuthoritativeModel(alias)
          const frozen = await freezeModelResolution(activeJob, resolved)
          if (!frozen) {
            throw new DurableCompactionProcessorError(
              `CompactionJob ${job.job_id} lost its lease while freezing model resolution.`,
              'transient',
            )
          }
          activeJob = frozen
        }
        const resolution = requireFrozenModelResolution(activeJob)
        apiKey = resolveKeyChannel(resolution.key_channel, alias)
        model = resolution.real_model
        identity = await resolveIdentity(activeJob)
        const leaseOwner = activeJob.lease?.owner_id
        if (!leaseOwner) {
          throw new DurableCompactionProcessorError(
            `CompactionJob ${job.job_id} has no active worker lease.`,
            'transient',
          )
        }
        const budgetContext: AgentExecutionBudgetContext = {
          teamId: identity.teamId,
          conversationId: activeJob.conversation_id,
          userId: activeJob.user_id,
          agentId: identity.agentId,
          ...(identity.taskId ? { taskId: identity.taskId } : {}),
          runId: identity.runId,
          executionOwnerId: leaseOwner,
          ...(activeJob.agent_session_id
            ? { agentSessionId: activeJob.agent_session_id }
            : {}),
          // The CompactionJob lease is the fence for this detached external
          // call. It must not reacquire a member execution slot.
          teamFenceRequired: false,
        }

        const rawProvider = providerFactory(
          NON_EXECUTING_WORKSPACE,
          new Map(),
          {
            model,
            maxTokens: resolution.max_output_tokens,
            temperature: 0,
            apiKey,
            supportsVision: resolution.supports_vision,
            executionContext: {
              userId: activeJob.user_id,
              conversationId: activeJob.conversation_id,
              runId: identity.runId,
              teamId: identity.teamId,
              agentId: identity.agentId,
              ...(activeJob.agent_session_id
                ? { agentSessionId: activeJob.agent_session_id }
                : {}),
              ...(identity.taskId ? { taskId: identity.taskId } : {}),
              isRoot: activeJob.owner_kind === 'conversation',
            },
          },
          undefined,
          undefined,
          frozenProjectContext(activeJob),
        )
        const provider = instrumentAgentProviderForBudget(rawProvider, {
          context: budgetContext,
          model,
          ledger: createBudgetGate(activeJob),
        })
        request = buildProductionCompactionRequest(
          provider,
          activeJob,
          resolution.compaction_max_output_tokens,
        )

        const response = await tokenTracker.runWithContext({
          userId: activeJob.user_id,
          conversationId: activeJob.conversation_id,
          teamId: identity.teamId,
          agentId: identity.agentId,
          ...(identity.taskId ? { taskId: identity.taskId } : {}),
          runId: identity.runId,
        }, async () => provider.callLLMSilent(request!, signal))

        if (signal.aborted || response.stop_reason === 'aborted') {
          throw new DurableCompactionProcessorError(
            `CompactionJob ${job.job_id} model call was interrupted.`,
            'transient',
          )
        }
        const fullText = response.content
          .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
          .map(block => block.text)
          .join('\n')
        const summary = extractSummaryTag(fullText)
        if (!summary.trim()) {
          throw new DurableCompactionProcessorError(
            `CompactionJob ${job.job_id} model response contained no summary.`,
            'transient',
          )
        }

        tokenTracker.runWithContext({
          userId: activeJob.user_id,
          conversationId: activeJob.conversation_id,
          teamId: identity.teamId,
          agentId: identity.agentId,
          ...(identity.taskId ? { taskId: identity.taskId } : {}),
          runId: identity.runId,
        }, () => tokenTracker.record({
          source: 'compaction',
          model,
          input_tokens: response.usage.input_tokens,
          output_tokens: response.usage.output_tokens,
          cache_creation_input_tokens: response.usage.cache_creation_input_tokens,
          cache_read_input_tokens: response.usage.cache_read_input_tokens,
        }))
        await writeApiLog({
          user_id: job.user_id,
          conversation_id: job.conversation_id,
          team_id: identity.teamId,
          agent_id: identity.agentId,
          ...(identity.taskId ? { task_id: identity.taskId } : {}),
          run_id: identity.runId,
          source: 'compaction',
          model,
          usage: response.usage,
          duration_ms: Date.now() - startedAt,
          status: 'success',
          turn_number: job.attempt,
          request_body: request,
          response,
        }).catch(error => {
          // A secondary observability outage must not repeat a successful and
          // already budget-settled external model call.
          console.error('[agent-compaction] API log write failed:', safeErrorMessage(error))
        })
        return { summary, usage: response.usage }
      } catch (error) {
        const message = safeErrorMessage(error, apiKey)
        const status = signal.aborted ? 'aborted' : 'error'
        if (request && identity) {
          const emptyResponse: LLMResponse | null = null
          await writeApiLog({
            user_id: job.user_id,
            conversation_id: job.conversation_id,
            team_id: identity.teamId,
            agent_id: identity.agentId,
            ...(identity.taskId ? { task_id: identity.taskId } : {}),
            run_id: identity.runId,
            source: 'compaction',
            model,
            usage: { input_tokens: 0, output_tokens: 0 },
            duration_ms: Date.now() - startedAt,
            status,
            error_message: message,
            turn_number: job.attempt,
            request_body: request,
            response: emptyResponse,
          }).catch(logError => {
            console.error('[agent-compaction] API error log write failed:', safeErrorMessage(logError))
          })
        }
        if (error instanceof DurableCompactionProcessorError) throw error
        throw new DurableCompactionProcessorError(
          message,
          classifyFailure(error),
          { cause: error },
        )
      }
    },
  }
}
