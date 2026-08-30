// Memory Selector — chooses relevant memories to inject into conversation context
// Simplified approach: for small memory sets (<= 20), load all.
// For larger sets, always include user+feedback, search project+reference by keywords.

import { MemoryDocument } from '../db/memory-models'
import { listMemories, searchMemories, markMemoriesAccessed } from '../db/memory-repository'

const MAX_MEMORIES = 10
const SMALL_SET_THRESHOLD = 20

/**
 * Select relevant memories for a given user message.
 * Returns up to MAX_MEMORIES memories, prioritizing user and feedback types.
 */
export async function selectMemories(
  userId: string,
  userMessage: string,
  limit = MAX_MEMORIES
): Promise<MemoryDocument[]> {
  const allMemories = await listMemories(userId)

  // Small set: return everything (no selection needed)
  if (allMemories.length <= SMALL_SET_THRESHOLD) {
    const selected = allMemories.slice(0, limit)
    await markMemoriesAccessed(userId, selected.map(m => m.memory_id))
    return selected
  }

  // Larger set: always include user + feedback, search project + reference
  const alwaysInclude = allMemories.filter(
    m => m.type === 'user' || m.type === 'feedback'
  )

  const remaining = limit - alwaysInclude.length
  let searched: MemoryDocument[] = []

  if (remaining > 0 && userMessage.trim()) {
    searched = await searchMemories(userId, userMessage, remaining + 10)
    // Filter out already-included memories
    const includedIds = new Set(alwaysInclude.map(m => m.memory_id))
    searched = searched.filter(m => !includedIds.has(m.memory_id)).slice(0, remaining)
  }

  const selected = [...alwaysInclude, ...searched].slice(0, limit)
  await markMemoriesAccessed(userId, selected.map(m => m.memory_id))
  return selected
}
