import type { ConversationMessage, TokenUsage } from '../types'
import { estimateTokens } from './compaction'

export interface HippocampusTimingProfile {
  mainTps?: number
  compactionTps?: number
  compactionDurationSeconds?: number
  mainOutputTokensPerTurn?: number
  mainContextGrowthTokensPerTurn?: number
  mainContextGrowthPeakTokensPerTurn?: number
}

export interface HippocampusTelemetryState {
  mainTps: number[]
  mainOutputs: number[]
  inputGrowth: number[]
  compactionDurations: number[]
  compactionTps: number[]
  /** Last API-reported complete input for a finished main request. */
  previousInputTokens: number | null
  /** Local estimate of that exact request, used to carry the API correction forward. */
  previousLocalInputTokens: number | null
}

export interface HippocampusBudget {
  contextWindow: number
  staticTokens: number
  mainMaxOutputTokens: number
  /** Largest admitted input while preserving the configured main output. */
  mainInputLimitTokens: number
  summaryMaxTokens: number
  forkInstructionTokens: number
  observationGateTokens: number
  forkPrefixLimitTokens: number
  triggerTokens: number
  rawTriggerTokens: number
  swapTokens: number
  boundaryMarginTokens: number
  expectedMainTurnSeconds: number
  expectedCompactionSeconds: number
  estimatedMainTurnsDuringCompaction: number
  mainContextGrowthTokensPerTurn: number
  maxContextGrowthTokensAtGate: number
  observationGateConstrained: boolean
}

export interface HippocampusSafetyState {
  consecutiveFailures: number
  rapidRefills: number
  turnsSinceMerge: number | null
  breaker: 'consecutive_failures' | 'rapid_refill' | 'prefix_overflow' | null
}

export interface LocalCompactionOutcome {
  summary: string
  wrappedMessage: ConversationMessage
  usage?: TokenUsage
  handedOff?: false
}

export type CompactionOutcome =
  | LocalCompactionOutcome
  | {
      /** The summary is durable; only the CompactionJob may merge it. */
      handedOff: true
      usage?: TokenUsage
    }

export type AsyncCompactionRunner = (
  prefix: readonly ConversationMessage[],
  signal: AbortSignal,
) => Promise<CompactionOutcome>

interface BackgroundTask {
  prefix: readonly ConversationMessage[]
  spliceIndex: number
  prefixTokens: number
  startedAt: number
  done: Promise<void>
  state: BackgroundState
  cancel(reason: string): void
}

type BackgroundState =
  | { phase: 'running' }
  | { phase: 'succeeded'; outcome: LocalCompactionOutcome }
  | { phase: 'handed_off'; usage?: TokenUsage }
  | { phase: 'failed'; reason: string }
  | { phase: 'cancelled'; reason: string }

export interface HippocampusRuntimeEvents {
  /**
   * Runs before the local summary request starts. Callers may persist a
   * delayed durable shadow intent here, so a hard process crash cannot lose
   * the frozen prefix. A persistence failure is reported but does not prevent
   * the bounded local attempt from continuing.
   */
  onStart?: (info: {
    snapshotTokens: number
    spliceIndex: number
    budget: HippocampusBudget
    prefixMessages: readonly ConversationMessage[]
    startedAt: number
    initialAvailableAt: Date
  }) => void | Promise<void>
  onReady?: (info: { durationMs: number; usage?: TokenUsage }) => void
  onDone?: (info: {
    status: 'merged' | 'failed' | 'cancelled'
    durationMs: number
    userWaitMs: number
    compactedTokens?: number
    removedMessages?: number
    reason?: string
  }) => void
  /** Local execution stopped only after a durable owner accepted the frozen prefix. */
  onHandoff?: (info: { durationMs: number; compactedTokens: number; removedMessages: number }) => void
  onBreaker?: (info: { kind: 'consecutive_failures' | 'rapid_refill' | 'prefix_overflow'; detail: string }) => void
}

export interface HippocampusCompactionHandoff {
  prefixMessages: readonly ConversationMessage[]
  prefixTokens: number
  prefixLength: number
  startedAt: number
}

export interface HippocampusLoopExitResult {
  status: 'none' | 'merged' | 'handed_off' | 'failed' | 'cancelled'
  merged: boolean
  reason?: string
}

