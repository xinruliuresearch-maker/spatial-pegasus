import assert from 'node:assert/strict'
import {
  startDurableCompactionWorker,
  type DurableCompactionWorkerDependencies,
  type DurableCompactionWorkerTimer,
} from '../worker'
import type {
  ClaimedCompactionJob,
  DurableCompactionJobRecord,
  DurableCompactionProcessor,
} from '../types'

interface FakeTimer extends DurableCompactionWorkerTimer {
  id: number
  dueAt: number
  callback: () => void
}

class FakeClock {
  now = 0
  private nextId = 1
  private readonly timers = new Map<number, FakeTimer>()

  readonly setTimeout = (callback: () => void, delayMs: number): FakeTimer => {
    const timer: FakeTimer = {
      id: this.nextId++,
      dueAt: this.now + Math.max(0, delayMs),
      callback,
      unref() { /* deterministic test timer */ },
    }
    this.timers.set(timer.id, timer)
    return timer
  }

  readonly clearTimeout = (timer: DurableCompactionWorkerTimer): void => {
    this.timers.delete((timer as FakeTimer).id)
  }

  nextDelay(): number | null {
    const dueAt = Math.min(...[...this.timers.values()].map(timer => timer.dueAt))
    return Number.isFinite(dueAt) ? dueAt - this.now : null
  }

  async settle(): Promise<void> {
    for (let index = 0; index < 20; index += 1) await Promise.resolve()
  }

  async advance(milliseconds: number): Promise<void> {
    const target = this.now + milliseconds
    let executions = 0
    while (true) {
      await this.settle()
      const next = [...this.timers.values()]
        .filter(timer => timer.dueAt <= target)
        .sort((left, right) => left.dueAt - right.dueAt || left.id - right.id)[0]
      if (!next) break
      assert.ok(executions++ < 100, 'scheduler must not hot-loop at the same fake time')
      this.now = next.dueAt
      this.timers.delete(next.id)
      next.callback()
    }
    this.now = target
    await this.settle()
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(accept => { resolve = accept })
  return { promise, resolve }
}

function deferredValue<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}

function claim(jobId: string): ClaimedCompactionJob {
  return {
    job: { job_id: jobId } as DurableCompactionJobRecord,
    ownerId: 'worker_schedule_test',
    fenceToken: `fence_${jobId}`,
  }
}

const processor: DurableCompactionProcessor = {
  async summarize() {
    throw new Error('the injected scheduling test processor must handle claims')
  },
}

function dependencies(
  clock: FakeClock,
  claimNext: DurableCompactionWorkerDependencies['claimNextCompactionJob'],
  processClaim: DurableCompactionWorkerDependencies['processClaimedCompactionJob'],
  releaseClaim: DurableCompactionWorkerDependencies['releaseCompactionForRetry'] = async () => true,
): DurableCompactionWorkerDependencies {
  return {
    claimNextCompactionJob: claimNext,
    async clearExpiredContextCompactionFences() { return 0 },
    async flushDurableCompactionStatusOutbox() { return 0 },
    releaseCompactionForRetry: releaseClaim,
    processClaimedCompactionJob: processClaim,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  }
}

async function verifyStopWaitsForDeferredClaimAndReleasesLease(): Promise<void> {
  const clock = new FakeClock()
  const pendingClaim = deferredValue<ClaimedCompactionJob | null>()
  const pendingRelease = deferred()
  const released: string[] = []
  let claimCalls = 0
  let processCalls = 0
  const worker = startDurableCompactionWorker(processor, {
    ownerId: 'worker_shutdown_test',
    pollIntervalMs: 250,
  }, dependencies(
    clock,
    async () => {
      claimCalls += 1
      return pendingClaim.promise
    },
    async () => {
      processCalls += 1
      return { outcome: 'merged' }
    },
    async currentClaim => {
      released.push(currentClaim.job.job_id)
      await pendingRelease.promise
      return true
    },
  ))

  await clock.advance(0)
  assert.equal(claimCalls, 1)

  let stopCompleted = false
  const stopping = worker.stop().then(() => { stopCompleted = true })
  await clock.settle()
  assert.equal(stopCompleted, false, 'stop must wait for the in-flight repository claim')

  pendingClaim.resolve(claim('job_claimed_during_shutdown'))
  await clock.settle()
  assert.equal(stopCompleted, false, 'stop must wait until the late claim lease is released')
  assert.deepEqual(released, ['job_claimed_during_shutdown'])
  assert.equal(processCalls, 0, 'a claim returned after stop must not start processor work')

  pendingRelease.resolve()
  await stopping
  assert.equal(stopCompleted, true)
  assert.deepEqual(released, ['job_claimed_during_shutdown'])
  assert.equal(processCalls, 0)
  assert.equal(clock.nextDelay(), null)

  worker.wake()
  await clock.advance(1_000)
  assert.equal(claimCalls, 1, 'a stopped worker must not leave scheduled background work')
  assert.equal(processCalls, 0)
  assert.deepEqual(released, ['job_claimed_during_shutdown'])
}

