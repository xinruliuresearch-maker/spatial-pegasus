import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { AgentRun, type AgentRunDocument } from './models'
import {
  AGENT_RUNNER_LEASE_OWNER_HEADER,
  AGENT_RUNNER_RUN_ID_HEADER,
  AGENT_RUNNER_SIGNATURE_HEADER,
} from './internal-dispatch-envelope'
import {
  databaseRetryDelayMs,
  shouldLogDatabaseFailure,
} from '../db/retry-policy'
import {
  fatalAgentRunFailure,
  persistedFailureSignature,
} from './failure-policy'
import { inspectRunCompactionBarrier } from './compaction-barrier'

const DEFAULT_POLL_MS = 1_000
const RETRY_AFTER_DISPATCH_FAILURE_MS = 2_000
const TEAM_LEASE_HEARTBEAT_MS = 15_000
const DEFAULT_ROOT_SUPERVISION_FAILURE_THRESHOLD = 3

export interface TeamExecutionLeases {
  executionFenceToken: string
  sessionFenceToken: string
}

interface TeamExecutionIdentitySnapshot {
  teamStatus: 'active' | 'completed' | null
  teamConversationId: string | null
  agentStatus: 'running' | 'idle' | 'paused' | 'completed' | 'failed' | null
  currentSessionId: string | null
}

type TeamExecutionLeaseAcquisition =
  | { kind: 'not_required' }
  | { kind: 'acquired'; leases: TeamExecutionLeases }
  | { kind: 'capacity' }
  | { kind: 'ineligible'; error: string }

interface AgentRunnerGlobalState {
  ownerPrefix: string
  running: boolean
  wakeCallback: (() => void) | null
  stopRequested: boolean
  loopPromise: Promise<void> | null
  wakeResolver: (() => void) | null
  mongoFailureCount: number
  mongoRetryAfter: number
  mongoOutageStartedAt: number | null
  mongoLastLogAt: number | null
  inFlight: Map<string, Promise<void>>
}

// Next.js may evaluate this module through more than one route bundle in
// development. Keep the process token and worker state on globalThis so the
// loopback request is recognized by the route bundle that receives it.
const state: AgentRunnerGlobalState =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ((globalThis as any).__sci_pegasus_agent_runner_state ??= {
    ownerPrefix: `runner:${process.pid}:${randomUUID()}`,
    running: false,
    wakeCallback: null,
    stopRequested: false,
    loopPromise: null,
    wakeResolver: null,
    mongoFailureCount: 0,
    mongoRetryAfter: 0,
    mongoOutageStartedAt: null,
    mongoLastLogAt: null,
    inFlight: new Map<string, Promise<void>>(),
  })

// Development hot reload can reuse a global created by an older module shape.
state.mongoFailureCount ??= 0
state.mongoRetryAfter ??= 0
state.mongoOutageStartedAt ??= null
state.mongoLastLogAt ??= null
state.inFlight ??= new Map<string, Promise<void>>()

function configuredWorkerCount(): number {
  const parsed = Number.parseInt(process.env.AGENT_RUNTIME_WORKERS || '50', 10)
  return Number.isFinite(parsed) ? Math.max(1, Math.min(50, parsed)) : 50
}

function noteMongoFailure(error: unknown, operation: string): number {
  const now = Date.now()
  state.mongoFailureCount += 1
  state.mongoOutageStartedAt ??= now
  const retryMs = databaseRetryDelayMs(state.mongoFailureCount)
  state.mongoRetryAfter = now + retryMs
  if (shouldLogDatabaseFailure(state.mongoFailureCount, state.mongoLastLogAt, now)) {
    const attempts = state.mongoFailureCount > 1
      ? ` (${state.mongoFailureCount} failed polls)`
      : ''
    console.error(
      `[agent-runner] Mongo unavailable while ${operation}${attempts}; `
      + `retrying in ${Math.ceil(retryMs / 1_000)}s: ${(error as Error).message}`,
    )
    state.mongoLastLogAt = now
  }
  return retryMs
}

function noteMongoLeaseSuccess(): void {
  if (state.mongoFailureCount === 0) return
  const unavailableMs = state.mongoOutageStartedAt === null
    ? 0
    : Date.now() - state.mongoOutageStartedAt
  console.info(
    `[agent-runner] Mongo connection restored after ${Math.max(1, Math.round(unavailableMs / 1_000))}s; `
    + 'lease polling resumed',
  )
  state.mongoFailureCount = 0
  state.mongoRetryAfter = 0
  state.mongoOutageStartedAt = null
  state.mongoLastLogAt = null
}

