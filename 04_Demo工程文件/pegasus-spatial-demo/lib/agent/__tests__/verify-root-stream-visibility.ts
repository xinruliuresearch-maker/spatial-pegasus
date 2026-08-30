import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  attachSubscriber,
  bindBroadcastRun,
  broadcast,
  createBroadcast,
  discardBroadcast,
  getBroadcast,
} from '../stream-registry'

async function readSse(readable: ReadableStream<Uint8Array>): Promise<string> {
  const reader = readable.getReader()
  const decoder = new TextDecoder()
  let output = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) return output
    output += decoder.decode(value, { stream: true })
  }
}

async function main(): Promise<void> {
  const handoffConversation = 'verify_root_visibility_handoff'
  createBroadcast(handoffConversation)
  bindBroadcastRun(handoffConversation, 'run_visibility')
  broadcast(handoffConversation, { type: 'run_detached', run_id: 'run_visibility' })
  discardBroadcast(handoffConversation)
  assert.equal(
    getBroadcast(handoffConversation),
    undefined,
    'submission hand-off channel must not shadow the Runner execution channel',
  )

  const executionConversation = 'verify_root_visibility_execution'
  createBroadcast(executionConversation)
  bindBroadcastRun(executionConversation, 'run_visibility')
  broadcast(executionConversation, { type: 'thinking_delta', text: 'plan' })
  broadcast(executionConversation, { type: 'tool_start', tool: 'Skill' })
  broadcast(executionConversation, { type: 'tool_done', tool: 'Skill' })
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
  attachSubscriber(executionConversation, writable.getWriter())
  discardBroadcast(executionConversation)
  const replay = await readSse(readable)
  assert.match(replay, /"type":"thinking_delta"/)
  assert.match(replay, /"type":"tool_start"/)
  assert.match(replay, /"type":"tool_done"/)

  const submitRoute = readFileSync(
    join(process.cwd(), 'app', 'api', 'chat', 'route.ts'),
    'utf8',
  )
  const runStreamRoute = readFileSync(
    join(process.cwd(), 'app', 'api', 'chat', 'runs', '[runId]', 'stream', 'route.ts'),
    'utf8',
  )
  assert.match(submitRoute, /discardBroadcast\(convId\)/)
  assert.match(submitRoute, /if \(internalRunnerRun\) \{\s*bindBroadcastRun\(convId, internalRunnerRun\.run_id\)/)
  assert.match(
    submitRoute,
    /type: 'compaction_status',[\s\S]{0,160}status: 'queued',[\s\S]{0,160}job_id: handoff\.jobId/,
    'Root durable handoff must replace the pending indicator with a real queued Job status',
  )
  assert.match(submitRoute, /modelAlias: alias/)
  assert.match(submitRoute, /onBackgroundCompactionPrepare\(descriptor\)/)
  assert.match(submitRoute, /notBefore: descriptor\.initialAvailableAt/)
  assert.match(
    submitRoute,
    /localShadowIntent = \{[\s\S]{0,240}jobId: prepared\.jobId,[\s\S]{0,420}type: 'compaction_status',[\s\S]{0,120}status: 'queued',[\s\S]{0,120}job_id: prepared\.jobId/,
    'Root must expose the delayed durable shadow before the local summarizer or Run can exit',
  )
  assert.match(submitRoute, /activateDurableCompactionJob\(/)
  assert.match(submitRoute, /onBackgroundCompactionOfferSummary\(input\)/)
  assert.match(submitRoute, /offerPreparedCompactionSummary\(/)
  assert.match(submitRoute, /onBackgroundCompactionPause\(input\)/)
  assert.match(submitRoute, /deferExecutorForCompactionReload\(/)
  assert.match(submitRoute, /onBackgroundCompactionAcquireSourceTurnGuard\(input\)/)
  assert.match(submitRoute, /acquireSourceTurnCompactionGuard\(/)
  assert.match(submitRoute, /onBackgroundCompactionHeartbeatSourceTurnGuard\(input\)/)
  assert.match(submitRoute, /heartbeatSourceTurnCompactionGuard\(/)
  assert.match(submitRoute, /onBackgroundCompactionReleaseSourceTurnGuard\(input\)/)
  assert.match(submitRoute, /releaseSourceTurnCompactionGuard\(/)
  assert.match(submitRoute, /sourceRunId: input\.sourceRunId/)
  assert.match(submitRoute, /guardOwnerId: executionOwnerId/)
  assert.match(submitRoute, /error instanceof CompactionJobNotUnclaimedQueuedError\) return null/)
  assert.match(submitRoute, /onFailedCompactionRepaired\(input\)/)
  assert.match(submitRoute, /closeFailedCompactionAfterSynchronousRepair\(/)
  assert.doesNotMatch(submitRoute, /supersedeDurableCompactionJob\(/)
  assert.match(
    submitRoute,
    /ignoreActiveJobId: localShadowIntent\?\.jobId,[\s\S]{0,120}ignoreActiveJobBefore: localShadowIntent\?\.before/,
    'Root may bypass only its exact, unexpired process-local shadow',
  )
  assert.match(runStreamRoute, /tryRichStreamHandoff\(\)/)
  assert.match(runStreamRoute, /attachSubscriber\(initialRun\.conversation_id, writer\)/)
  assert.match(runStreamRoute, /model_resolution_snapshot/)
  assert.match(runStreamRoute, /resolvePublicCompactionCapacity\(job, getAliasCapabilities\)/)
  assert.match(runStreamRoute, /if \(!handedOffToBroadcast\) await writer\.close/)

  console.log('root-stream-visibility:verify passed')
}

void main()
