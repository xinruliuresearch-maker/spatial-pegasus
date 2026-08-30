import assert from 'node:assert/strict'
import {
  agentRunFailureSignature,
  classifyAgentRunFailure,
} from '../failure-policy'
import { teamAgentStatusAfterRun } from '../runner'

function main(): void {
  assert.deepEqual(
    classifyAgentRunFailure(
      new TypeError("Cannot read properties of undefined (reading 'length')"),
      'runtime_error',
    ).failureRecoverability,
    'transient',
  )
  assert.equal(
    classifyAgentRunFailure(new Error('Provider returned 503'), 'model_error').failureCategory,
    'provider_transient',
  )
  assert.equal(
    classifyAgentRunFailure(new Error('OPENROUTER_API_KEY environment variable is required'), 'model_error')
      .failureRecoverability,
    'fatal',
  )
  assert.equal(
    classifyAgentRunFailure(new Error('Agent Run references a stale TeamAgent session'), 'runtime_error')
      .failureCategory,
    'identity_invariant',
  )
  assert.equal(
    classifyAgentRunFailure(new Error('turn limit'), 'max_turns').failureRecoverability,
    'transient',
  )
  const hostileError = Object.defineProperty({}, 'message', {
    get() { throw new Error('hostile error accessor') },
  })
  assert.doesNotThrow(() => classifyAgentRunFailure(hostileError, 'runtime_error'))

  assert.equal(
    agentRunFailureSignature(
      new Error('Run run_0145ac66-86f4-4bd9-a78b-c788a4f00e34 failed lease_fence_0123456789abcdef'),
      'runtime_transient',
    ),
    agentRunFailureSignature(
      new Error('Run run_768fb153-3595-43e3-8a6a-d772cb30c4cf failed lease_fence_fedcba9876543210'),
      'runtime_transient',
    ),
    'per-attempt identities must not split one failure circuit',
  )

  const rootUserRun = {
    trigger: 'user' as const,
    execution_mode: 'conversation' as const,
    root_visible: true,
  }
  assert.equal(teamAgentStatusAfterRun(rootUserRun, {
    status: 'failed',
    failure_recoverability: 'transient',
  }), 'idle', 'one transient public Root failure must not brick the coordinator')
  assert.equal(teamAgentStatusAfterRun(rootUserRun, {
    status: 'failed',
    failure_recoverability: 'fatal',
  }), 'failed')
  assert.equal(teamAgentStatusAfterRun({ ...rootUserRun, trigger: 'supervision' }, {
    status: 'failed',
  }), 'idle', 'legacy supervision failures retain containment semantics')
  assert.equal(teamAgentStatusAfterRun({
    trigger: 'message',
    execution_mode: 'agent_session',
    root_visible: false,
  }, {
    status: 'failed',
    failure_recoverability: 'transient',
  }), 'failed', 'member Agent failure semantics are unchanged')

  console.log('Root failure policy verification passed.')
}

main()