function internalSigningSecret(): string | null {
  return process.env.AGENT_RUNTIME_INTERNAL_SECRET?.trim()
    || null
}

function internalSignaturePayload(runId: string, leaseOwnerId: string): string {
  return JSON.stringify([1, runId, leaseOwnerId])
}

export function createInternalAgentRunnerSignature(
  runId: string,
  leaseOwnerId: string,
): string | null {
  const secret = internalSigningSecret()
  if (!secret) return null
  return createHmac('sha256', secret)
    .update(internalSignaturePayload(runId, leaseOwnerId))
    .digest('hex')
}

export function isAgentRunnerEnabled(): boolean {
  return process.env.AGENT_RUNTIME_BACKGROUND_RUNNER === '1'
    && internalSigningSecret() !== null
    && state.wakeCallback !== null
}

export function registerAgentRunnerWake(callback: (() => void) | null): void {
  state.wakeCallback = callback
}

export function wakeAgentRunner(): void {
  state.wakeCallback?.()
}

export function isInternalAgentRunnerRequest(
  signature: string | null,
  runId: string,
  leaseOwnerId: string,
): boolean {
  if (!signature || !runId || !leaseOwnerId || !/^[a-f0-9]{64}$/i.test(signature)) {
    return false
  }
  const expected = createInternalAgentRunnerSignature(runId, leaseOwnerId)
  if (!expected) return false
  const receivedBytes = Buffer.from(signature, 'hex')
  const expectedBytes = Buffer.from(expected, 'hex')
  return receivedBytes.length === expectedBytes.length
    && timingSafeEqual(receivedBytes, expectedBytes)
}

export function isLocalAgentRunnerOwner(ownerId: string | null | undefined): boolean {
  return typeof ownerId === 'string' && ownerId.startsWith(`${state.ownerPrefix}:`)
}

function runnerBaseUrl(): string {
  const configured = process.env.AGENT_RUNTIME_INTERNAL_BASE_URL?.trim()
  if (configured) return configured.replace(/\/+$/, '')
  return `http://127.0.0.1:${process.env.PORT?.trim() || '3200'}`
}

function wakeOrTimeout(timeoutMs: number): Promise<void> {
  return new Promise(resolve => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      if (state.wakeResolver === finish) state.wakeResolver = null
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(finish, timeoutMs)
    // Keep one referenced timer while the durable Runner is enabled. Next.js
    // instrumentation may otherwise become quiescent after startup and an
    // unref'ed poll timer is not a reliable execution anchor for the lease
    // loop. stopAgentRunner() wakes the resolver and clears this timer, so the
    // referenced handle does not delay graceful shutdown.
    state.wakeResolver = finish
  })
}

async function drainResponse(response: Response): Promise<void> {
  if (!response.body) return
  const reader = response.body.getReader()
  while (true) {
    const { done } = await reader.read()
    if (done) return
  }
}

/**
 * Distinguish permanent Team identity drift from ordinary slot pressure. A
 * queued Run tied to a closed/paused Agent (or an old Agent generation) can
 * never become runnable by waiting for capacity, so the Runner must terminate
 * that exact leased Run instead of putting it back on the hot queue forever.
 */
export function teamRunExecutionIneligibility(
  run: Pick<AgentRunDocument,
    'run_id' | 'conversation_id' | 'team_id' | 'agent_id' | 'agent_session_id'>,
  snapshot: TeamExecutionIdentitySnapshot,
): string | null {
  if (snapshot.teamStatus === null) {
    return `Agent Run ${run.run_id} references a Team that no longer exists.`
  }
  if (snapshot.teamStatus !== 'active') {
    return `Agent Run ${run.run_id} references a Team that is ${snapshot.teamStatus}.`
  }
  if (snapshot.teamConversationId !== run.conversation_id) {
    return `Agent Run ${run.run_id} Team identity belongs to a different Conversation.`
  }
  if (snapshot.agentStatus === null) {
    return `Agent Run ${run.run_id} references a TeamAgent that no longer exists.`
  }
  if (snapshot.agentStatus !== 'idle' && snapshot.agentStatus !== 'running') {
    return `Agent Run ${run.run_id} cannot execute because its TeamAgent is ${snapshot.agentStatus}.`
  }
  if (snapshot.currentSessionId !== run.agent_session_id) {
    return `Agent Run ${run.run_id} references a stale TeamAgent session.`
  }
  return null
}

