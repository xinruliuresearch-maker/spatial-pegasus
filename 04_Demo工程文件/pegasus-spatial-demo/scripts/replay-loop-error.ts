/**
 * Replay a logged agent-loop failure verbatim against NewAPI /v1/messages.
 * Use this to:
 *   - decide if the 422 was transient (re-run succeeds) vs structural (still fails)
 *   - bisect the payload by passing --max-tokens / --no-tools etc.
 *
 * Usage:
 *   npx tsx scripts/replay-loop-error.ts                         # replay most recent error
 *   npx tsx scripts/replay-loop-error.ts --n 2                   # replay 2nd-most-recent
 *   npx tsx scripts/replay-loop-error.ts --max-tokens 8192       # override max_tokens
 *   npx tsx scripts/replay-loop-error.ts --no-tools              # drop tools[] to test if tool schemas broke
 *   npx tsx scripts/replay-loop-error.ts --stream false          # send without stream=true
 */

import fs from 'fs'
import path from 'path'
import mongoose from 'mongoose'
import { requireMongoUri, requireRuntimeEnv } from './runtime-env'

const envFile = path.join(process.cwd(), '.env.local')
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (!m) continue
    const [, k, v] = m
    if (!process.env[k]) process.env[k] = v.replace(/^["']|["']$/g, '')
  }
}

const MONGODB_URI = requireMongoUri()
const LLM_BASE_URL = requireRuntimeEnv('LLM_BASE_URL').replace(/\/+$/, '')
const LLM_API_KEY_ORCHESTRATOR = requireRuntimeEnv('LLM_API_KEY_ORCHESTRATOR')
const Schema = new mongoose.Schema({}, { collection: 'apicalllogs', strict: false })
const ApiLog = mongoose.models.ReplayInspector || mongoose.model('ReplayInspector', Schema)

interface LoopErrorDoc {
  timestamp: Date | string
  model: string
  error_message?: string
  // request_body is the full Anthropic Messages API request body which we
  // mutate dynamically (overriding max_tokens, dropping tools, etc.). Scoping
  // the escape hatch here is cleaner than `as any[]` on the whole query.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  request_body?: any
}

async function main() {
  const args = process.argv.slice(2)
  const parse = (flag: string, def: string | null = null): string | null => {
    const i = args.indexOf(flag)
    if (i < 0) return def
    return args[i + 1] ?? ''
  }
  const nth = parseInt(parse('--n', '1') ?? '1', 10)
  const overrideMaxTokens = parse('--max-tokens')
  const noTools = args.includes('--no-tools')
  const streamArg = parse('--stream', 'true')

  await mongoose.connect(MONGODB_URI)
  const docs = await ApiLog.find({ source: 'agent-loop', status: 'error' })
    .sort({ timestamp: -1 })
    .limit(nth)
    .lean<LoopErrorDoc[]>()
  await mongoose.disconnect()

  const doc = docs[nth - 1]
  if (!doc) {
    console.error(`No logged error at position ${nth}`)
    process.exit(1)
  }
  console.log(`replaying log from ${doc.timestamp}`)
  console.log(`orig model     : ${doc.model}`)
  console.log(`orig error     : ${doc.error_message?.slice(0, 200)}`)
  console.log('')

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body: any = { ...doc.request_body }

  if (overrideMaxTokens) {
    const m = parseInt(overrideMaxTokens, 10)
    console.log(`override max_tokens: ${body.max_tokens} → ${m}`)
    body.max_tokens = m
  }
  if (noTools) {
    console.log(`dropping ${(body.tools?.length ?? 0)} tools[]`)
    delete body.tools
  }
  if (streamArg !== 'false') {
    body.stream = true
  }

  console.log(`sending model=${body.model} max_tokens=${body.max_tokens} tools=${body.tools?.length ?? 0} stream=${!!body.stream}`)
  console.log('')

  const start = Date.now()
  const res = await fetch(`${LLM_BASE_URL}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${LLM_API_KEY_ORCHESTRATOR}`,
      'HTTP-Referer': process.env.APP_PUBLIC_URL || 'http://localhost:3200',
      'X-Title': 'Sci-Pegasus-Replay',
    },
    body: JSON.stringify(body),
  })
  const elapsed = Date.now() - start

  console.log(`HTTP ${res.status} in ${elapsed}ms`)
  console.log(`content-type: ${res.headers.get('content-type')}`)
  console.log('')

  if (!res.ok) {
    const t = await res.text()
    console.log('response body:')
    console.log(t)
    return
  }

  // Successful — just print the first ~500 chars of the stream / body
  if (body.stream) {
    const reader = res.body!.getReader()
    const dec = new TextDecoder()
    let seen = 0
    let preview = ''
    while (seen < 2000) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = dec.decode(value, { stream: true })
      preview += chunk
      seen += chunk.length
    }
    try { reader.cancel() } catch { /* ignore */ }
    console.log('stream preview (first 2KB):')
    console.log(preview.slice(0, 2000))
  } else {
    const t = await res.text()
    console.log('response preview:')
    console.log(t.slice(0, 2000))
  }
}

main().catch(err => { console.error(err); process.exit(1) })
