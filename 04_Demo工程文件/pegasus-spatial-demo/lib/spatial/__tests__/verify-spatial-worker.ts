import assert from 'node:assert/strict'
import {
  InMemorySpatialAssetPublisher,
  startSpatialBuildWorker,
  type ClaimedSpatialBuildJob,
  type SpatialBuildWorkerRuntime,
  type SpatialProviderAdapter,
  type SpatialWorkerTimer,
} from '..'

interface TimerRecord extends SpatialWorkerTimer {
  id: number
  delayMs: number
  callback: () => void
  cancelled: boolean
}

class ManualClock {
  private sequence = 0
  readonly timers: TimerRecord[] = []

  setTimeout = (callback: () => void, delayMs: number): SpatialWorkerTimer => {
    const timer: TimerRecord = {
      id: ++this.sequence,
      delayMs,
      callback,
      cancelled: false,
      unref() {},
    }
    this.timers.push(timer)
    return timer
  }

  clearTimeout = (timer: SpatialWorkerTimer): void => {
    ;(timer as TimerRecord).cancelled = true
  }

  pending(): TimerRecord[] {
    return this.timers.filter(timer => !timer.cancelled)
  }

  async runNext(): Promise<void> {
    const timer = this.pending().sort((left, right) => left.id - right.id)[0]
    assert.ok(timer, 'expected a scheduled timer')
    timer.cancelled = true
    timer.callback()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    // Terminal notification adds one promise boundary before capacity refill.
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  }
}

function claim(id = 'job_worker'): ClaimedSpatialBuildJob {
  const now = new Date('2026-08-25T00:00:00.000Z')
  return {
    ownerId: 'worker',
    leaseToken: 'lease',
    job: {
      job_id: id,
      idempotency_key: `project\0run\0${id}`,
      project_id: 'project',
      run_id: 'run',
      tool_use_id: id,
      user_id: 'user',
      conversation_id: 'conversation',
      kind: 'object',
      provider: 'fake',
      model_snapshot: null,
      request_hash: 'hash',
      request_snapshot: { output_path_prefix: `output/spatial/objects/${id}` },
      status: 'prepared',
      active_slot: 0,
      status_revision: 0,
      execution_attempts: 1,
      submission_attempts: 0,
      poll_attempts: 0,
      lease: {
        owner_id: 'worker',
        token: 'lease',
        acquired_at: now,
        heartbeat_at: now,
        expires_at: new Date('2026-08-25T01:00:00.000Z'),
      },
      external_job_id: null,
      provider_status: null,
      published_artifact_ids: [],
      published_workspace_paths: [],
      publication_token: null,
      available_at: null,
      last_error: null,
      unknown_reason: null,
      created_at: now,
      updated_at: now,
      finished_at: null,
    },
  }
}

const unusedAdapter: SpatialProviderAdapter = {
  provider: 'fake',
  supports: () => true,
  async submit() { return { externalJobId: 'unused' } },
  async poll() { return { state: 'running' } },
}

const processDependencies = {
  adapters: { fake: unusedAdapter },
  publisher: new InMemorySpatialAssetPublisher(),
}

function runtime(input: {
  clock: ManualClock
  claim: SpatialBuildWorkerRuntime['claimNextSpatialBuildJob']
  process?: SpatialBuildWorkerRuntime['processClaim']
  release?: SpatialBuildWorkerRuntime['releaseUnstartedSpatialClaim']
}): SpatialBuildWorkerRuntime {
  return {
    claimNextSpatialBuildJob: input.claim,
    async recoverAmbiguousSpatialSubmissions() {},
    releaseUnstartedSpatialClaim: input.release ?? (async () => true),
    processClaim: input.process ?? (async () => undefined),
    setTimeout: input.clock.setTimeout,
    clearTimeout: input.clock.clearTimeout,
  }
}