async function loadTeamExecutionIdentity(
  run: Pick<AgentRunDocument,
    'conversation_id' | 'user_id' | 'team_id' | 'agent_id'>,
): Promise<TeamExecutionIdentitySnapshot> {
  const { connectDB } = await import('../db/mongodb')
  const { AgentTeamModel, TeamAgentModel } = await import('../agent-team/models')
  await connectDB()
  const [team, agent] = await Promise.all([
    AgentTeamModel.findOne({
      team_id: run.team_id,
      user_id: run.user_id,
    }).select('status conversation_id').lean<{
      status: 'active' | 'completed'
      conversation_id: string
    }>(),
    TeamAgentModel.findOne({
      team_id: run.team_id,
      user_id: run.user_id,
      agent_id: run.agent_id,
    }).select('status current_session_id').lean<{
      status: 'running' | 'idle' | 'paused' | 'completed' | 'failed'
      current_session_id: string
    }>(),
  ])
  return {
    teamStatus: team?.status ?? null,
    teamConversationId: team?.conversation_id ?? null,
    agentStatus: agent?.status ?? null,
    currentSessionId: agent?.current_session_id ?? null,
  }
}

/** Owner-fenced terminalization for a permanently unrunnable Team Run. */
export async function failIneligibleTeamRun(
  run: AgentRunDocument,
  ownerId: string,
  error: string,
): Promise<boolean> {
  const {
    isRunCancellationRequested,
    setRunStatus,
  } = await import('./repository')
  const cancelled = await isRunCancellationRequested(run.run_id)
  const stored = await setRunStatus(
    run.run_id,
    cancelled ? 'cancelled' : 'failed',
    {
      terminationReason: cancelled ? 'user_cancelled' : 'runtime_error',
      error,
      ...(!cancelled ? fatalAgentRunFailure(error, 'identity_invariant') : {}),
      releaseActive: true,
      leaseOwnerId: ownerId,
    },
  )
  if (!stored) return false
  const { releaseQueuedMessagesForRun } = await import('../agent/message-queue')
  await releaseQueuedMessagesForRun(run.run_id)
  return true
}

/**
 * Apply the durable context barrier to this exact leased Run. A defer keeps
 * the same Run/input identity and releases its lease; a terminal Job failure
 * opens an explicit persisted circuit. Either outcome forbids HTTP dispatch.
 */
export async function enforceRunCompactionBarrier(
  run: AgentRunDocument,
  ownerId: string,
): Promise<'open' | 'stopped'> {
  const decision = await inspectRunCompactionBarrier(run)
  if (decision.kind === 'open') return 'open'

  const repository = await import('./repository')
  if (decision.kind === 'defer') {
    await repository.deferAgentRunForCompactionBarrier(
      run.run_id,
      ownerId,
      decision.retryAt,
    )
    return 'stopped'
  }

  const stored = await repository.failAgentRunForCompactionBarrier(
    run.run_id,
    ownerId,
    decision.error,
  )
  if (stored) {
    console.error(`[agent-runner] context compaction circuit opened: ${decision.error}`)
  }
  return 'stopped'
}

