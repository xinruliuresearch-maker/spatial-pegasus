import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  applyCompactionPresentationToParts,
  compactionPresentation,
  contextUsageFromTokenEvent,
} from '../../../hooks/chat-compaction-state'

const useChatSource = readFileSync(
  join(process.cwd(), 'hooks', 'useChat.ts'),
  'utf8',
)
const routeSource = readFileSync(
  join(process.cwd(), 'app', 'api', 'chat', 'route.ts'),
  'utf8',
)
const messageBubbleSource = readFileSync(
  join(process.cwd(), 'components', 'chat', 'MessageBubble.tsx'),
  'utf8',
)
const runStreamSource = readFileSync(
  join(process.cwd(), 'app', 'api', 'chat', 'runs', '[runId]', 'stream', 'route.ts'),
  'utf8',
)
const compactionStatusRouteSource = readFileSync(
  join(process.cwd(), 'app', 'api', 'conversations', '[id]', 'compaction', 'route.ts'),
  'utf8',
)
const chatInputSource = readFileSync(
  join(process.cwd(), 'components', 'chat', 'ChatInput.tsx'),
  'utf8',
)

assert.match(
  useChatSource,
  /\.\.\.\(conversationId \? \{ conversation_id: conversationId \} : \{\}\)/,
  'new projects must omit conversation_id instead of serializing null',
)

assert.equal(
  contextUsageFromTokenEvent({ total_input_tokens: 185_000, overhead_tokens: 5_000 }),
  null,
  'a token event without server capacity must hide the gauge, not invent 200K',
)
assert.deepEqual(contextUsageFromTokenEvent({
  total_input_tokens: 90_000,
  overhead_tokens: 10_000,
  context_window: 128_000,
  max_output_tokens: 16_000,
}), {
  compressible: 80_000,
  threshold: 112_000,
})
for (const status of ['queued', 'summarizing', 'summary_ready', 'merge_prepared', 'retryable', 'failed', 'cancelled', 'superseded'] as const) {
  assert.notEqual(
    compactionPresentation(status).action,
    '上下文压缩完成',
    `${status} must never render as successful completion`,
  )
}
assert.equal(compactionPresentation('merged').action, '上下文压缩完成')
const once = applyCompactionPresentationToParts([], 'queued')
const twice = applyCompactionPresentationToParts(once, 'summarizing')
assert.equal(twice.length, 1, 'same Job state progression updates one row instead of duplicating it')
assert.equal(twice[0].type === 'tool_call' && twice[0].action, '正在生成上下文摘要…')

assert.doesNotMatch(
  useChatSource,
  /200_000\s*-\s*overhead/,
  'client context capacity must not be hard-coded',
)
assert.match(useChatSource, /contextUsage\?: ContextUsageState \| null/)
assert.match(useChatSource, /setContextUsage\(cached\.contextUsage \?\? null\)/)
assert.match(useChatSource, /compactionPollsRef = useRef\(new Map<string, AbortController>\(\)\)/)
assert.match(useChatSource, /setTimeout\(resolve, 2_000\)/)
assert.match(useChatSource, /status === 'merged'\) setScopedContextUsage\(myKey, null\)/)
assert.match(useChatSource, /evtType === 'compaction_done'[\s\S]{0,120}setScopedContextUsage\(myKey, null\)/)
assert.match(runStreamSource, /type: 'compaction_status'/)
assert.match(runStreamSource, /compactionKey !== lastCompactionKey/)
assert.match(runStreamSource, /observedRunStatus !== 'running'/)
assert.match(compactionStatusRouteSource, /owner_kind: 'conversation'/)
assert.match(compactionStatusRouteSource, /Conversation\.exists\(\{ conversation_id: id, user_id: userId \}\)/)
assert.doesNotMatch(compactionStatusRouteSource, /getConversation\(/)
assert.doesNotMatch(
  compactionStatusRouteSource,
  /\.select\([^)]*(messages|compacted_messages|output)/,
  '2s status polling must never hydrate the large Conversation payload',
)
assert.doesNotMatch(compactionStatusRouteSource, /frozen_prefix|summary:/)
assert.match(compactionStatusRouteSource, /model_resolution_snapshot/)
assert.match(compactionStatusRouteSource, /resolvePublicCompactionCapacity\(job, getAliasCapabilities\)/)
assert.match(runStreamSource, /model_resolution_snapshot/)
assert.match(runStreamSource, /resolvePublicCompactionCapacity\(job, getAliasCapabilities\)/)
assert.match(routeSource, /context_window: modelCapabilities\.contextWindow/)
assert.match(routeSource, /input_limit_tokens: Math\.max/)
assert.match(routeSource, /max_output_tokens: modelCapabilities\.maxOutputTokens/)
assert.match(chatInputSource, /CONTEXT —/)
assert.match(
  routeSource,
  /const conversation_id = rawConversationId \?\? undefined/,
  'the API must tolerate legacy null conversation identities',
)

assert.match(
  messageBubbleSource,
  /parts\.length === 0 && \(isStreaming \|\| message\.content\.trim\(\)\.length > 0\)/,
  'pre-SSE waiting and content-only error states must enter FinalResponse',
)

assert.ok(
  useChatSource.indexOf('void consumeReconnectStream(myKey, detachedRunId)')
    < useChatSource.indexOf('const res = await fetch(`/api/conversations/${myKey}`)'),
  'Runner reconnect must start before secondary artifact hydration',
)
assert.match(
  messageBubbleSource,
  /\{shouldRenderFinal && \(/,
  'assistant rendering must use the empty-parts fallback',
)

console.log('chat-submission-contracts:verify passed')
