/**
 * Show recent agent-loop API calls with status=error. Prints the request body
 * shape so we can see what NewAPI rejected (422, 429, 500, etc.).
 *
 * Usage:
 *   npx tsx scripts/inspect-loop-errors.ts       # last 5
 *   npx tsx scripts/inspect-loop-errors.ts 10
 */

import fs from 'fs'
import path from 'path'
import mongoose from 'mongoose'
import { requireMongoUri } from './runtime-env'

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
const Schema = new mongoose.Schema({}, { collection: 'apicalllogs', strict: false })
const ApiLog = mongoose.models.LoopErrInspector || mongoose.model('LoopErrInspector', Schema)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function describeBlock(block: any): string {
  if (!block || typeof block !== 'object') return String(block).slice(0, 80)
  const t = block.type
  if (t === 'text') {
    const text = typeof block.text === 'string' ? block.text : '(non-string text)'
    const cc = block.cache_control ? ' +cache' : ''
    return `text(${text.length}ch${cc}): ${text.slice(0, 120).replace(/\n/g, ' ')}`
  }
  if (t === 'image') {
    const src = block.source || {}
    const base = src.data ? `base64(${src.data.length}ch)` : src.url ? `url=${String(src.url).slice(0, 60)}` : '(no source)'
    return `image(${src.media_type ?? '?'}) ${base}`
  }
  if (t === 'tool_use') {
    const inputKeys = block.input ? Object.keys(block.input).join(',') : ''
    return `tool_use name=${block.name} id=${block.id?.slice(0, 8)}… input={${inputKeys}}`
  }
  if (t === 'tool_result') {
    const content = block.content
    let desc: string
    if (typeof content === 'string') desc = `string(${content.length}ch)`
    else if (Array.isArray(content)) desc = `array(${content.length} parts)`
    else desc = typeof content
    const err = block.is_error ? ' ERROR' : ''
    return `tool_result id=${String(block.tool_use_id).slice(0, 8)}… ${desc}${err}`
  }
  if (t === 'thinking') {
    return `thinking(${String(block.thinking ?? '').length}ch) sig=${block.signature ? 'yes' : 'no'}`
  }
  if (t === 'redacted_thinking') {
    return `redacted_thinking data=${String(block.data ?? '').slice(0, 40)}…`
  }
  return `${t}: ${JSON.stringify(block).slice(0, 100)}`
}

interface LoopErrorDoc {
  timestamp: Date | string
  conversation_id: string
  model: string
  turn_number: number
  duration_ms: number
  error_message?: string
  // request_body's internal shape is the full Anthropic Messages API request,
  // which we walk dynamically (req.model, req.system, req.tools, req.messages...)
  // — keeping it `any` here scopes the escape hatch to a single field instead
  // of bleeding through the whole script via `as any[]`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  request_body?: any
}

async function main() {
  const n = parseInt(process.argv[2] ?? '5', 10)
  await mongoose.connect(MONGODB_URI)

  const docs = await ApiLog.find({ source: 'agent-loop', status: 'error' })
    .sort({ timestamp: -1 })
    .limit(n)
    .lean<LoopErrorDoc[]>()

  if (!docs.length) {
    console.log('No agent-loop errors found.')
    await mongoose.disconnect()
    return
  }

  for (const d of docs) {
    console.log('='.repeat(80))
    console.log(`timestamp  : ${d.timestamp}`)
    console.log(`conv       : ${d.conversation_id}`)
    console.log(`model      : ${d.model}`)
    console.log(`turn       : ${d.turn_number}`)
    console.log(`duration   : ${d.duration_ms}ms`)
    console.log(`error      : ${d.error_message?.slice(0, 500)}`)
    console.log('')

    const req = d.request_body ?? {}
    console.log(`req.model          : ${req.model}`)
    console.log(`req.max_tokens     : ${req.max_tokens}`)
    console.log(`req.temperature    : ${req.temperature}`)
    console.log(`req.thinking       : ${JSON.stringify(req.thinking)}`)
    console.log(`req.system         : ${Array.isArray(req.system) ? `${req.system.length} blocks` : typeof req.system}`)
    if (Array.isArray(req.system)) {
      for (const [i, s] of req.system.entries()) {
        console.log(`  [${i}] ${describeBlock(s)}`)
      }
    }
    console.log(`req.tools          : ${Array.isArray(req.tools) ? `${req.tools.length} tools` : 'none'}`)
    if (Array.isArray(req.tools)) {
      console.log(`  names: ${req.tools.map((t: { name: string }) => t.name).join(', ')}`)
    }

    const messages = Array.isArray(req.messages) ? req.messages : []
    console.log(`req.messages       : ${messages.length} total`)
    for (const [i, m] of messages.entries()) {
      const cnt = Array.isArray(m.content) ? m.content : [m.content]
      console.log(`  [${i}] role=${m.role} (${cnt.length} block${cnt.length > 1 ? 's' : ''})`)
      for (const [j, b] of cnt.entries()) {
        console.log(`    [${j}] ${describeBlock(b)}`)
      }
    }
    console.log('')
  }

  await mongoose.disconnect()
}

main().catch(err => { console.error(err); process.exit(1) })