async function acquireTeamExecutionLeases(
  run: AgentRunDocument,
  ownerId: string,
): Promise<TeamExecutionLeaseAcquisition> {
  const hasAnyTeamIdentity = Boolean(
    run.team_id || run.agent_id || run.agent_session_id,
  )
  if (!hasAnyTeamIdentity) return { kind: 'not_required' }
  if (!run.team_id || !run.agent_id || !run.agent_session_id) {
    return {
      kind: 'ineligible',
      error: `Agent Run ${run.run_id} has an incomplete Team execution identity.`,
    }
  }

  const teamRepository = await import('../agent-team/repository')
  const initialIneligibility = teamRunExecutionIneligibility(
    run,
    await loadTeamExecutionIdentity(run),
  )
  if (initialIneligibility) {
    return { kind: 'ineligible', error: initialIneligibility }
  }
  const slot = await teamRepository.claimExecutionSlot({
    teamId: run.team_id,
    userId: run.user_id,
    agentId: run.agent_id,
    sessionId: run.agent_session_id,
    runId: run.run_id,
    ownerId,
  })
  if (!slot) {
    // claimExecutionSlot intentionally returns null for both capacity pressure
    // and a Team identity race. Re-sample identity before deciding to defer.
    const racedIneligibility = teamRunExecutionIneligibility(
      run,
      await loadTeamExecutionIdentity(run),
    )
    return racedIneligibility
      ? { kind: 'ineligible', error: racedIneligibility }
      : { kind: 'capacity' }
  }

  const session = await teamRepository.claimAgentSessionRun({
    teamId: run.team_id,
    userId: run.user_id,
    sessionId: run.agent_session_id,
    runId: run.run_id,
    ownerId,
  })
  const sessionFenceToken = session?.run_lease?.fence_token
  if (!session || !sessionFenceToken) {
    await teamRepository.releaseExecutionSlot({
      runId: run.run_id,
      ownerId,
      fenceToken: slot.fence_token,
    })
    const racedIneligibility = teamRunExecutionIneligibility(
      run,
      await loadTeamExecutionIdentity(run),
    )
    return racedIneligibility
      ? { kind: 'ineligible', error: racedIneligibility }
      : { kind: 'capacity' }
  }

  return {
    kind: 'acquired',
    leases: {
      executionFenceToken: slot.fence_token,
      sessionFenceToken,
    },
  }
}

/**
 * Choose the persistent Agent identity state after one Run. Member failures
 * retain the historical failed-Agent behavior. Root failures use the explicit
 * persisted recoverability decision: one transient provider/message/runtime
 * failure is contained, while configuration and identity/invariant failures
 * remain fatal. Legacy automatic supervision Runs retain their old fallback.
 *
 * Team/session identity failures never reach this classifier: they are
 * terminalized by teamRunExecutionIneligibility/failIneligibleTeamRun before
 * an execution lease is acquired.
 */
export function teamAgentStatusAfterRun(
  run: Pick<AgentRunDocument, 'trigger' | 'execution_mode' | 'root_visible'>,
  finalRun: Pick<AgentRunDocument, 'status' | 'failure_recoverability'> | null,
): 'idle' | 'failed' {
  if (finalRun?.status !== 'failed') return 'idle'
  const publicRootRun = run.execution_mode === 'conversation' && run.root_visible !== false
  if (!publicRootRun) return 'failed'
  if (finalRun.failure_recoverability === 'fatal') return 'failed'
  if (finalRun.failure_recoverability === 'transient') return 'idle'
  // Legacy failed Runs predate explicit failure metadata. Preserve containment
  // only for automatic supervision; public legacy failures retain their
  // historical stronger state until a new, classified Run succeeds.
  return run.trigger === 'supervision' ? 'idle' : 'failed'
}

export interface TeamAgentReleaseDecision {
  status: 'idle' | 'failed'
  transitionReason?:
    | 'supervision_run_failed'
    | 'run_failure_contained'
    | 'supervision_failure_circuit_open'
    | 'fatal_run_failure'
  consecutiveFailures?: number
}

function configuredRootSupervisionFailureThreshold(): number {
  const parsed = Number.parseInt(
    process.env.ROOT_SUPERVISION_FAILURE_THRESHOLD
      ?? String(DEFAULT_ROOT_SUPERVISION_FAILURE_THRESHOLD),
    10,
  )
  return Number.isFinite(parsed) ? Math.max(2, Math.min(10, parsed)) : DEFAULT_ROOT_SUPERVISION_FAILURE_THRESHOLD
}

/**
 * Convert explicit failure metadata into an Agent identity transition. Three
 * consecutive automatic supervision failures with the same normalized
 * signature open a durable circuit by leaving Root failed. A user turn (or a
 * successful/different supervision turn) breaks the consecutive sequence.
 */