export interface HippocampusRuntimeConfig {
  contextWindow: number
  staticOverheadTokens: number
  mainMaxOutputTokens: number
  summaryMaxTokens: number
  forkInstructionTokens: number
  compact: AsyncCompactionRunner
  timing: () => HippocampusTimingProfile
  /** Hybrid request estimate: last API truth plus local delta since that request. */
  estimateInputTokens?: (messages: ConversationMessage[]) => number
  events?: HippocampusRuntimeEvents
  /** @deprecated Background ownership is intentionally independent from a Run abort. */
  parentSignal?: AbortSignal
  blockingWaitMs?: number
  backgroundTimeoutMs?: number
  initialSafetyState?: Partial<HippocampusSafetyState> | null
}

export type BeforeRequestAction =
  | 'none'
  | 'started'
  | 'merged'
  | 'sync-fallback'
  | 'durable-handoff'
  | 'breaker'

export interface BeforeRequestResult {
  action: BeforeRequestAction
  tokens: number
  userWaitMs: number
}

const DEFAULT_MAIN_TPS = 80
const DEFAULT_COMPACTION_TPS = 40
const DEFAULT_MAIN_OUTPUT = 500
const DEFAULT_GROWTH = 5_000

function positive(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`hippocampus: ${name} must be > 0`)
  }
  return value
}

export function resolveHippocampusBudget(
  config: Pick<
    HippocampusRuntimeConfig,
    'contextWindow' | 'staticOverheadTokens' | 'mainMaxOutputTokens' | 'summaryMaxTokens' | 'forkInstructionTokens'
  >,
  timing: HippocampusTimingProfile,
): HippocampusBudget {
  const W = positive('contextWindow', config.contextWindow)
  const S = Math.max(0, config.staticOverheadTokens)
  const O = positive('mainMaxOutputTokens', config.mainMaxOutputTokens)
  const R = positive('summaryMaxTokens', config.summaryMaxTokens)
  const I = Math.max(0, config.forkInstructionTokens)
  const mainTps = positive('mainTps', timing.mainTps ?? DEFAULT_MAIN_TPS)
  const compactionTps = positive('compactionTps', timing.compactionTps ?? DEFAULT_COMPACTION_TPS)
  const averageOutput = positive(
    'mainOutputTokensPerTurn',
    timing.mainOutputTokensPerTurn ?? DEFAULT_MAIN_OUTPUT,
  )
  const growth = positive(
    'mainContextGrowthTokensPerTurn',
    timing.mainContextGrowthTokensPerTurn ?? DEFAULT_GROWTH,
  )
  const peakGrowth = Math.max(
    growth,
    positive('mainContextGrowthPeakTokensPerTurn', timing.mainContextGrowthPeakTokensPerTurn ?? growth),
  )

  const mainSeconds = averageOutput / mainTps
  const compactSeconds = timing.compactionDurationSeconds ?? (R / compactionTps)
  const turns = Math.max(1, Math.ceil(compactSeconds / mainSeconds))
  const margin = Math.max(0, Math.ceil(peakGrowth - growth))
  // Context admission is input + output, not input alone. The old boundary at
  // W let the main loop consume the entire window while background compaction
  // was still running, leaving no room for the response that would complete
  // the turn. Reserve the model's configured output capability at every
  // operational boundary.
  const mainInputLimit = W - O
  const B = mainInputLimit - margin
  const Ftime = B - Math.ceil(turns * growth)
  const Fcapacity = Math.min(W - I - R, B)
  const Fraw = Math.min(Ftime, Fcapacity)
  const A = Math.ceil(mainInputLimit * 0.5)
  const F = Math.max(A, Fraw)

  if (mainInputLimit <= S) {
    throw new Error(`hippocampus: main input limit ${mainInputLimit} is not above static overhead ${S}`)
  }
  if (Fcapacity <= S) {
    throw new Error(`hippocampus: fork capacity ${Fcapacity} is not above static overhead ${S}`)
  }
  if (Fcapacity < A) {
    throw new Error(`hippocampus: fork capacity ${Fcapacity} is below observation gate ${A}`)
  }
  // Fraw is an unconstrained timing estimate. On a cold compaction profile it
  // may legitimately fall below the observation gate (or even below zero):
  // for example, after one short main response we know the main-loop latency
  // but still have to conservatively estimate compaction from R / TPS. In
  // that case F is deliberately clamped to A and tool-result admission keeps
  // growth inside the remaining runway. Validate the operational threshold,
  // not the pre-gate estimate, otherwise every second chat request can fail
  // before it reaches the model.
  if (!(F > S && F < B && B <= W)) {
    throw new Error(
      `hippocampus: infeasible async budget static=${S} trigger=${F} swap=${B} window=${W}`,
    )
  }

  return {
    contextWindow: W,
    staticTokens: S,
    mainMaxOutputTokens: O,
    mainInputLimitTokens: mainInputLimit,
    summaryMaxTokens: R,
    forkInstructionTokens: I,
    observationGateTokens: A,
    forkPrefixLimitTokens: Fcapacity,
    triggerTokens: F,
    rawTriggerTokens: Fraw,
    swapTokens: B,
    boundaryMarginTokens: margin,
    expectedMainTurnSeconds: mainSeconds,
    expectedCompactionSeconds: compactSeconds,
    estimatedMainTurnsDuringCompaction: turns,
    mainContextGrowthTokensPerTurn: growth,
    maxContextGrowthTokensAtGate: Math.max(1, Math.floor((B - A) / turns)),
    observationGateConstrained: Fraw < A,
  }
}

