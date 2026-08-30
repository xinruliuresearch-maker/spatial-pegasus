import { connectDB } from './mongodb'
import { Memory, MemoryDocument, MemoryType } from './memory-models'
import { randomUUID } from 'crypto'

export async function createMemory(
  userId: string,
  data: {
    name: string
    description?: string
    type: MemoryType
    content: string
    tags?: string[]
  }
): Promise<MemoryDocument> {
  await connectDB()
  return Memory.create({
    memory_id: randomUUID(),
    user_id: userId,
    name: data.name,
    description: data.description ?? '',
    type: data.type,
    content: data.content,
    tags: data.tags ?? [],
  })
}

export async function getMemory(memoryId: string, userId: string): Promise<MemoryDocument | null> {
  await connectDB()
  return Memory.findOne({ memory_id: memoryId, user_id: userId })
}

export async function listMemories(
  userId: string,
  filter?: { type?: MemoryType }
): Promise<MemoryDocument[]> {
  await connectDB()
  const query: Record<string, unknown> = { user_id: userId }
  if (filter?.type) query.type = filter.type
  return Memory.find(query).sort({ updated_at: -1 })
}

export async function updateMemory(
  memoryId: string,
  userId: string,
  updates: Partial<Pick<MemoryDocument, 'name' | 'description' | 'type' | 'content' | 'tags'>>
): Promise<MemoryDocument | null> {
  await connectDB()
  return Memory.findOneAndUpdate(
    { memory_id: memoryId, user_id: userId },
    { $set: updates },
    { returnDocument: 'after' }
  )
}

export async function deleteMemory(memoryId: string, userId: string): Promise<boolean> {
  await connectDB()
  const result = await Memory.deleteOne({ memory_id: memoryId, user_id: userId })
  return result.deletedCount > 0
}

/**
 * Search memories using MongoDB text index.
 * Returns results sorted by text search relevance score.
 */
export async function searchMemories(
  userId: string,
  query: string,
  limit = 10
): Promise<MemoryDocument[]> {
  await connectDB()
  if (!query.trim()) return listMemories(userId)
  return Memory.find(
    { $text: { $search: query }, user_id: userId },
    { score: { $meta: 'textScore' } }
  )
    .sort({ score: { $meta: 'textScore' } })
    .limit(limit)
}

/**
 * Increment access_count and update last_accessed_at for selected memories.
 */
export async function getMemoryStats(userId: string): Promise<{
  total: number
  by_type: Record<string, number>
  total_tokens: number
  token_limit: number
}> {
  await connectDB()
  const [total, groups, tokenAgg] = await Promise.all([
    Memory.countDocuments({ user_id: userId }),
    Memory.aggregate([
      { $match: { user_id: userId } },
      { $group: { _id: '$type', count: { $sum: 1 } } },
    ]),
    Memory.aggregate([
      { $match: { user_id: userId } },
      {
        $group: {
          _id: null,
          total_chars: {
            $sum: {
              $add: [
                { $strLenCP: { $ifNull: ['$name', ''] } },
                { $strLenCP: { $ifNull: ['$description', ''] } },
                { $strLenCP: { $ifNull: ['$content', ''] } },
              ],
            },
          },
        },
      },
    ]),
  ])
  const by_type: Record<string, number> = {}
  for (const g of groups) {
    by_type[g._id] = g.count
  }
  // Rough token estimate: Chinese ~1.5 tokens/char, English ~0.25 tokens/char
  // Use ~1 token per char as a practical middle ground
  const totalChars = tokenAgg[0]?.total_chars ?? 0
  const total_tokens = Math.ceil(totalChars * 1)
  return { total, by_type, total_tokens, token_limit: 20000 }
}

export async function markMemoriesAccessed(userId: string, memoryIds: string[]): Promise<void> {
  if (memoryIds.length === 0) return
  await connectDB()
  await Memory.updateMany(
    { memory_id: { $in: memoryIds }, user_id: userId },
    { $inc: { access_count: 1 }, $set: { last_accessed_at: new Date() } }
  )
}