export async function teamAgentReleaseDecisionAfterRun(
  run: Pick<AgentRunDocument,
    'sequence' | 'team_id' | 'agent_id' | 'trigger' | 'execution_mode' | 'root_visible'>,
  finalRun: Pick<AgentRunDocument,
    'status' | 'trigger' | 'failure_recoverability' | 'failure_category' | 'failure_signature' | 'last_error' | 'termination_reason'> | null,
  threshold = configuredRootSupervisionFailureThreshold(),
): Promise<TeamAgentReleaseDecision> {
  const baseStatus = teamAgentStatusAfterRun(run, finalRun)
  if (finalRun?.status !== 'failed') return { status: baseStatus }
  if (baseStatus === 'failed') {
    return {
      status: 'failed',
      transitionReason: finalRun.failure_recoverability === 'fatal'
        ? 'fatal_run_failure'
        : undefined,
    }
  }
  if (
    run.trigger !== 'supervision'
    || run.execution_mode !== 'conversation'
    || run.root_visible === false
    || !run.team_id
    || !run.agent_id
  ) {
    return { status: 'idle', transitionReason: 'run_failure_contained' }
  }

  const signature = persistedFailureSignature(finalRun)
  const boundedThreshold = Math.max(2, Math.min(10, threshold))
  const recent = await AgentRun.find({
    team_id: run.team_id,
    agent_id: run.agent_id,
    sequence: { $lte: run.sequence },
    execution_mode: 'conversation',
    root_visible: { $ne: false },
  }).sort({ sequence: -1 }).limit(boundedThreshold).select(
    'status trigger failure_recoverability failure_category failure_signature last_error termination_reason',
  ).lean<Array<Pick<AgentRunDocument,
    'status' | 'trigger' | 'failure_recoverability' | 'failure_category' | 'failure_signature' | 'last_error' | 'termination_reason'>>>()

  let consecutiveFailures = 0
  for (const candidate of recent) {
    const candidateTransient = candidate.failure_recoverability === 'transient'
      || (candidate.failure_recoverability == null && candidate.trigger === 'supervision')
    if (
      candidate.status !== 'failed'
      || candidate.trigger !== 'supervision'
      || !candidateTransient
      || persistedFailureSignature(candidate) !== signature
    ) break
    consecutiveFailures += 1
  }
  if (consecutiveFailures >= boundedThreshold) {
    return {
      status: 'failed',
      transitionReason: 'supervision_failure_circuit_open',
      consecutiveFailures,
    }
  }
  return {
    status: 'idle',
    transitionReason: 'supervision_run_failed',
    consecutiveFailures,
  }
}

export async function releaseTeamExecutionLeases(
  run: AgentRunDocument,
  ownerId: string,
  leases: TeamExecutionLeases | undefined,
): Promise<void> {
  if (!leases || !run.agent_session_id) return
  const teamRepository = await import('../agent-team/repository')
  const { getAgentRun } = await import('./repository')
  const finalRun = await getAgentRun(run.run_id, run.user_id)
  const releaseDecision = await teamAgentReleaseDecisionAfterRun(run, finalRun)
  const nextAgentStatus = releaseDecision.status
  await Promise.allSettled([
    teamRepository.releaseAgentSessionRun({
      sessionId: run.agent_session_id,
      runId: run.run_id,
      ownerId,
      fenceToken: leases.sessionFenceToken,
      nextAgentStatus,
      ...(finalRun?.status === 'failed' && releaseDecision.transitionReason
        ? { transitionReason: releaseDecision.transitionReason }
        : {}),
    }),
    teamRepository.releaseExecutionSlot({
      runId: run.run_id,
      ownerId,
      fenceToken: leases.executionFenceToken,
    }),
  ])
  // A member owns one Run at a time. Queue its next ready task only after both
  // leases have been released; doing this inside the HTTP executor races the
  // Runner heartbeat and can abort an otherwise successful response. Durable
  // waits remain the active session Run, failures require supervision, and
  // interrupted/closed Agents are filtered by scheduleNextAgentTask itself.
  if (
    run.execution_mode === 'agent_session'
    && finalRun?.status === 'completed'
    && run.team_id
    && run.agent_id
  ) {
    const { scheduleNextAgentTask } = await import('../agent-team/orchestrator')
    await scheduleNextAgentTask({
      teamId: run.team_id,
      userId: run.user_id,
      agentId: run.agent_id,
    }).catch(error => {
      console.error('[agent-runner] failed to schedule next member task:', (error as Error).message)
    })
  }
}

