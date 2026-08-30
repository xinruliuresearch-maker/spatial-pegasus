import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  estimateOverheadTokens,
  estimateProjectContextOverheadTokens,
} from '../lib/agent/provider'
import {
  estimateTokens,
  FULL_COMPACT_PROMPT,
} from '../lib/agent/compaction'
import type { FrozenProjectContext } from '../lib/agent/project-context'
import type {
  FrozenProjectContextSnapshot,
} from '../lib/agent-runtime/types'
import type { ConversationMessage } from '../lib/types'
import type { FrozenModelResolutionSnapshot } from '../lib/llm-registry'
import type {
  CompactionContextOwner,
  DurableCompactionJobCommandResult,
  DurableCompactionJobRecord,
  EnqueueCompactionInput,
} from '../lib/agent-compaction/types'

const DEFAULT_NOT_BEFORE_MINUTES = 10
const REPAIR_ATTEMPT_ID_PATTERN = /^rpa_[a-f0-9]{32}$/
export const REPAIR_COMPACTION_SAFETY_MARGIN_TOKENS = 12_000

export const REPAIR_DURABLE_COMPACTION_HELP = `Usage:
  npm run durable-compaction:repair -- --dry-run --conversation <id> [--not-before-minutes <1-1440>]
  npm run durable-compaction:repair -- --prepare --conversation <id> --repair-attempt-id <rpa_...> [--not-before-minutes <1-1440>]
  npm run durable-compaction:repair -- --activate --job <job-id> --idempotency-key <key>
  npm run durable-compaction:repair -- --status --job <job-id>

Workflow:
  1. Run --dry-run and copy repair_attempt_id from its output.
  2. Re-run with --prepare and that exact --repair-attempt-id.
  3. Inspect --status, then optionally use --activate with the returned job/key.

Each new repair attempt requires a fresh --dry-run. Terminal Jobs are never reopened or deleted.`

export type RepairDurableCompactionCommand =
  | {
      mode: 'help'
    }
  | {
      mode: 'dry-run'
      conversationId: string
      notBeforeMinutes: number
    }
  | {
      mode: 'prepare'
      conversationId: string
      notBeforeMinutes: number
      repairAttemptId: string
    }
  | {
      mode: 'activate'
      jobId: string
      idempotencyKey: string
    }
  | {
      mode: 'status'
      jobId: string
    }

interface RepairConversationSnapshot {
  conversationId: string
  userId: string
  requestedAlias?: string
  messages: ConversationMessage[]
  compactedMessages: ConversationMessage[]
  contextRevision: number
  contextFence: unknown
}

interface RepairRuntimeSnapshot {
  activeRunId?: string | null
  activeLeaseOwnerId?: string | null
  projectContextSnapshot?: FrozenProjectContextSnapshot | null
}

interface RepairUserSnapshot {
  userId: string
  plan: 'free' | 'pro' | 'team'
  forcedMainAlias?: string
  status: 'active' | 'disabled' | 'banned'
}

interface RepairTeamSnapshot {
  teamId: string
  conversationId: string
  userId: string
  rootAgentId: string
  workspaceId: string
  status: 'active' | 'completed'
}

interface RepairRootAgentSnapshot {
  agentId: string
  teamId: string
  conversationId: string
  userId: string
  isRoot: boolean
  status: 'running' | 'idle' | 'paused' | 'completed' | 'failed'
  generation: number
  currentSessionId: string
}

interface RepairRootSessionSnapshot {
  sessionId: string
  teamId: string
  conversationId: string
  userId: string
  agentId: string
  generation: number
  activeRunId?: string | null
  activeLeaseOwnerId?: string | null
  runLease?: unknown
}

interface RepairAliasResolution {
  alias: string
  modelResolutionSnapshot: FrozenModelResolutionSnapshot
}

interface OperatorAliasConfig {
  realModel?: unknown
  keyChannel?: unknown
  availableToPlans?: unknown
  supportsVision?: unknown
  contextWindow?: unknown
  maxOutputTokens?: unknown
  compactionMaxOutputTokens?: unknown
  promptCacheTtl?: unknown
}

interface OperatorRegistrySnapshot {
  aliases: Record<string, OperatorAliasConfig>
  defaultMainAlias: Partial<Record<RepairUserSnapshot['plan'], string>>
  disabledAliases: Set<string>
}

export interface RepairDurableCompactionDependencies {
  now(): Date
  loadConversation(conversationId: string): Promise<RepairConversationSnapshot | null>
  loadRuntime(conversationId: string, userId: string): Promise<RepairRuntimeSnapshot | null>
  loadTeam(conversationId: string, userId: string): Promise<RepairTeamSnapshot | null>
  loadRootAgent(team: RepairTeamSnapshot): Promise<RepairRootAgentSnapshot | null>
  loadRootSession(
    team: RepairTeamSnapshot,
    root: RepairRootAgentSnapshot,
  ): Promise<RepairRootSessionSnapshot | null>
  resolveAlias(
    user: RepairUserSnapshot,
    requestedAlias: string | undefined,
  ): Promise<RepairAliasResolution>
  getActiveRun(conversationId: string, userId: string): Promise<{ runId: string } | null>
  getActiveJob(owner: CompactionContextOwner): Promise<DurableCompactionJobRecord | null>
  getJob(jobId: string): Promise<DurableCompactionJobRecord | null>
  enqueue(input: EnqueueCompactionInput): Promise<DurableCompactionJobRecord>
  activate(input: {
    jobId: string
    owner: CompactionContextOwner
    idempotencyKey: string
  }): Promise<DurableCompactionJobCommandResult>
  cancelPrepared(input: {
    jobId: string
    owner: CompactionContextOwner
    idempotencyKey: string
    reason: string
  }): Promise<DurableCompactionJobCommandResult>
}