async function verifyEmptyQueueUsesPollCadence(): Promise<void> {
  const clock = new FakeClock()
  const claimTimes: number[] = []
  const worker = startDurableCompactionWorker(processor, {
    ownerId: 'worker_empty_test',
    pollIntervalMs: 250,
  }, dependencies(
    clock,
    async () => {
      claimTimes.push(clock.now)
      return null
    },
    async () => { throw new Error('empty queue must not process a claim') },
  ))

  assert.equal(clock.nextDelay(), 0)
  await clock.advance(0)
  assert.deepEqual(claimTimes, [0])
  assert.equal(clock.nextDelay(), 250)

  await clock.advance(249)
  assert.deepEqual(claimTimes, [0])
  await clock.advance(1)
  assert.deepEqual(claimTimes, [0, 250])
  assert.equal(clock.nextDelay(), 250)
  await worker.stop()
}

async function verifyClaimedWorkImmediatelyRefillsCapacity(): Promise<void> {
  const clock = new FakeClock()
  const queued = [claim('job_1'), claim('job_2'), claim('job_3')]
  const claimTimes: number[] = []
  const started: string[] = []
  const executions = new Map<string, ReturnType<typeof deferred>>()
  const worker = startDurableCompactionWorker(processor, {
    ownerId: 'worker_drain_test',
    pollIntervalMs: 250,
    concurrency: 2,
  }, dependencies(
    clock,
    async () => {
      claimTimes.push(clock.now)
      return queued.shift() ?? null
    },
    async currentClaim => {
      const execution = deferred()
      executions.set(currentClaim.job.job_id, execution)
      started.push(currentClaim.job.job_id)
      await execution.promise
      return { outcome: 'merged' }
    },
  ))

  await clock.advance(0)
  assert.deepEqual(started, ['job_1', 'job_2'])
  assert.deepEqual(claimTimes, [0, 0])
  assert.equal(clock.nextDelay(), 250)

  executions.get('job_1')?.resolve()
  await clock.advance(0)
  assert.deepEqual(started, ['job_1', 'job_2', 'job_3'])
  assert.deepEqual(claimTimes, [0, 0, 0])

  executions.get('job_2')?.resolve()
  executions.get('job_3')?.resolve()
  await clock.advance(0)
  assert.deepEqual(claimTimes, [0, 0, 0, 0])
  assert.equal(clock.nextDelay(), 250)
  await clock.advance(249)
  assert.equal(claimTimes.length, 4)
  await worker.stop()
}

async function verifyWakePreemptsLongPollTimer(): Promise<void> {
  const clock = new FakeClock()
  const queued: ClaimedCompactionJob[] = []
  const claimTimes: number[] = []
  const execution = deferred()
  const worker = startDurableCompactionWorker(processor, {
    ownerId: 'worker_wake_test',
    pollIntervalMs: 250,
    concurrency: 1,
  }, dependencies(
    clock,
    async () => {
      claimTimes.push(clock.now)
      return queued.shift() ?? null
    },
    async () => {
      await execution.promise
      return { outcome: 'merged' }
    },
  ))

  await clock.advance(0)
  assert.deepEqual(claimTimes, [0])
  assert.equal(clock.nextDelay(), 250)
  await clock.advance(100)

  queued.push(claim('job_woken'))
  worker.wake()
  assert.equal(clock.nextDelay(), 0)
  await clock.advance(0)
  assert.deepEqual(claimTimes, [0, 100])
  assert.equal(clock.nextDelay(), 250)

  execution.resolve()
  await clock.advance(0)
  await worker.stop()
}

async function main(): Promise<void> {
  await verifyEmptyQueueUsesPollCadence()
  await verifyClaimedWorkImmediatelyRefillsCapacity()
  await verifyWakePreemptsLongPollTimer()
  await verifyStopWaitsForDeferredClaimAndReleasesLease()
  console.log('Durable compaction worker scheduling verification passed.')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