async function verifyEmptyQueueDoesNotHotPoll(): Promise<void> {
  const clock = new ManualClock()
  let claims = 0
  const worker = startSpatialBuildWorker(processDependencies, {
    pollIntervalMs: 500,
  }, runtime({
    clock,
    claim: async () => {
      claims += 1
      return null
    },
  }))
  await clock.runNext()
  assert.equal(claims, 1)
  assert.deepEqual(clock.pending().map(timer => timer.delayMs), [500])
  await clock.runNext()
  assert.equal(claims, 2)
  assert.deepEqual(clock.pending().map(timer => timer.delayMs), [500])
  await worker.stop()
}

async function verifyDelayedClaimIsReleasedDuringStop(): Promise<void> {
  const clock = new ManualClock()
  let resolveClaim!: (value: ClaimedSpatialBuildJob) => void
  const delayedClaim = new Promise<ClaimedSpatialBuildJob>(resolve => { resolveClaim = resolve })
  let processed = 0
  let released = 0
  const worker = startSpatialBuildWorker(processDependencies, {}, runtime({
    clock,
    claim: async () => delayedClaim,
    process: async () => { processed += 1 },
    release: async () => {
      released += 1
      return true
    },
  }))
  await clock.runNext()
  const stopping = worker.stop()
  resolveClaim(claim('job_after_stop'))
  await stopping
  assert.equal(processed, 0, 'a claim returned after stop must never start')
  assert.equal(released, 1, 'a claim returned after stop must release its lease')
  assert.equal(clock.pending().length, 0)
}

async function verifyClaimFaultBacksOff(): Promise<void> {
  const clock = new ManualClock()
  let calls = 0
  const errors: unknown[] = []
  const worker = startSpatialBuildWorker(processDependencies, {
    pollIntervalMs: 750,
    onError: error => errors.push(error),
  }, runtime({
    clock,
    claim: async () => {
      calls += 1
      if (calls === 1) throw new Error('delayed claim fault')
      return null
    },
  }))
  await clock.runNext()
  assert.equal(errors.length, 1)
  assert.deepEqual(clock.pending().map(timer => timer.delayMs), [750])
  await clock.runNext()
  assert.equal(calls, 2)
  assert.deepEqual(clock.pending().map(timer => timer.delayMs), [750])
  await worker.stop()
}

async function verifyCompletionGetsOneImmediateCapacityRefill(): Promise<void> {
  const clock = new ManualClock()
  const queue: (ClaimedSpatialBuildJob | null)[] = [claim('job_one'), null]
  let processed = 0
  const worker = startSpatialBuildWorker(processDependencies, {
    concurrency: 1,
    pollIntervalMs: 900,
  }, runtime({
    clock,
    claim: async () => queue.shift() ?? null,
    process: async () => { processed += 1 },
  }))
  await clock.runNext()
  await Promise.resolve()
  assert.equal(processed, 1)
  assert.deepEqual(clock.pending().map(timer => timer.delayMs), [0])
  await clock.runNext()
  assert.deepEqual(clock.pending().map(timer => timer.delayMs), [900])
  await worker.stop()
}

async function verifyTerminalJobTriggersOneNotificationFastPath(): Promise<void> {
  const clock = new ManualClock()
  const initial = claim('job_terminal_notification')
  const terminal: ClaimedSpatialBuildJob = {
    ...initial,
    job: {
      ...initial.job,
      status: 'published',
      status_revision: 4,
      completion_notification_requested: true,
      finished_at: new Date('2026-08-25T00:05:00.000Z'),
    },
  }
  let notifications = 0
  const worker = startSpatialBuildWorker(processDependencies, {
    concurrency: 1,
    onTerminalJob(job) {
      assert.equal(job.job_id, 'job_terminal_notification')
      notifications += 1
    },
  }, runtime({
    clock,
    claim: async () => initial,
    process: async () => terminal,
  }))
  await clock.runNext()
  await worker.stop()
  assert.equal(notifications, 1)
}

async function main(): Promise<void> {
  await verifyEmptyQueueDoesNotHotPoll()
  await verifyDelayedClaimIsReleasedDuringStop()
  await verifyClaimFaultBacksOff()
  await verifyCompletionGetsOneImmediateCapacityRefill()
  await verifyTerminalJobTriggersOneNotificationFastPath()
  console.log('✓ Spatial worker scheduler verification passed')
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