interface SelectedRepairPrefix {
  messages: ConversationMessage[]
  prefixLength: number
  tailLength: number
  prefixHash: string
  boundaryMessageId?: string
  estimatedRequestTokens: number
  requestLimitTokens: number
  instructionTokens: number
  staticOverheadTokens: number
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1]?.trim()
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`)
  return value
}

function parseFiniteMinutes(value: string): number {
  const minutes = Number(value)
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 24 * 60) {
    throw new Error('--not-before-minutes must be an integer between 1 and 1440.')
  }
  return minutes
}

function parseRepairAttemptId(value: string): string {
  if (!REPAIR_ATTEMPT_ID_PATTERN.test(value)) {
    throw new Error('--repair-attempt-id must match rpa_ followed by 32 lowercase hex characters.')
  }
  return value
}

function newRepairAttemptId(): string {
  return `rpa_${randomBytes(16).toString('hex')}`
}

export function parseRepairDurableCompactionArgs(
  argv: readonly string[],
): RepairDurableCompactionCommand {
  let mode: RepairDurableCompactionCommand['mode'] | undefined
  let conversationId: string | undefined
  let jobId: string | undefined
  let idempotencyKey: string | undefined
  let repairAttemptId: string | undefined
  let notBeforeMinutes = DEFAULT_NOT_BEFORE_MINUTES
  let notBeforeProvided = false

  const setMode = (next: RepairDurableCompactionCommand['mode']) => {
    if (mode && mode !== next) throw new Error('Choose exactly one repair mode.')
    mode = next
  }

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--dry-run') setMode('dry-run')
    else if (flag === '--prepare') setMode('prepare')
    else if (flag === '--activate') setMode('activate')
    else if (flag === '--status') setMode('status')
    else if (flag === '--help' || flag === '-h') setMode('help')
    else if (flag === '--conversation') {
      conversationId = requireValue(argv, index, flag)
      index += 1
    } else if (flag === '--job') {
      jobId = requireValue(argv, index, flag)
      index += 1
    } else if (flag === '--idempotency-key') {
      idempotencyKey = requireValue(argv, index, flag)
      index += 1
    } else if (flag === '--repair-attempt-id') {
      repairAttemptId = parseRepairAttemptId(requireValue(argv, index, flag))
      index += 1
    } else if (flag === '--not-before-minutes') {
      notBeforeProvided = true
      notBeforeMinutes = parseFiniteMinutes(requireValue(argv, index, flag))
      index += 1
    } else {
      throw new Error(`Unknown argument: ${flag}`)
    }
  }

  mode ??= 'dry-run'
  if (mode === 'help') {
    if (argv.length !== 1) throw new Error('--help cannot be combined with other arguments.')
    return { mode }
  }
  if (mode === 'dry-run' || mode === 'prepare') {
    if (!conversationId) throw new Error(`${mode} requires --conversation.`)
    if (jobId || idempotencyKey) throw new Error(`${mode} does not accept --job or --idempotency-key.`)
    if (mode === 'dry-run') {
      if (repairAttemptId) throw new Error('dry-run generates repair_attempt_id and does not accept one.')
      return { mode, conversationId, notBeforeMinutes }
    }
    if (!repairAttemptId) {
      throw new Error('prepare requires --repair-attempt-id from a fresh dry-run.')
    }
    return { mode, conversationId, notBeforeMinutes, repairAttemptId }
  }
  if (conversationId) throw new Error(`${mode} does not accept --conversation.`)
  if (notBeforeProvided) throw new Error(`${mode} does not accept --not-before-minutes.`)
  if (repairAttemptId) throw new Error(`${mode} does not accept --repair-attempt-id.`)
  if (!jobId) throw new Error(`${mode} requires --job.`)
  if (mode === 'activate') {
    if (!idempotencyKey) throw new Error('activate requires --idempotency-key.')
    return { mode, jobId, idempotencyKey }
  }
  if (idempotencyKey) throw new Error('status does not accept --idempotency-key.')
  return { mode, jobId }
}

function messageToolIds(message: ConversationMessage): {
  uses: string[]
  results: string[]
} {
  const uses: string[] = []
  const results: string[] = []
  for (const block of message.content) {
    if (block.type === 'tool_use' && block.id) uses.push(block.id)
    if (block.type === 'tool_result' && block.tool_use_id) results.push(block.tool_use_id)
  }
  return { uses, results }
}

/** A summary fork may never split an assistant tool_use from its user result. */
export function isSafeRepairPrefixBoundary(
  messages: readonly ConversationMessage[],
  prefixLength: number,
): boolean {
  if (prefixLength < 1 || prefixLength >= messages.length) return false
  const prefixUses = new Set<string>()
  const prefixResults = new Set<string>()
  const tailResults = new Set<string>()
  messages.forEach((message, index) => {
    const ids = messageToolIds(message)
    const targetUses = index < prefixLength ? prefixUses : undefined
    const targetResults = index < prefixLength ? prefixResults : tailResults
    ids.uses.forEach(id => targetUses?.add(id))
    ids.results.forEach(id => targetResults.add(id))
  })
  for (const toolUseId of prefixUses) {
    if (!prefixResults.has(toolUseId) || tailResults.has(toolUseId)) return false
  }
  for (const toolResultId of prefixResults) {
    if (!prefixUses.has(toolResultId)) return false
  }
  return true
}

function assertWellFormedRepairToolHistory(messages: readonly ConversationMessage[]): void {
  const seenUses = new Set<string>()
  const completedUses = new Set<string>()
  for (const message of messages) {
    const ids = messageToolIds(message)
    for (const id of ids.uses) {
      if (seenUses.has(id)) throw new Error(`Duplicate tool_use id in repair context: ${id}`)
      seenUses.add(id)
    }
    for (const id of ids.results) {
      if (!seenUses.has(id) || completedUses.has(id)) {
        throw new Error(`Orphan or duplicate tool_result in repair context: ${id}`)
      }
      completedUses.add(id)
    }
  }
  for (const id of seenUses) {
    if (!completedUses.has(id)) {
      throw new Error(`Unclosed tool_use in repair context: ${id}`)
    }
  }
}

function hashMessages(messages: readonly ConversationMessage[]): string {
  return createHash('sha256').update(JSON.stringify(messages)).digest('hex')
}

function sameFrozenModelResolution(
  left: FrozenModelResolutionSnapshot | null | undefined,
  right: FrozenModelResolutionSnapshot,
): boolean {
  return Boolean(
    left
    && left.snapshot_version === right.snapshot_version
    && left.alias === right.alias
    && left.real_model === right.real_model
    && left.key_channel === right.key_channel
    && left.supports_vision === right.supports_vision
    && left.context_window === right.context_window
    && left.max_output_tokens === right.max_output_tokens
    && left.compaction_max_output_tokens === right.compaction_max_output_tokens
    && left.prompt_cache_ttl === right.prompt_cache_ttl
    && left.used_compatibility_defaults === right.used_compatibility_defaults
    && left.registry_source === right.registry_source
    && left.registry_revision === right.registry_revision
    && left.registry_hash === right.registry_hash,
  )
}

export function repairCompactionIdempotencyKey(input: {
  conversationId: string
  contextRevision: number
  repairAttemptId: string
  prefixHash: string
}): string {
  const repairAttemptId = parseRepairAttemptId(input.repairAttemptId)
  return [
    'operator-repair',
    input.conversationId,
    String(input.contextRevision),
    repairAttemptId,
    input.prefixHash,
  ].join(':')
}

export function estimateRepairCompactionRequestTokens(
  messages: readonly ConversationMessage[],
  staticOverheadTokens: number,
): { total: number; instruction: number } {
  const instruction = estimateTokens([{
    role: 'user',
    content: [{ type: 'text', text: FULL_COMPACT_PROMPT }],
  }])
  return {
    total: estimateTokens([...messages]) + instruction + Math.max(0, staticOverheadTokens),
    instruction,
  }
}

export function selectSafeRepairCompactionPrefix(input: {
  messages: readonly ConversationMessage[]
  contextWindow: number
  compactionMaxOutputTokens: number
  staticOverheadTokens: number
  safetyMarginTokens?: number
}): SelectedRepairPrefix {
  if (input.messages.length < 2) {
    throw new Error('Repair compaction requires a non-empty verbatim tail.')
  }
  assertWellFormedRepairToolHistory(input.messages)
  const margin = input.safetyMarginTokens ?? REPAIR_COMPACTION_SAFETY_MARGIN_TOKENS
  const requestLimitTokens = input.contextWindow - input.compactionMaxOutputTokens - margin
  if (!Number.isFinite(requestLimitTokens) || requestLimitTokens <= 0) {
    throw new Error('Model capacity cannot reserve summary output and repair safety margin.')
  }

  let low = 1
  let high = input.messages.length - 1
  let largestFitting = 0
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const estimate = estimateRepairCompactionRequestTokens(
      input.messages.slice(0, middle),
      input.staticOverheadTokens,
    )
    if (estimate.total <= requestLimitTokens) {
      largestFitting = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }

  for (let length = largestFitting; length >= 1; length -= 1) {
    if (!isSafeRepairPrefixBoundary(input.messages, length)) continue
    const prefix = input.messages.slice(0, length).map(message => structuredClone(message))
    const estimate = estimateRepairCompactionRequestTokens(prefix, input.staticOverheadTokens)
    return {
      messages: prefix,
      prefixLength: length,
      tailLength: input.messages.length - length,
      prefixHash: hashMessages(prefix),
      ...(prefix.at(-1)?.message_id
        ? { boundaryMessageId: prefix.at(-1)!.message_id }
        : {}),
      estimatedRequestTokens: estimate.total,
      requestLimitTokens,
      instructionTokens: estimate.instruction,
      staticOverheadTokens: Math.max(0, input.staticOverheadTokens),
    }
  }
  throw new Error('No closed tool-round prefix fits the repair compaction request limit.')
}

function toFrozenProjectContext(
  snapshot: FrozenProjectContextSnapshot | null | undefined,
): FrozenProjectContext | undefined {
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

function activeMessages(conversation: RepairConversationSnapshot): {
  source: 'compacted_messages' | 'messages'
  messages: ConversationMessage[]
} {
  return conversation.compactedMessages.length > 0
    ? { source: 'compacted_messages', messages: conversation.compactedMessages }
    : { source: 'messages', messages: conversation.messages }
}

function fencePresent(value: unknown): boolean {
  return value !== null && value !== undefined
}

async function loadAuthorizedProject(
  conversationId: string,
  dependencies: RepairDurableCompactionDependencies,
): Promise<{
  conversation: RepairConversationSnapshot
  runtime: RepairRuntimeSnapshot | null
  user: RepairUserSnapshot
  team: RepairTeamSnapshot
  root: RepairRootAgentSnapshot
  rootSession: RepairRootSessionSnapshot
  alias: RepairAliasResolution
}> {
  const conversation = await dependencies.loadConversation(conversationId)
  if (!conversation) throw new Error('Conversation was not found.')
  const [runtime, team] = await Promise.all([
    dependencies.loadRuntime(conversationId, conversation.userId),
    dependencies.loadTeam(conversationId, conversation.userId),
  ])
  const user: RepairUserSnapshot = {
    userId: conversation.userId,
    plan: 'team',
    status: 'active',
  }
  if (
    !team
    || team.conversationId !== conversationId
    || team.userId !== conversation.userId
    || team.status !== 'active'
  ) {
    throw new Error('Active AgentTeam ownership could not be verified.')
  }
  const root = await dependencies.loadRootAgent(team)
  if (
    !root
    || !root.isRoot
    || root.agentId !== team.rootAgentId
    || root.teamId !== team.teamId
    || root.conversationId !== conversationId
    || root.userId !== conversation.userId
  ) {
    throw new Error('Root Agent ownership could not be verified.')
  }
  const rootSession = await dependencies.loadRootSession(team, root)
  if (
    !rootSession
    || rootSession.sessionId !== root.currentSessionId
    || rootSession.teamId !== team.teamId
    || rootSession.conversationId !== conversationId
    || rootSession.userId !== conversation.userId
    || rootSession.agentId !== root.agentId
    || rootSession.generation !== root.generation
  ) {
    throw new Error('Current Root AgentSession ownership could not be verified.')
  }
  const alias = await dependencies.resolveAlias(user, conversation.requestedAlias)
  return { conversation, runtime, user, team, root, rootSession, alias }
}

async function assertQuiescentRepairAuthority(
  project: {
    conversation: RepairConversationSnapshot
    runtime: RepairRuntimeSnapshot | null
    root: RepairRootAgentSnapshot
    rootSession: RepairRootSessionSnapshot
  },
  dependencies: RepairDurableCompactionDependencies,
): Promise<void> {
  if (project.root.status !== 'idle') {
    throw new Error(`Root TeamAgent is ${project.root.status}; operator repair requires idle.`)
  }
  if (fencePresent(project.conversation.contextFence)) {
    throw new Error('Conversation has a context compaction fence; refusing operator repair.')
  }
  if (project.runtime?.activeRunId) {
    throw new Error('ConversationRuntime has an active Run pointer; refusing operator repair.')
  }
  if (project.runtime?.activeLeaseOwnerId) {
    throw new Error('ConversationRuntime has an active lease owner; refusing operator repair.')
  }
  if (
    project.rootSession.activeRunId
    || project.rootSession.activeLeaseOwnerId
    || fencePresent(project.rootSession.runLease)
  ) {
    throw new Error('Current Root AgentSession has an active Run or lease; refusing operator repair.')
  }
  if (await dependencies.getActiveRun(
    project.conversation.conversationId,
    project.conversation.userId,
  )) {
    throw new Error('Conversation has an active AgentRun; refusing operator repair.')
  }
}

function publicJobStatus(job: DurableCompactionJobRecord) {
  return {
    job_id: job.job_id,
    owner_kind: job.owner_kind,
    conversation_id: job.conversation_id,
    status: job.status,
    status_revision: job.status_revision ?? 0,
    active_barrier: Boolean(job.active_key),
    attempt: job.attempt,
    available_at: job.available_at ?? null,
    finished_at: job.finished_at ?? null,
    lease_active: Boolean(
      job.lease && new Date(job.lease.expires_at).getTime() > Date.now(),
    ),
    lease_expires_at: job.lease?.expires_at ?? null,
    model_alias: job.model_alias_snapshot ?? null,
    context_revision: job.frozen_prefix.context_revision,
    prefix_length: job.frozen_prefix.prefix_length,
    prefix_hash: job.frozen_prefix.prefix_hash,
    boundary_message_id: job.frozen_prefix.boundary_message_id ?? null,
    summary_present: Boolean(job.summary),
    replacement_present: Boolean(job.replacement_message),
    runtime_settled: Boolean(job.runtime_settled_at),
    error_present: Boolean(job.last_error),
  }
}

async function preparationReport(
  command: Extract<RepairDurableCompactionCommand, { mode: 'dry-run' | 'prepare' }>,
  dependencies: RepairDurableCompactionDependencies,
) {
  const project = await loadAuthorizedProject(command.conversationId, dependencies)
  await assertQuiescentRepairAuthority(project, dependencies)
  const owner: CompactionContextOwner = {
    kind: 'conversation',
    conversationId: project.conversation.conversationId,
    userId: project.conversation.userId,
  }
  const source = activeMessages(project.conversation)
  const projectContext = toFrozenProjectContext(project.runtime?.projectContextSnapshot)
  const projectContextOverhead = estimateProjectContextOverheadTokens(projectContext)
  const staticOverhead = estimateOverheadTokens(
    [],
    [],
    undefined,
    projectContext,
    { isRoot: true, agentId: project.root.agentId },
  )
  const selected = selectSafeRepairCompactionPrefix({
    messages: source.messages,
    contextWindow: project.alias.modelResolutionSnapshot.context_window,
    compactionMaxOutputTokens:
      project.alias.modelResolutionSnapshot.compaction_max_output_tokens,
    staticOverheadTokens: staticOverhead,
  })
  const repairAttemptId = command.mode === 'dry-run'
    ? newRepairAttemptId()
    : command.repairAttemptId
  const idempotencyKey = repairCompactionIdempotencyKey({
    conversationId: project.conversation.conversationId,
    contextRevision: project.conversation.contextRevision,
    repairAttemptId,
    prefixHash: selected.prefixHash,
  })
  const activeJob = await dependencies.getActiveJob(owner)
  const exactReplay = Boolean(
    activeJob
    && activeJob.idempotency_keys.includes(idempotencyKey)
    && activeJob.frozen_prefix.context_revision === project.conversation.contextRevision
    && activeJob.frozen_prefix.prefix_hash === selected.prefixHash
    && activeJob.model_alias_snapshot === project.alias.alias
    && sameFrozenModelResolution(
      activeJob.model_resolution_snapshot,
      project.alias.modelResolutionSnapshot,
    )
    && activeJob.status === 'queued'
    && !activeJob.lease,
  )
  if (activeJob && !exactReplay) {
    throw new Error(`A different active CompactionJob already owns this Conversation (${activeJob.status}).`)
  }
  const now = dependencies.now()
  const notBefore = new Date(now.getTime() + command.notBeforeMinutes * 60_000)
  const base = {
    mode: command.mode,
    write_performed: false,
    verification: {
      owner: 'verified',
      team: 'verified',
      root_agent: 'verified',
      model_alias: 'verified',
      active_run: 'none',
      context_fence: 'none',
      active_job: exactReplay ? 'exact_replay' : 'none',
    },
    conversation_id: project.conversation.conversationId,
    user_id: project.conversation.userId,
    team_id: project.team.teamId,
    root_agent_id: project.root.agentId,
    workspace_id: project.team.workspaceId,
    model_alias: project.alias.alias,
    capacity: {
      context_window: project.alias.modelResolutionSnapshot.context_window,
      compaction_max_output_tokens:
        project.alias.modelResolutionSnapshot.compaction_max_output_tokens,
      safety_margin_tokens: REPAIR_COMPACTION_SAFETY_MARGIN_TOKENS,
      request_limit_tokens: selected.requestLimitTokens,
      estimated_request_tokens: selected.estimatedRequestTokens,
      static_overhead_tokens: selected.staticOverheadTokens,
      project_context_overhead_tokens: projectContextOverhead,
      instruction_tokens: selected.instructionTokens,
    },
    context: {
      revision: project.conversation.contextRevision,
      source: source.source,
      active_message_count: source.messages.length,
      prefix_length: selected.prefixLength,
      tail_length: selected.tailLength,
      prefix_hash: selected.prefixHash,
      boundary_message_id: selected.boundaryMessageId ?? null,
      project_context_epoch: project.runtime?.projectContextSnapshot?.epoch ?? null,
    },
    idempotency_key: idempotencyKey,
    repair_attempt_id: repairAttemptId,
    not_before: notBefore,
    auto_claim_after_not_before: true,
  }
  if (command.mode === 'dry-run') return base

  // Install the durable admission barrier first. The owner repository verifies
  // that this exact prefix still matches the persisted Conversation. Once the
  // barrier exists, Runner/executor admission cannot start a new model turn;
  // we then re-read every duplicated execution authority below. This ordering
  // closes the cross-collection check-before-enqueue race.
  const job = await dependencies.enqueue({
    owner,
    idempotencyKey,
    modelAliasSnapshot: project.alias.alias,
    modelResolutionSnapshot: project.alias.modelResolutionSnapshot,
    prefixMessages: selected.messages,
    projectContextSnapshot: project.runtime?.projectContextSnapshot ?? null,
    workspaceProjection: project.runtime?.projectContextSnapshot?.workspace_projection ?? null,
    initialAvailableAt: notBefore,
  })
  const rollback = async (reason: string): Promise<never> => {
    let cancellation: DurableCompactionJobCommandResult
    try {
      cancellation = await dependencies.cancelPrepared({
        jobId: job.job_id,
        owner,
        idempotencyKey,
        reason: `operator_prepare_revalidation:${reason}`,
      })
    } catch {
      throw new Error(
        `${reason} Exact prepared-Job rollback raised an error; manual intervention is required.`,
      )
    }
    const safelyInactive = !cancellation.job.active_key
      && (cancellation.job.status === 'cancelled' || cancellation.job.status === 'superseded')
    if (!cancellation.changed && !safelyInactive) {
      throw new Error(
        `${reason} The Job was no longer queued and unleased, so automatic rollback was refused; manual intervention is required.`,
      )
    }
    throw new Error(`${reason} The exact prepared Job was safely cancelled; rerun dry-run.`)
  }

  if (
    job.owner_key !== `conversation:${project.conversation.conversationId}`
    || job.active_key !== `conversation:${project.conversation.conversationId}`
    || job.status !== 'queued'
    || Boolean(job.lease)
    || job.frozen_prefix.context_revision !== project.conversation.contextRevision
    || job.frozen_prefix.prefix_hash !== selected.prefixHash
    || job.model_alias_snapshot !== project.alias.alias
    || !sameFrozenModelResolution(
      job.model_resolution_snapshot,
      project.alias.modelResolutionSnapshot,
    )
    || !job.idempotency_keys.includes(idempotencyKey)
  ) {
    // enqueueDurableCompaction may return either a racing active-key winner or
    // a historical idempotency prior. A joined/existing key does not prove
    // that this operator created an active, unclaimed shadow. Never roll back
    // a non-exact, terminal, transitioned, or leased Job automatically.
    throw new Error(
      'Enqueue did not return the exact active, unclaimed queued CompactionJob intent; automatic rollback was refused and manual intervention is required.',
    )
  }

  let freshProject: Awaited<ReturnType<typeof loadAuthorizedProject>>
  try {
    freshProject = await loadAuthorizedProject(command.conversationId, dependencies)
    await assertQuiescentRepairAuthority(freshProject, dependencies)
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Execution authority revalidation failed.'
    return rollback(reason)
  }
  const freshSource = activeMessages(freshProject.conversation)
  if (
    freshProject.conversation.contextRevision !== project.conversation.contextRevision
    || freshProject.team.teamId !== project.team.teamId
    || freshProject.root.agentId !== project.root.agentId
    || freshProject.root.generation !== project.root.generation
    || freshProject.root.currentSessionId !== project.root.currentSessionId
    || freshProject.alias.alias !== project.alias.alias
    || !sameFrozenModelResolution(
      freshProject.alias.modelResolutionSnapshot,
      project.alias.modelResolutionSnapshot,
    )
    || hashMessages(freshSource.messages.slice(0, selected.prefixLength)) !== selected.prefixHash
  ) {
    return rollback('Conversation or Root execution identity changed after repair planning.')
  }
  return {
    ...base,
    write_performed: !exactReplay,
    job: publicJobStatus(job),
  }
}

async function loadAuthorizedJob(
  jobId: string,
  dependencies: RepairDurableCompactionDependencies,
) {
  const job = await dependencies.getJob(jobId)
  if (!job) throw new Error('CompactionJob was not found.')
  if (job.owner_kind !== 'conversation') {
    throw new Error('This operator command supports Root Conversation Jobs only.')
  }
  const project = await loadAuthorizedProject(job.conversation_id, dependencies)
  if (project.conversation.userId !== job.user_id) {
    throw new Error('CompactionJob owner does not match the Conversation owner.')
  }
  if (project.alias.alias !== job.model_alias_snapshot) {
    throw new Error('CompactionJob model alias is no longer the authorized Conversation alias.')
  }
  if (!sameFrozenModelResolution(
    job.model_resolution_snapshot,
    project.alias.modelResolutionSnapshot,
  )) {
    throw new Error('CompactionJob frozen model mapping no longer matches the authorized registry.')
  }
  return { job, project }
}

export async function executeRepairDurableCompactionCommand(
  command: RepairDurableCompactionCommand,
  dependencies: RepairDurableCompactionDependencies,
): Promise<Record<string, unknown>> {
  if (command.mode === 'help') {
    return { mode: 'help', write_performed: false, usage: REPAIR_DURABLE_COMPACTION_HELP }
  }
  if (command.mode === 'dry-run' || command.mode === 'prepare') {
    return preparationReport(command, dependencies)
  }
  const { job, project } = await loadAuthorizedJob(command.jobId, dependencies)
  if (command.mode === 'status') {
    return {
      mode: 'status',
      write_performed: false,
      verification: { owner: 'verified', team: 'verified', model_alias: 'verified' },
      job: publicJobStatus(job),
    }
  }

  await assertQuiescentRepairAuthority(project, dependencies)
  const owner: CompactionContextOwner = {
    kind: 'conversation',
    conversationId: job.conversation_id,
    userId: job.user_id,
  }
  const active = await dependencies.getActiveJob(owner)
  if (!active || active.job_id !== job.job_id) {
    throw new Error('The requested CompactionJob is not the active Conversation barrier.')
  }
  if (active.status !== 'queued') {
    throw new Error(`CompactionJob cannot be activated from status ${active.status}.`)
  }
  if (active.lease) {
    throw new Error(
      'CompactionJob is queued but already claimed or leased; activation was refused and manual intervention is required.',
    )
  }
  const activated = await dependencies.activate({
    jobId: job.job_id,
    owner,
    idempotencyKey: command.idempotencyKey,
  })
  return {
    mode: 'activate',
    write_performed: activated.changed,
    verification: {
      owner: 'verified',
      team: 'verified',
      model_alias: 'verified',
      active_run: 'none',
      context_fence: 'none',
      active_job: 'exact',
      command_identity: 'verified',
    },
    job: publicJobStatus(activated.job),
  }
}

export async function createDefaultRepairDurableCompactionDependencies(): Promise<
  RepairDurableCompactionDependencies
> {
  const [
    { Conversation },
    { ConversationRuntime },
    { AgentSessionRuntimeModel, AgentTeamModel, TeamAgentModel },
    agentRuntimeRepository,
    compactionRepository,
    { connectDB },
    { ModelConfig },
    llmConfig,
    { resolveAuthoritativeModelSnapshot },
  ] = await Promise.all([
    import('../lib/db/models'),
    import('../lib/agent-runtime/models'),
    import('../lib/agent-team/models'),
    import('../lib/agent-runtime/repository'),
    import('../lib/agent-compaction/repository'),
    import('../lib/db/mongodb'),
    import('../lib/db/model-config-models'),
    import('../lib/llm-config'),
    import('../lib/llm-registry'),
  ])
  await connectDB()

  type OperatorRegistrySource = {
    aliases?: Record<string, OperatorAliasConfig>
    defaultMainAlias?: Partial<Record<RepairUserSnapshot['plan'], string>>
    high_cost_aliases_disabled?: string[]
  }
  const loadOperatorRegistry = async (): Promise<OperatorRegistrySnapshot> => {
    // Resolve policy and immutable model mapping from the same authoritative
    // document. Re-read for post-enqueue validation instead of retaining the
    // application's stale-while-revalidate cache across the operator command.
    const document = await ModelConfig.findOne({ config_key: 'main' })
      .lean<OperatorRegistrySource>()
    const hasDbRegistry = Boolean(
      document?.aliases && Object.keys(document.aliases).length > 0,
    )
    const seed = hasDbRegistry
      ? document!
      : JSON.parse(fs.readFileSync(
          path.join(process.cwd(), 'config', 'llm-registry.json'),
          'utf8',
        )) as OperatorRegistrySource
    if (!seed.aliases || !seed.defaultMainAlias) {
      throw new Error('Authoritative model registry is incomplete.')
    }
    const disabled = seed.high_cost_aliases_disabled ?? []
    return {
      aliases: seed.aliases,
      defaultMainAlias: seed.defaultMainAlias,
      disabledAliases: new Set(disabled),
    }
  }

  return {
    now: () => new Date(),
    async loadConversation(conversationId) {
      const value = await Conversation.findOne({ conversation_id: conversationId })
        .select(
          'conversation_id user_id settings.orchestrator_model messages compacted_messages context_revision context_compaction_fence',
        )
        .lean<{
          conversation_id: string
          user_id: string
          settings?: { orchestrator_model?: string }
          messages?: ConversationMessage[]
          compacted_messages?: ConversationMessage[]
          context_revision?: number
          context_compaction_fence?: unknown
        }>()
      return value
        ? {
            conversationId: value.conversation_id,
            userId: value.user_id,
            requestedAlias: value.settings?.orchestrator_model,
            messages: value.messages ?? [],
            compactedMessages: value.compacted_messages ?? [],
            contextRevision: value.context_revision ?? 0,
            contextFence: value.context_compaction_fence ?? null,
          }
        : null
    },
    async loadRuntime(conversationId, userId) {
      const value = await ConversationRuntime.findOne({
        conversation_id: conversationId,
        user_id: userId,
      }).select('active_run_id active_lease_owner_id project_context_snapshot').lean<{
        active_run_id?: string | null
        active_lease_owner_id?: string | null
        project_context_snapshot?: FrozenProjectContextSnapshot | null
      }>()
      return value
        ? {
            activeRunId: value.active_run_id ?? null,
            activeLeaseOwnerId: value.active_lease_owner_id ?? null,
            projectContextSnapshot: value.project_context_snapshot ?? null,
          }
        : null
    },
    async loadTeam(conversationId, userId) {
      const value = await AgentTeamModel.findOne({
        conversation_id: conversationId,
        user_id: userId,
      }).select(
        'team_id conversation_id user_id root_agent_id workspace_id status',
      ).lean<{
        team_id: string
        conversation_id: string
        user_id: string
        root_agent_id: string
        workspace_id: string
        status: 'active' | 'completed'
      }>()
      return value
        ? {
            teamId: value.team_id,
            conversationId: value.conversation_id,
            userId: value.user_id,
            rootAgentId: value.root_agent_id,
            workspaceId: value.workspace_id,
            status: value.status,
          }
        : null
    },
    async loadRootAgent(team) {
      const value = await TeamAgentModel.findOne({
        team_id: team.teamId,
        user_id: team.userId,
        agent_id: team.rootAgentId,
      }).select(
        'agent_id team_id conversation_id user_id is_root status generation current_session_id',
      ).lean<{
        agent_id: string
        team_id: string
        conversation_id: string
        user_id: string
        is_root: boolean
        status: RepairRootAgentSnapshot['status']
        generation: number
        current_session_id: string
      }>()
      return value
        ? {
            agentId: value.agent_id,
            teamId: value.team_id,
            conversationId: value.conversation_id,
            userId: value.user_id,
            isRoot: value.is_root,
            status: value.status,
            generation: value.generation,
            currentSessionId: value.current_session_id,
          }
        : null
    },
    async loadRootSession(team, root) {
      const value = await AgentSessionRuntimeModel.findOne({
        session_id: root.currentSessionId,
        team_id: team.teamId,
        conversation_id: team.conversationId,
        user_id: team.userId,
        agent_id: root.agentId,
        generation: root.generation,
      }).select(
        'session_id team_id conversation_id user_id agent_id generation active_run_id active_lease_owner_id run_lease',
      ).lean<{
        session_id: string
        team_id: string
        conversation_id: string
        user_id: string
        agent_id: string
        generation: number
        active_run_id?: string | null
        active_lease_owner_id?: string | null
        run_lease?: unknown
      }>()
      return value
        ? {
            sessionId: value.session_id,
            teamId: value.team_id,
            conversationId: value.conversation_id,
            userId: value.user_id,
            agentId: value.agent_id,
            generation: value.generation,
            activeRunId: value.active_run_id ?? null,
            activeLeaseOwnerId: value.active_lease_owner_id ?? null,
            runLease: value.run_lease ?? null,
          }
        : null
    },
    async resolveAlias(user, requestedAlias) {
      const operatorRegistry = await loadOperatorRegistry()
      const forced = user.forcedMainAlias?.trim()
      if (forced && !operatorRegistry.aliases[forced]) {
        throw new Error('The owner forced model alias is absent from the authoritative registry.')
      }
      const requested = requestedAlias?.trim()
      const requestedConfig = requested ? operatorRegistry.aliases[requested] : undefined
      const requestedAllowed = Boolean(
        requestedConfig
        && !operatorRegistry.disabledAliases.has(requested!)
        && Array.isArray(requestedConfig.availableToPlans)
        && requestedConfig.availableToPlans.includes(user.plan),
      )
      const alias = forced
        ?? (requestedAllowed ? requested : undefined)
        ?? operatorRegistry.defaultMainAlias[user.plan]
      if (!alias) throw new Error(`No default main model alias exists for plan ${user.plan}.`)
      const config = operatorRegistry.aliases[alias]
      if (!config || typeof config.realModel !== 'string' || !config.realModel.trim()) {
        throw new Error('Selected model alias does not resolve to a frozen model ID.')
      }
      if (config.keyChannel !== 'orchestrator' && config.keyChannel !== 'tools') {
        throw new Error('Selected model alias has an invalid key channel.')
      }
      const configuredKey = config.keyChannel === 'orchestrator'
        ? llmConfig.LLM_API_KEY_ORCHESTRATOR
        : llmConfig.LLM_API_KEY_TOOLS
      if (!configuredKey) {
        throw new Error(`API key is not configured for the selected model alias channel.`)
      }
      if (
        typeof config.contextWindow !== 'number'
        || !Number.isSafeInteger(config.contextWindow)
        || config.contextWindow <= 0
        || typeof config.maxOutputTokens !== 'number'
        || !Number.isSafeInteger(config.maxOutputTokens)
        || config.maxOutputTokens <= 0
        || typeof config.compactionMaxOutputTokens !== 'number'
        || !Number.isSafeInteger(config.compactionMaxOutputTokens)
        || config.compactionMaxOutputTokens <= 0
        || !['5m', '1h', 'none'].includes(String(config.promptCacheTtl))
      ) {
        throw new Error('Selected model alias lacks explicit compaction capacity metadata.')
      }
      const modelResolutionSnapshot = await resolveAuthoritativeModelSnapshot(alias)
      if (
        modelResolutionSnapshot.real_model !== config.realModel
        || modelResolutionSnapshot.key_channel !== config.keyChannel
        || modelResolutionSnapshot.supports_vision !== (config.supportsVision === true)
        || modelResolutionSnapshot.context_window !== config.contextWindow
        || modelResolutionSnapshot.max_output_tokens !== config.maxOutputTokens
        || modelResolutionSnapshot.compaction_max_output_tokens
          !== config.compactionMaxOutputTokens
        || modelResolutionSnapshot.prompt_cache_ttl !== config.promptCacheTtl
      ) {
        throw new Error('Authoritative model registry changed during operator resolution; retry.')
      }
      return {
        alias,
        modelResolutionSnapshot,
      }
    },
    async getActiveRun(conversationId, userId) {
      const run = await agentRuntimeRepository.getActiveAgentRun(conversationId, userId)
      if (run) return { runId: run.run_id }
      // A stale or mid-transition runtime pointer is still an unsafe repair
      // boundary even if the AgentRun active-key lookup briefly finds nothing.
      const runtime = await ConversationRuntime.findOne({
        conversation_id: conversationId,
        user_id: userId,
        $or: [
          { active_run_id: { $type: 'string' } },
          { active_lease_owner_id: { $type: 'string' } },
        ],
      }).select('active_run_id active_lease_owner_id').lean<{
        active_run_id?: string | null
        active_lease_owner_id?: string | null
      }>()
      if (!runtime) return null
      return {
        // Do not print the lease owner. This sentinel only preserves the
        // existing boolean dependency contract while failing closed.
        runId: runtime.active_run_id ?? 'conversation-runtime-lease-present',
      }
    },
    getActiveJob: compactionRepository.getActiveCompactionForOwner,
    getJob: compactionRepository.getDurableCompactionJob,
    enqueue: compactionRepository.enqueueDurableCompaction,
    activate: compactionRepository.activateUnclaimedQueuedDurableCompactionJob,
    cancelPrepared: compactionRepository.cancelUnclaimedQueuedDurableCompactionJob,
  }
}
