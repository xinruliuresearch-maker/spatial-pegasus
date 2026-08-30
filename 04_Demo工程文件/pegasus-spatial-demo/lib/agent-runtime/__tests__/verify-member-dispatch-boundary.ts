import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const localOwner = readFileSync(join(process.cwd(), 'lib', 'local-owner.ts'), 'utf8')
const memberRoute = readFileSync(
  join(process.cwd(), 'app', 'api', 'agent-team', 'execute', 'route.ts'),
  'utf8',
)
const memberExecutor = readFileSync(
  join(process.cwd(), 'lib', 'agent-runtime', 'member-executor.ts'),
  'utf8',
)

assert.match(localOwner, /return DEMO_USER_ID/)
assert.match(memberRoute, /isInternalAgentRunnerRequest\(/)
assert.match(memberRoute, /validateMemberExecutionFences\(/)
assert.doesNotMatch(
  memberRoute,
  /resolveLocalOwner\(/,
  'member execution must accept only the Runner HMAC, not the local Demo owner',
)
assert.match(memberExecutor, /modelAlias: alias/)
assert.match(memberExecutor, /onBackgroundCompactionPrepare\(descriptor\)/)
assert.match(memberExecutor, /notBefore: descriptor\.initialAvailableAt/)
assert.match(memberExecutor, /activateDurableCompactionJob\(/)
assert.match(memberExecutor, /onBackgroundCompactionOfferSummary\(input\)/)
assert.match(memberExecutor, /offerPreparedCompactionSummary\(/)
assert.match(memberExecutor, /onBackgroundCompactionPause\(input\)/)
assert.match(memberExecutor, /deferExecutorForCompactionReload\(/)
assert.match(memberExecutor, /failClosedExecutorCompactionPrepare\(/)
assert.match(memberExecutor, /onBackgroundCompactionAcquireSourceTurnGuard\(input\)/)
assert.match(memberExecutor, /acquireSourceTurnCompactionGuard\(/)
assert.match(memberExecutor, /onBackgroundCompactionHeartbeatSourceTurnGuard\(input\)/)
assert.match(memberExecutor, /heartbeatSourceTurnCompactionGuard\(/)
assert.match(memberExecutor, /onBackgroundCompactionReleaseSourceTurnGuard\(input\)/)
assert.match(memberExecutor, /releaseSourceTurnCompactionGuard\(/)
assert.match(memberExecutor, /sourceRunId: input\.sourceRunId/)
assert.match(memberExecutor, /guardOwnerId: ownerId/)
assert.match(memberExecutor, /error instanceof CompactionJobNotUnclaimedQueuedError\) return null/)
assert.match(memberExecutor, /onFailedCompactionRepaired\(input\)/)
assert.match(memberExecutor, /closeFailedCompactionAfterSynchronousRepair\(/)
assert.doesNotMatch(memberExecutor, /supersedeDurableCompactionJob\(/)
assert.match(
  memberExecutor,
  /ignoreActiveJobId: localShadowIntent\?\.jobId,[\s\S]{0,120}ignoreActiveJobBefore: localShadowIntent\?\.before/,
  'member may bypass only its exact, unexpired process-local shadow',
)

console.log('member-dispatch-boundary:verify passed')