function average(values: number[], fallback?: number): number | undefined {
  if (values.length === 0) return fallback
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function pushBounded(values: number[], value: number, max: number): void {
  if (!Number.isFinite(value) || value <= 0) return
  values.push(value)
  if (values.length > max) values.splice(0, values.length - max)
}

/** Rolling runtime evidence. Values are observations, never user-facing knobs. */
export class HippocampusTelemetry {
  private readonly mainTps: number[] = []
  private readonly mainOutputs: number[] = []
  private readonly inputGrowth: number[] = []
  private readonly compactionDurations: number[] = []
  private readonly compactionTps: number[] = []
  private previousInputTokens: number | null = null
  private previousLocalInputTokens: number | null = null

  constructor(initial?: Partial<HippocampusTelemetryState> | null) {
    this.mainTps.push(...(initial?.mainTps ?? []).filter(value => value > 0).slice(-5))
    this.mainOutputs.push(...(initial?.mainOutputs ?? []).filter(value => value > 0).slice(-5))
    this.inputGrowth.push(...(initial?.inputGrowth ?? []).filter(value => value > 0).slice(-5))
    this.compactionDurations.push(
      ...(initial?.compactionDurations ?? []).filter(value => value > 0).slice(-3),
    )
    this.compactionTps.push(...(initial?.compactionTps ?? []).filter(value => value > 0).slice(-3))
    this.previousInputTokens = typeof initial?.previousInputTokens === 'number'
      ? initial.previousInputTokens
      : null
    this.previousLocalInputTokens = typeof initial?.previousLocalInputTokens === 'number'
      ? initial.previousLocalInputTokens
      : null
  }

  /**
   * Commit a completed request as the new accounting anchor. The current
   * in-flight request is estimated locally; once usage arrives, the API total
   * replaces that estimate and its correction is carried into later requests.
   */
  recordMain(
    inputTokens: number,
    localInputTokens: number,
    outputTokens: number,
    durationMs: number,
  ): void {
    pushBounded(this.mainOutputs, outputTokens, 5)
    if (durationMs > 0) pushBounded(this.mainTps, outputTokens / (durationMs / 1_000), 5)
    if (this.previousInputTokens !== null) {
      const delta = inputTokens - this.previousInputTokens
      if (delta > 0) pushBounded(this.inputGrowth, delta, 5)
    }
    this.previousInputTokens = inputTokens
    this.previousLocalInputTokens = localInputTokens
  }

  /** Last API truth + locally estimated change since the anchored request. */
  estimateCurrentInput(localInputTokens: number): number {
    return Math.max(0, Math.round(localInputTokens + this.inputTokenCorrection()))
  }

  /** Add this to any local projection made before the next API response. */
  inputTokenCorrection(): number {
    if (this.previousInputTokens === null || this.previousLocalInputTokens === null) return 0
    return this.previousInputTokens - this.previousLocalInputTokens
  }

  recordCompaction(durationMs: number, outputTokens?: number): void {
    if (durationMs <= 0) return
    pushBounded(this.compactionDurations, durationMs / 1_000, 3)
    if (outputTokens && outputTokens > 0) {
      pushBounded(this.compactionTps, outputTokens / (durationMs / 1_000), 3)
    }
  }

  profile(): HippocampusTimingProfile {
    const recentGrowth = this.inputGrowth.slice(-3)
    return {
      mainTps: average(this.mainTps),
      compactionTps: average(this.compactionTps),
      compactionDurationSeconds: average(this.compactionDurations),
      mainOutputTokensPerTurn: average(this.mainOutputs),
      mainContextGrowthTokensPerTurn: average(recentGrowth),
      mainContextGrowthPeakTokensPerTurn:
        this.inputGrowth.length > 0 ? Math.max(...this.inputGrowth) : undefined,
    }
  }

  snapshot(): HippocampusTelemetryState {
    return {
      mainTps: [...this.mainTps],
      mainOutputs: [...this.mainOutputs],
      inputGrowth: [...this.inputGrowth],
      compactionDurations: [...this.compactionDurations],
      compactionTps: [...this.compactionTps],
      previousInputTokens: this.previousInputTokens,
      previousLocalInputTokens: this.previousLocalInputTokens,
    }
  }
}

export class HippocampusRuntime {
  private readonly config: Required<
    Pick<HippocampusRuntimeConfig, 'blockingWaitMs' | 'backgroundTimeoutMs'>
  > & HippocampusRuntimeConfig
  private background: BackgroundTask | null = null
  private budgetState: HippocampusBudget
  private consecutiveFailures = 0
  private rapidRefills = 0
  private turnsSinceMerge: number | null = null
  private breaker: 'consecutive_failures' | 'rapid_refill' | 'prefix_overflow' | null = null

  constructor(config: HippocampusRuntimeConfig) {
    this.config = {
      ...config,
      blockingWaitMs: config.blockingWaitMs ?? 60_000,
      backgroundTimeoutMs: config.backgroundTimeoutMs ?? 120_000,
    }
    this.consecutiveFailures = Math.max(0, config.initialSafetyState?.consecutiveFailures ?? 0)
    this.rapidRefills = Math.max(0, config.initialSafetyState?.rapidRefills ?? 0)
    this.turnsSinceMerge =
      typeof config.initialSafetyState?.turnsSinceMerge === 'number'
        ? Math.max(0, config.initialSafetyState.turnsSinceMerge)
        : null
    this.breaker = config.initialSafetyState?.breaker ?? null
    this.budgetState = resolveHippocampusBudget(config, config.timing())
  }

  get budget(): HippocampusBudget {
    return this.budgetState
  }

  safetySnapshot(): HippocampusSafetyState {
    return {
      consecutiveFailures: this.consecutiveFailures,
      rapidRefills: this.rapidRefills,
      turnsSinceMerge: this.turnsSinceMerge,
      breaker: this.breaker,
    }
  }

  /**
   * Largest safe input for the next complete-turn boundary. Before a fork
   * exists, the next request must still fit prefix + I + R. Once the fork is
   * running or ready, growth may continue only as far as the atomic swap line.
   */
  get toolResultAdmissionLimitTokens(): number {
    return this.background
      ? this.budgetState.swapTokens
      : this.budgetState.forkPrefixLimitTokens
  }

  async beforeRequest(messages: ConversationMessage[]): Promise<BeforeRequestResult> {
    if (!this.background) this.refreshBudget()
    if (this.turnsSinceMerge !== null) this.turnsSinceMerge += 1
    let tokens = this.currentInputTokens(messages)

    if (this.background?.state.phase === 'failed') {
      this.finishFailed(this.background.state.reason)
    } else if (this.background?.state.phase === 'cancelled') {
      this.finishCancelled(this.background.state.reason)
    }

    if (this.background?.state.phase === 'handed_off') {
      return { action: 'durable-handoff', tokens, userWaitMs: 0 }
    }

    if (this.background?.state.phase === 'succeeded' && tokens >= this.budgetState.swapTokens) {
      tokens = this.mergeNow(messages, 0)
      return { action: 'merged', tokens, userWaitMs: 0 }
    }

    if (!this.background && tokens > this.budgetState.forkPrefixLimitTokens) {
      return { action: 'sync-fallback', tokens, userWaitMs: 0 }
    }

    if (tokens >= this.config.contextWindow && !this.background) {
      return { action: 'sync-fallback', tokens, userWaitMs: 0 }
    }

    if (
      this.background?.state.phase === 'running' &&
      tokens >= this.budgetState.swapTokens
    ) {
      const task = this.background
      const waitStartedAt = Date.now()
      const settled = await waitFor(task.done, this.config.blockingWaitMs)
      const userWaitMs = Date.now() - waitStartedAt
      let stateAfterWait = task.state as BackgroundState
      if (settled && stateAfterWait.phase === 'succeeded') {
        tokens = this.mergeNow(messages, userWaitMs)
        return { action: 'merged', tokens, userWaitMs }
      }
      if (stateAfterWait.phase === 'running') {
        task.cancel('blocking wait timeout')
        stateAfterWait = task.state as BackgroundState
      }
      if (stateAfterWait.phase === 'failed') {
        this.finishFailed(stateAfterWait.reason, userWaitMs)
      } else if (this.background) {
        this.finishCancelled('blocking wait timeout', userWaitMs)
      }
      return { action: 'sync-fallback', tokens, userWaitMs }
    }

    const gateOpen = tokens >= this.budgetState.observationGateTokens
    const nextTurnCrosses =
      tokens + this.budgetState.mainContextGrowthTokensPerTurn >= this.budgetState.triggerTokens

    if (gateOpen && (tokens >= this.budgetState.triggerTokens || nextTurnCrosses) && !this.background) {
      if (!this.canStart()) return { action: 'breaker', tokens, userWaitMs: 0 }
      await this.start(messages, tokens)
      // `onStart` is allowed to await a durable shadow write. If that write
      // crosses the background deadline, the timer may settle the local task
      // before `start()` returns. Never admit a main-provider request in that
      // state: AgentLoop will pause for the prepared Job (or run the legacy
      // synchronous fallback when no durable owner exists).
      const stateAfterStart = (this.background as BackgroundTask | null)?.state
      if (stateAfterStart?.phase === 'handed_off') {
        return { action: 'durable-handoff', tokens, userWaitMs: 0 }
      }
      if (
        stateAfterStart?.phase === 'failed'
        || stateAfterStart?.phase === 'cancelled'
      ) {
        return { action: 'sync-fallback', tokens, userWaitMs: 0 }
      }
      return { action: 'started', tokens, userWaitMs: 0 }
    }

    return { action: 'none', tokens, userWaitMs: 0 }
  }

  async onLoopExit(
    messages: ConversationMessage[],
    handoff?: (snapshot: HippocampusCompactionHandoff) => boolean | Promise<boolean>,
  ): Promise<HippocampusLoopExitResult> {
    if (!this.background) return { status: 'none', merged: false }
    if (this.background.state.phase === 'handed_off') {
      this.background = null
      return { status: 'handed_off', merged: false }
    }
    if (this.background.state.phase === 'succeeded') {
      this.mergeNow(messages, 0)
      return { status: 'merged', merged: true }
    }

    if (this.background.state.phase === 'running') {
      const task = this.background
      if (handoff) {
        let accepted = false
        try {
          accepted = await handoff({
            prefixMessages: task.prefix,
            prefixTokens: task.prefixTokens,
            prefixLength: task.spliceIndex,
            startedAt: task.startedAt,
          })
        } catch (error) {
          // A failed enqueue must never discard the only running compaction.
          // Drain it locally instead; the task's own timeout still bounds this
          // wait and produces an explicit failed outcome.
          console.warn('[hippocampus] durable handoff failed; draining locally:', (error as Error).message)
        }
        if (accepted) {
          if (task.state.phase === 'running') task.cancel('durable handoff')
          if (this.background === task) this.background = null
          this.config.events?.onHandoff?.({
            durationMs: Date.now() - task.startedAt,
            compactedTokens: task.prefixTokens,
            removedMessages: task.spliceIndex,
          })
          return { status: 'handed_off', merged: false }
        }
      }

      // Compatibility path when no durable owner is configured: a normal loop
      // exit drains the already-started compaction instead of cancelling it.
      // The summary therefore reaches an atomic replacement before agentLoop
      // returns, while the user-visible main response may already be streamed.
      await task.done
    }

    // The background promise mutates task.state asynchronously; capture a
    // fresh widened view after awaiting instead of relying on the pre-await
    // discriminant narrowing.
    const stateAfterExit = this.background?.state as BackgroundState | undefined
    if (stateAfterExit?.phase === 'handed_off') {
      this.background = null
      return { status: 'handed_off', merged: false }
    }
    if (stateAfterExit?.phase === 'succeeded') {
      this.mergeNow(messages, 0)
      return { status: 'merged', merged: true }
    }
    if (stateAfterExit?.phase === 'failed') {
      const reason = stateAfterExit.reason
      this.finishFailed(reason)
      return { status: 'failed', merged: false, reason }
    }
    if (stateAfterExit?.phase === 'cancelled') {
      const reason = stateAfterExit.reason
      this.finishCancelled(reason)
      return { status: 'cancelled', merged: false, reason }
    }
    return { status: 'none', merged: false }
  }

  abort(reason: string): void {
    if (!this.background) return
    if (this.background.state.phase === 'handed_off') {
      this.background = null
      return
    }
    if (this.background.state.phase === 'running') this.background.cancel(reason)
    this.finishCancelled(reason)
  }

  private refreshBudget(): void {
    try {
      this.budgetState = resolveHippocampusBudget(this.config, this.config.timing())
    } catch (error) {
      console.warn('[hippocampus] keeping last valid budget:', (error as Error).message)
    }
  }

  private currentInputTokens(messages: ConversationMessage[]): number {
    return this.config.estimateInputTokens?.(messages)
      ?? (estimateTokens(messages) + this.config.staticOverheadTokens)
  }

  private canStart(): boolean {
    if (this.breaker) return false
    if (this.config.staticOverheadTokens >= this.budgetState.triggerTokens) {
      this.breaker = 'prefix_overflow'
      this.config.events?.onBreaker?.({
        kind: this.breaker,
        detail: `static overhead ${this.config.staticOverheadTokens} >= trigger ${this.budgetState.triggerTokens}`,
      })
      return false
    }
    if (this.turnsSinceMerge !== null && this.turnsSinceMerge <= 3) {
      this.rapidRefills += 1
      if (this.rapidRefills >= 2) {
        this.breaker = 'rapid_refill'
        this.config.events?.onBreaker?.({
          kind: this.breaker,
          detail: `refilled within ${this.turnsSinceMerge} turns twice`,
        })
        return false
      }
    } else if (this.turnsSinceMerge !== null) {
      this.rapidRefills = 0
    }
    return true
  }

  private async start(messages: ConversationMessage[], tokens: number): Promise<void> {
    const prefix = messages.slice()
    const spliceIndex = prefix.length
    const startedAt = Date.now()
    const controller = new AbortController()
    // Background compaction has a lifecycle independent from its parent Run.
    // User Stop, service shutdown and a main-provider failure must hand the
    // frozen prefix to its durable owner rather than implicitly cancelling it.
    // Only an explicit local takeover calls task.cancel()/abort().
    const signal = controller.signal
    let state: BackgroundState = { phase: 'running' }
    let resolveDone!: () => void
    const done = new Promise<void>(resolve => { resolveDone = resolve })
    let cancelReason = 'cancelled'

    const settle = (next: BackgroundState) => {
      if (state.phase !== 'running') return
      state = next
      task.state = next
      clearTimeout(timer)
      resolveDone()
      const durationMs = Date.now() - startedAt
      if (next.phase === 'succeeded') {
        this.config.events?.onReady?.({ durationMs, usage: next.outcome.usage })
      }
    }

    const timer = setTimeout(() => {
      settle({ phase: 'failed', reason: `background timeout after ${this.config.backgroundTimeoutMs}ms` })
      controller.abort()
    }, this.config.backgroundTimeoutMs)
    ;(timer as { unref?: () => void }).unref?.()

    const task: BackgroundTask = {
      prefix,
      spliceIndex,
      prefixTokens: tokens,
      startedAt,
      done,
      state,
      cancel(reason: string) {
        if (task.state.phase !== 'running') return
        cancelReason = reason
        controller.abort()
        settle({ phase: 'cancelled', reason })
      },
    }
    this.background = task

    try {
      await this.config.events?.onStart?.({
        snapshotTokens: tokens,
        spliceIndex,
        budget: this.budgetState,
        prefixMessages: prefix,
        startedAt,
        initialAvailableAt: new Date(startedAt + this.config.backgroundTimeoutMs),
      })
    } catch (error) {
      // Durable mode must never continue with an unconfirmed/mismatched
      // shadow: another worker may already own the same prefix. Propagate the
      // barrier control error after stopping this local task.
      task.cancel('durable shadow prepare failed')
      throw error
    }

    // Persisting the shadow may itself take long enough to exhaust the local
    // background lease. Do not start a silent provider request after the Job
    // has become claimable; the durable worker is now the only executor.
    if (Date.now() >= startedAt + this.config.backgroundTimeoutMs) {
      settle({ phase: 'failed', reason: 'durable shadow takeover deadline reached before local start' })
      controller.abort()
      return
    }

    void (async () => {
      try {
        const outcome = await this.config.compact(prefix, signal)
        if (signal.aborted) {
          settle({ phase: 'cancelled', reason: cancelReason })
        } else if (outcome.handedOff) {
          settle({ phase: 'handed_off', usage: outcome.usage })
          this.config.events?.onHandoff?.({
            durationMs: Date.now() - task.startedAt,
            compactedTokens: task.prefixTokens,
            removedMessages: task.spliceIndex,
          })
        } else if (!outcome.summary.trim()) {
          settle({ phase: 'failed', reason: 'empty summary' })
        } else {
          settle({ phase: 'succeeded', outcome })
        }
      } catch (error) {
        settle(signal.aborted
          ? { phase: 'cancelled', reason: cancelReason }
          : { phase: 'failed', reason: (error as Error).message })
      }
    })()
  }

  private mergeNow(messages: ConversationMessage[], userWaitMs: number): number {
    const task = this.background
    if (!task || task.state.phase !== 'succeeded') {
      throw new Error('hippocampus: merge requested without a ready summary')
    }
    if (task.spliceIndex > messages.length) {
      throw new Error('hippocampus: append-only message contract was broken')
    }
    const beforeTokens = this.currentInputTokens(messages)
    const candidate = [
      task.state.outcome.wrappedMessage,
      ...messages.slice(task.spliceIndex),
    ]
    const afterTokens = this.currentInputTokens(candidate)
    if (!(afterTokens < beforeTokens)) {
      const reason = `async compaction did not reduce request input: ${beforeTokens} -> ${afterTokens}`
      this.finishFailed(reason, userWaitMs)
      throw new Error(`hippocampus: ${reason}`)
    }
    if (!(afterTokens < this.budgetState.mainInputLimitTokens)) {
      const reason = `async compaction did not restore output headroom: ${afterTokens} >= ${this.budgetState.mainInputLimitTokens}`
      this.finishFailed(reason, userWaitMs)
      throw new Error(`hippocampus: ${reason}`)
    }
    messages.splice(0, task.spliceIndex, task.state.outcome.wrappedMessage)
    this.config.events?.onDone?.({
      status: 'merged',
      durationMs: Date.now() - task.startedAt,
      userWaitMs,
      compactedTokens: task.prefixTokens,
      removedMessages: task.spliceIndex,
    })
    this.background = null
    this.consecutiveFailures = 0
    this.turnsSinceMerge = 0
    return afterTokens
  }

  private finishFailed(reason: string, userWaitMs = 0): void {
    const task = this.background
    if (!task) return
    this.config.events?.onDone?.({
      status: 'failed',
      durationMs: Date.now() - task.startedAt,
      userWaitMs,
      reason,
    })
    this.background = null
    this.consecutiveFailures += 1
    if (this.consecutiveFailures >= 3 && !this.breaker) {
      this.breaker = 'consecutive_failures'
      this.config.events?.onBreaker?.({ kind: this.breaker, detail: '3 consecutive compaction failures' })
    }
  }

  private finishCancelled(reason: string, userWaitMs = 0): void {
    const task = this.background
    if (!task) return
    this.config.events?.onDone?.({
      status: 'cancelled',
      durationMs: Date.now() - task.startedAt,
      userWaitMs,
      reason,
    })
    this.background = null
  }
}

async function waitFor(done: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      done.then(() => true),
      new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(false), timeoutMs)
        ;(timer as { unref?: () => void }).unref?.()
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
