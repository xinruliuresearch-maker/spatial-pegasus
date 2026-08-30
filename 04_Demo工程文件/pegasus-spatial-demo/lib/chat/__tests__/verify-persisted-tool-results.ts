import assert from 'node:assert/strict'
import { attachPersistedToolResult } from '../persisted-tool-results'
import type { DisplayPart } from '../../types'

const parts: DisplayPart[] = [{
  type: 'tool_call',
  tool: 'CreateWorld3D',
  tool_use_id: 'tool_fixture_world',
}]
const envelope = JSON.stringify({
  schema_version: 1,
  job_id: 'spjob_fixture',
  kind: 'world',
  status: 'published',
  provider: 'fixture',
  updated_at: '2026-08-27T00:00:00.000Z',
})

assert.equal(attachPersistedToolResult(parts, {
  type: 'tool_result',
  tool_use_id: 'tool_fixture_world',
  content: envelope,
}), true)
assert.equal(parts[0].type === 'tool_call' && parts[0].content, envelope)
assert.equal(parts[0].type === 'tool_call' && parts[0].pending, false)

const untouched = structuredClone(parts)
assert.equal(attachPersistedToolResult(untouched, {
  type: 'tool_result',
  tool_use_id: 'another_tool',
  content: 'must not attach by tool name alone',
}), false)
assert.deepEqual(untouched, parts)

assert.equal(attachPersistedToolResult(parts, {
  type: 'tool_result',
  tool_use_id: 'tool_fixture_world',
  content: [{ type: 'text', text: 'fixture failed' }],
  is_error: true,
}), true)
assert.equal(parts[0].type === 'tool_call' && parts[0].content, 'fixture failed')
assert.equal(parts[0].type === 'tool_call' && parts[0].is_error, true)

console.log('persisted-tool-results verification passed.')
