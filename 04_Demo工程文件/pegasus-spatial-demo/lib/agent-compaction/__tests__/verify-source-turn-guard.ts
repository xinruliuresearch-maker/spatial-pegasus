import assert from 'node:assert/strict'
import {
  isSourceTurnCompactionGuardLive,
  type DurableCompactionSourceTurnGuard,
} from '../types'

const now = new Date('2026-08-10T00:00:00.000Z')

function guard(expiresAt: Date): DurableCompactionSourceTurnGuard {
  return {
    token: 'cmpguard_test',
    owner_id: 'source_turn_test',
    source_run_id: 'run_test',
    heartbeat_at: new Date('2026-08-09T23:59:50.000Z'),
    expires_at: expiresAt,
  }
}

assert.equal(
  isSourceTurnCompactionGuardLive(
    guard(new Date('2026-08-10T00:00:00.001Z')),
    now,
  ),
  true,
)
assert.equal(
  isSourceTurnCompactionGuardLive(guard(now), now),
  false,
  'expiry at the claim instant is available for deterministic takeover',
)
assert.equal(
  isSourceTurnCompactionGuardLive(
    guard(new Date('2026-08-09T23:59:59.999Z')),
    now,
  ),
  false,
)
assert.equal(isSourceTurnCompactionGuardLive(null, now), false)
assert.equal(isSourceTurnCompactionGuardLive({
  ...guard(new Date('2026-08-10T00:01:00.000Z')),
  token: '',
}, now), false, 'an incomplete persisted guard must never block recovery')

console.log('source-turn-compaction-guard:verify passed')
