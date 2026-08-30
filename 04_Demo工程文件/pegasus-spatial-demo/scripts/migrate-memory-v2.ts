import { createHash } from 'crypto'
import { connectDB } from '../lib/db/mongodb'
import { Memory } from '../lib/db/memory-models'
import { MemoryCandidate, MemoryHistoryEvent } from '../lib/memory-v2/models'
import { buildSearchText } from '../lib/memory-v2/search'
import { estimateHistoryEventTokens } from '../lib/memory-v2/capacity'

const apply = process.argv.includes('--apply')
const stableId = (prefix: string, value: string) => `${prefix}_legacy_${createHash('sha256').update(value).digest('hex').slice(0, 24)}`

async function main() {
  await connectDB()
  const legacy = await Memory.find({}).lean()
  const stats = { projects: 0, candidates: 0, skipped: 0 }
  for (const item of legacy) {
    if (item.type === 'project') {
      stats.projects += 1
      if (apply) {
        const eventId = stableId('hist', item.memory_id)
        await MemoryHistoryEvent.updateOne(
          { event_id: eventId },
          { $setOnInsert: {
            event_id: eventId, user_id: item.user_id, conversation_id: null,
            title: item.name, summary: item.description || item.content.slice(0, 500), detail: item.content,
            project: item.name, decisions: [], artifacts: [], tags: item.tags, search_terms: item.tags,
            normalized_search_text: buildSearchText({ title: item.name, summary: item.description, detail: item.content, tags: item.tags }),
            token_count: estimateHistoryEventTokens({
              title: item.name,
              summary: item.description || item.content.slice(0, 500),
              detail: item.content,
              project: item.name,
              tags: item.tags,
              search_terms: item.tags,
            }),
            source: 'legacy_migration', status: 'active', event_at: item.updated_at ?? item.created_at,
          } },
          { upsert: true }
        )
      }
    } else if (item.type === 'user' || item.type === 'feedback') {
      stats.candidates += 1
      if (apply) {
        const candidateId = stableId('cand', item.memory_id)
        await MemoryCandidate.updateOne(
          { candidate_id: candidateId },
          { $setOnInsert: {
            candidate_id: candidateId, user_id: item.user_id, run_id: `legacy_${item.memory_id}`,
            kind: 'preference', category: item.type === 'feedback' ? '反馈与修正' : '用户偏好',
            subject: item.name, statement: item.content, scope: 'general', polarity: 'neutral',
            evidence_refs: [], cluster_key: `${item.type}|${item.name}`.toLowerCase(),
            status: 'legacy_review', suppression_fingerprint: stableId('fp', item.memory_id),
          } },
          { upsert: true }
        )
      }
    } else stats.skipped += 1
  }
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', total: legacy.length, ...stats }, null, 2))
}

main().then(() => process.exit(0)).catch(error => {
  console.error(error)
  process.exit(1)
})