async function dispatchClaimedRun(run: AgentRunDocument, ownerId: string): Promise<void> {
  // First check happens before the Run consumes a Team execution slot/session
  // lease. New input remains persisted on this same Run while compaction owns
  // the context window.
  if (await enforceRunCompactionBarrier(run, ownerId) === 'stopped') return

  const signature = createInternalAgentRunnerSignature(run.run_id, ownerId)
  if (!signature) {
    const { requeueAgentRunAfterDispatchFailure } = await import('./repository')
    await requeueAgentRunAfterDispatchFailure(
      run.run_id,
      ownerId,
      'Agent Runner internal signing secret is not configured.',
    )
    return
  }
  let teamLeases: TeamExecutionLeases | undefined
  try {
    const acquired = await acquireTeamExecutionLeases(run, ownerId)
    if (acquired.kind === 'ineligible') {
      const stored = await failIneligibleTeamRun(run, ownerId, acquired.error)
      if (stored) {
        console.error(`[agent-runner] terminalized unrunnable Team Run: ${acquired.error}`)
      }
      return
    }
    if (acquired.kind === 'capacity') {
      const { deferAgentRunForExecutionCapacity } = await import('./repository')
      await deferAgentRunForExecutionCapacity(run.run_id, ownerId)
      return
    }
    teamLeases = acquired.kind === 'acquired' ? acquired.leases : undefined
  } catch (error) {
    const { requeueAgentRunAfterDispatchFailure } = await import('./repository')
    await requeueAgentRunAfterDispatchFailure(
      run.run_id,
      ownerId,
      `Team execution lease failed: ${(error as Error).message}`,
    )
    return
  }

  const teamLeaseAbort = new AbortController()
  let teamHeartbeatRunning = false
  const teamHeartbeat = teamLeases && run.agent_session_id
    ? setInterval(() => {
        if (teamHeartbeatRunning) return
        teamHeartbeatRunning = true
        void import('../agent-team/repository').then(async teamRepository => {
          const [slotAlive, sessionAlive] = await Promise.all([
            teamRepository.heartbeatExecutionSlot({
              runId: run.run_id,
              ownerId,
              fenceToken: teamLeases!.executionFenceToken,
            }),
            teamRepository.heartbeatAgentSessionRun({
              sessionId: run.agent_session_id!,
              runId: run.run_id,
              ownerId,
              fenceToken: teamLeases!.sessionFenceToken,
            }),
          ])
          if (!slotAlive || !sessionAlive) {
            teamLeaseAbort.abort('agent_team_lease_lost')
          }
        }).catch(error => {
          console.error('[agent-runner] team lease heartbeat failed:', (error as Error).message)
        }).finally(() => {
          teamHeartbeatRunning = false
        })
      }, TEAM_LEASE_HEARTBEAT_MS)
    : null
  teamHeartbeat?.unref()

  // A compaction can be handed off after the first read while this Run is
  // acquiring Team leases. Re-read immediately before dispatch; on a race,
  // return the Run to its durable queue and release both Team fences.
  try {
    if (await enforceRunCompactionBarrier(run, ownerId) === 'stopped') {
      if (teamHeartbeat) clearInterval(teamHeartbeat)
      await releaseTeamExecutionLeases(run, ownerId, teamLeases)
      return
    }
  } catch (error) {
    if (teamHeartbeat) clearInterval(teamHeartbeat)
    await releaseTeamExecutionLeases(run, ownerId, teamLeases)
    throw error
  }

  let response: Response
  try {
    const executionPath = run.execution_mode === 'agent_session'
      ? '/api/agent-team/execute'
      : '/api/chat'
    response = await fetch(`${runnerBaseUrl()}${executionPath}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [AGENT_RUNNER_SIGNATURE_HEADER]: signature,
        [AGENT_RUNNER_RUN_ID_HEADER]: run.run_id,
        [AGENT_RUNNER_LEASE_OWNER_HEADER]: ownerId,
      },
      body: JSON.stringify({
        run_id: run.run_id,
        lease_owner_id: ownerId,
        team_execution_fence_token: teamLeases?.executionFenceToken,
        agent_session_fence_token: teamLeases?.sessionFenceToken,
      }),
      signal: teamLeaseAbort.signal,
    })
  } catch (error) {
    const { requeueAgentRunAfterDispatchFailure } = await import('./repository')
    await requeueAgentRunAfterDispatchFailure(
      run.run_id,
      ownerId,
      `Runner could not dispatch the durable executor: ${(error as Error).message}`,
    )
    await wakeOrTimeout(RETRY_AFTER_DISPATCH_FAILURE_MS)
    if (teamHeartbeat) clearInterval(teamHeartbeat)
    await releaseTeamExecutionLeases(run, ownerId, teamLeases)
    return
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    const { requeueAgentRunAfterDispatchFailure } = await import('./repository')
    await requeueAgentRunAfterDispatchFailure(
      run.run_id,
      ownerId,
      `Durable executor rejected dispatch (${response.status}): ${detail.slice(0, 500)}`,
    )
    await wakeOrTimeout(RETRY_AFTER_DISPATCH_FAILURE_MS)
    if (teamHeartbeat) clearInterval(teamHeartbeat)
    await releaseTeamExecutionLeases(run, ownerId, teamLeases)
    return
  }

  try {
    // The internal subscriber keeps the route's SSE writer from becoming an
    // unconsumed backpressure sink. Browser subscribers use the same broadcast
    // when they reconnect on this process; correctness otherwise comes from
    // AgentRun.live and persisted messages.
    await drainResponse(response)
  } catch (error) {
    // A 2xx response means the executor already accepted ownership. Do not
    // requeue here: it may still be running after this transport disconnect.
    // Its lease heartbeat/expiry is the sole takeover authority.
    console.warn('[agent-runner] internal stream detached:', (error as Error).message)
  } finally {
    if (teamHeartbeat) clearInterval(teamHeartbeat)
    await releaseTeamExecutionLeases(run, ownerId, teamLeases)
  }
}

async function runLoop(): Promise<void> {
  while (!state.stopRequested) {
    if (state.inFlight.size >= configuredWorkerCount()) {
      await wakeOrTimeout(DEFAULT_POLL_MS)
      continue
    }
    const remainingBackoffMs = state.mongoRetryAfter - Date.now()
    if (remainingBackoffMs > 0) {
      // wakeAgentRunner() may interrupt the timer when a request arrives, but
      // it must not bypass the database outage backoff. Re-check the absolute
      // deadline before performing another MongoDB operation.
      await wakeOrTimeout(remainingBackoffMs)
      continue
    }
    const ownerId = `${state.ownerPrefix}:${randomUUID()}`
    let run: AgentRunDocument | null = null
    try {
      const { leaseNextAgentRun } = await import('./repository')
      run = await leaseNextAgentRun(ownerId)
      noteMongoLeaseSuccess()
    } catch (error) {
      await wakeOrTimeout(noteMongoFailure(error, 'leasing queued Run'))
      continue
    }

    if (!run) {
      await wakeOrTimeout(DEFAULT_POLL_MS)
      continue
    }
    console.log(`[agent-runner] leased ${run.run_id}`)
    const dispatched = dispatchClaimedRun(run, ownerId).catch(async error => {
      // A dispatch failure can itself fail while being requeued if MongoDB
      // disappears. Do not let that exception terminate the process-wide
      // Runner. The already-persisted lease remains authoritative and will be
      // recovered after expiry; no synthetic dispatch attempt is recorded.
      await wakeOrTimeout(noteMongoFailure(error, `finalizing dispatch for ${run.run_id}`))
    }).finally(() => {
      state.inFlight.delete(run.run_id)
      state.wakeResolver?.()
    })
    state.inFlight.set(run.run_id, dispatched)
  }

  // Graceful shutdown stops leasing new work but allows already accepted
  // executions to drain so their durable leases/checkpoints remain coherent.
  await Promise.allSettled(Array.from(state.inFlight.values()))
}

export function startAgentRunner(): void {
  if (process.env.AGENT_RUNTIME_BACKGROUND_RUNNER !== '1' || state.running) return
  if (!internalSigningSecret()) {
    console.error(
      '[agent-runner] disabled: configure AGENT_RUNTIME_INTERNAL_SECRET',
    )
    return
  }
  state.stopRequested = false
  state.running = true
  registerAgentRunnerWake(() => {
    state.wakeResolver?.()
  })
  state.loopPromise = runLoop().catch(error => {
    console.error('[agent-runner] loop stopped unexpectedly:', (error as Error).message)
  }).finally(() => {
    state.running = false
    state.loopPromise = null
    registerAgentRunnerWake(null)
  })
  wakeAgentRunner()
  console.log(`[agent-runner] Mongo lease runner started (${configuredWorkerCount()} workers)`)
}

export async function stopAgentRunner(): Promise<void> {
  if (!state.running) return
  state.stopRequested = true
  wakeAgentRunner()
  await state.loopPromise
  console.log('[agent-runner] stopped')
}
