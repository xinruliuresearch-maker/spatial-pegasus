/**
 * Breakdown of what's in a specific turn's request body (any status).
 * Use to find out where unexpected tokens came from.
 *
 * Usage:
 *   npx tsx scripts/inspect-turn.ts <conv_id> <turn_number>
 *   npx tsx scripts/inspect-turn.ts latest 3    # latest conv's turn 3
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
const ApiLog = mongoose.models.TurnInspector || mongoose.model('TurnInspector', Schema)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function estimateTokensChars(s: any): number {
  if (s == null) return 0
  const str = typeof s === 'string' ? s : JSON.stringify(s)
  return Math.ceil(str.length / 4)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function summarizeBlock(block: any): { desc: string; chars: number; tokenEst: number } {
  if (!block || typeof block !== 'object') {
    const s = String(block)
    return { desc: s.slice(0, 60), chars: s.length, tokenEst: estimateTokensChars(s) }
  }
  const t = block.type
  if (t === 'text') {
    const text = block.text ?? ''
    return {
      desc: `text: ${String(text).slice(0, 80).replace(/\n/g, ' ')}`,
      chars: text.length,
      tokenEst: estimateTokensChars(text),
    }
  }
  if (t === 'image') {
    const src = block.source || {}
    const base64Len = src.data ? String(src.data).length : 0
    return {
      desc: `image(${src.media_type ?? '?'}) base64=${base64Len}ch`,
      chars: base64Len,
      tokenEst: Math.ceil(base64Len * 0.125), // conservative raster estimate
    }
  }
  if (t === 'tool_use') {
    const inputStr = block.input ? JSON.stringify(block.input) : ''
    return {
      desc: `tool_use name=${block.name} input=${inputStr.length}ch`,
      chars: inputStr.length,
      tokenEst: estimateTokensChars(inputStr),
    }
  }
  if (t === 'tool_result') {
    let chars = 0
    let contentDesc = ''
    const c = block.content
    if (typeof c === 'string') {
      chars = c.length
      contentDesc = `str(${c.length})`
    } else if (Array.isArray(c)) {
      chars = JSON.stringify(c).length
      const imgs = c.filter((p: { type: string }) => p.type === 'image').length
      const texts = c.filter((p: { type: string }) => p.type === 'text').length
      contentDesc = `arr(${c.length}: ${imgs} img + ${texts} text)`
    } else {
      chars = JSON.stringify(c ?? '').length
      contentDesc = `${typeof c}`
    }
    return {
      desc: `tool_result ${contentDesc}`,
      chars,
      tokenEst: estimateTokensChars(c),
    }
  }
  if (t === 'thinking') {
    const text = block.thinking ?? ''
    return { desc: `thinking(${text.length}ch)`, chars: text.length, tokenEst: estimateTokensChars(text) }
  }
  const str = JSON.stringify(block)
  return { desc: `${t}: ${str.slice(0, 60)}`, chars: str.length, tokenEst: estimateTokensChars(str) }
}

async function main() {
  const [convArg, turnArg] = process.argv.slice(2)
  if (!convArg || turnArg === undefined) {
    console.error('Usage: npx tsx scripts/inspect-turn.ts <conv_id|latest> <turn_number>')
    process.exit(1)
  }
  const turn = parseInt(turnArg, 10)
  await mongoose.connect(MONGODB_URI)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let doc: any
  if (convArg === 'latest') {
    doc = await ApiLog.findOne({ source: 'agent-loop', turn_number: turn })
      .sort({ timestamp: -1 })
      .lean()
  } else {
    doc = await ApiLog.findOne({ source: 'agent-loop', conversation_id: convArg, turn_number: turn })
      .sort({ timestamp: -1 })
      .lean()
  }
  await mongoose.disconnect()

  if (!doc) {
    console.error(`No agent-loop log found for conv=${convArg} turn=${turn}`)
    process.exit(1)
  }

  console.log(`conv       : ${doc.conversation_id}`)
  console.log(`timestamp  : ${doc.timestamp}`)
  console.log(`model      : ${doc.model}`)
  console.log(`turn       : ${doc.turn_number}`)
  console.log(`status     : ${doc.status}`)
  console.log(`billed in  : ${doc.input_tokens} + cache_read ${doc.cache_read_tokens} + cache_create ${doc.cache_creation_tokens}`)
  console.log(`billed out : ${doc.output_tokens}`)
  console.log('')

  const req = doc.request_body ?? {}
  const reqBodySize = JSON.stringify(req).length
  console.log(`request body: ${reqBodySize.toLocaleString()} chars (~${Math.ceil(reqBodySize/1024)}KB)`)
  console.log('')

  // System
  let sysChars = 0, sysTokens = 0
  if (Array.isArray(req.system)) {
    console.log(`system (${req.system.length} blocks):`)
    for (const [i, b] of req.system.entries()) {
      const s = summarizeBlock(b)
      sysChars += s.chars
      sysTokens += s.tokenEst
      console.log(`  [${i}] ${s.desc} | ${s.chars}ch ~${s.tokenEst}tk`)
    }
  }
  console.log(`system total: ${sysChars}ch ~${sysTokens}tk`)
  console.log('')

  // Tools
  const toolsSize = req.tools ? JSON.stringify(req.tools).length : 0
  console.log(`tools: ${req.tools?.length ?? 0} | serialized=${toolsSize.toLocaleString()}ch ~${estimateTokensChars(req.tools)}tk`)
  console.log('')

  // Messages
  const messages = Array.isArray(req.messages) ? req.messages : []
  console.log(`messages (${messages.length}):`)
  let totalMsgChars = 0, totalMsgTokens = 0
  for (const [i, m] of messages.entries()) {
    const cnt = Array.isArray(m.content) ? m.content : [m.content]
    let msgChars = 0, msgTokens = 0
    const blockDescs: string[] = []
    for (const b of cnt) {
      const s = summarizeBlock(b)
      msgChars += s.chars
      msgTokens += s.tokenEst
      blockDescs.push(s.desc)
    }
    totalMsgChars += msgChars
    totalMsgTokens += msgTokens
    const bar = '█'.repeat(Math.min(40, Math.round(msgTokens / 1000)))
    console.log(`  [${String(i).padStart(2)}] ${m.role.padEnd(9)} ${String(msgChars).padStart(7)}ch ~${String(msgTokens).padStart(6)}tk ${bar}`)
    for (const d of blockDescs) {
      console.log(`        ${d}`)
    }
  }
  console.log('')
  console.log(`messages total: ${totalMsgChars.toLocaleString()}ch ~${totalMsgTokens.toLocaleString()}tk`)
  console.log(`grand total   : ${(sysChars + toolsSize + totalMsgChars).toLocaleString()}ch ~${(sysTokens + estimateTokensChars(req.tools) + totalMsgTokens).toLocaleString()}tk`)
}

main().catch(err => { console.error(err); process.exit(1) })
