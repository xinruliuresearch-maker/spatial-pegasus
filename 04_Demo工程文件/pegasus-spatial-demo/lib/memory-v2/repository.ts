import { randomUUID } from 'crypto'
import { connectDB } from '../db/mongodb'
import {
  MemoryCandidate,
  MemoryHistoryEvent,
  MemoryRun,
  UserMemoryProfile,
  type MemoryCandidateDocument,
  type MemoryHistoryEventDocument,
  type MemoryRunDocument,
  type UserMemoryProfileDocument,
} from './models'
import { buildSearchText, scoreHistoryEvent } from './search'
import { compileProfile, preferenceFingerprint } from './profile'
import {
  DEFAULT_MEMORY_TOKEN_LIMIT,
  estimateHistoryEventTokens,
  type MemoryCapacity,
} from './capacity'
import type {
  AtomicPreference,
  HistoryEventInput,
  MemoryEvidenceRef,
  MemoryRunStatus,
  PreferenceCandidateInput,
  RecallHistoryArgs,
} from './types'

const id = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '')}`
export const MAX_ACTIVE_PREFERENCES = 30

export class MemoryProfileLimitError extends Error {
  constructor() {
    super(`User memory profile already has ${MAX_ACTIVE_PREFERENCES} active preferences`)
    this.name = 'MemoryProfileLimitError'
  }
}

export class MemoryQuotaExceededError extends Error {
  constructor(
    public readonly usedTokens: number,
    public readonly limitTokens: number,
    public readonly requestedTokens: number,
  ) {
    super(`Account memory quota exceeded: ${usedTokens} + ${requestedTokens} > ${limitTokens}`)
    this.name = 'MemoryQuotaExceededError'
  }
}

export async function getOrCreateProfile(userId: string): Promise<UserMemoryProfileDocument> {
  await connectDB()
  return UserMemoryProfile.findOneAndUpdate(
    { user_id: userId },
    {
      $setOnInsert: {
        user_id: userId,
        version: 1,
        preferences: [],
        compiled_text: '',
        token_count: 0,
        token_limit: DEFAULT_MEMORY_TOKEN_LIMIT,
      },
    },
    { upsert: true, returnDocument: 'after' }
  )
}

async function getHistoryMetrics(userId: string): Promise<{ tokens: number; count: number }> {
  const events = await MemoryHistoryEvent.find({ user_id: userId, status: 'active' })
    .select('title summary detail project decisions artifacts tags search_terms token_count')
    .lean()
  return {
    count: events.length,
    tokens: events.reduce((sum, event) => sum + (
      event.token_count > 0
        ? event.token_count
        : estimateHistoryEventTokens(event)
    ), 0),
  }
}

export async function getMemoryCapacity(userId: string): Promise<MemoryCapacity> {
  await connectDB()
  const [profile, history] = await Promise.all([
    getOrCreateProfile(userId),
    getHistoryMetrics(userId),
  ])
  const profileTokens = Math.max(0, profile.token_count || 0)
  const limit = Math.max(1, profile.token_limit || DEFAULT_MEMORY_TOKEN_LIMIT)
  const used = profileTokens + history.tokens
  return {
    used_tokens: used,
    limit_tokens: limit,
    remaining_tokens: Math.max(0, limit - used),
    usage_ratio: Math.min(1, used / limit),
    profile_tokens: profileTokens,
    history_tokens: history.tokens,
    history_events: history.count,
    is_full: used >= limit,
  }
}

export async function saveProfilePreferences(userId: string, preferences: AtomicPreference[]): Promise<UserMemoryProfileDocument> {
  await connectDB()
  const { text, tokenCount } = compileProfile(preferences)
  const [current, history] = await Promise.all([
    getOrCreateProfile(userId),
    getHistoryMetrics(userId),
  ])
  const limit = Math.max(1, current.token_limit || DEFAULT_MEMORY_TOKEN_LIMIT)
  const nextTotal = tokenCount + history.tokens
  if (nextTotal > limit && tokenCount > (current.token_count || 0)) {
    throw new MemoryQuotaExceededError(
      (current.token_count || 0) + history.tokens,
      limit,
      tokenCount - (current.token_count || 0),
    )
  }
  return UserMemoryProfile.findOneAndUpdate(
    { user_id: userId },
    {
      $set: { preferences, compiled_text: text, token_count: tokenCount },
      $inc: { version: 1 },
      $setOnInsert: { suppressed_fingerprints: [], token_limit: DEFAULT_MEMORY_TOKEN_LIMIT },
    },
    { upsert: true, returnDocument: 'after' }
  )
}

export async function addPreference(
  userId: string,
  input: Omit<AtomicPreference, 'preference_id' | 'created_at' | 'updated_at' | 'status'> & { status?: AtomicPreference['status'] }
): Promise<UserMemoryProfileDocument> {
  const profile = await getOrCreateProfile(userId)
  if (input.source_candidate_id) {
    const existing = profile.preferences.find(item => item.source_candidate_id === input.source_candidate_id)
    if (existing) return profile
  }
  if (profile.preferences.filter(item => item.status === 'active').length >= MAX_ACTIVE_PREFERENCES) {
    throw new MemoryProfileLimitError()
  }
  const now = new Date()
  const preference: AtomicPreference = {
    ...input,
    preference_id: id('pref'),
    status: input.status ?? 'active',
    created_at: now,
    updated_at: now,
  }
  return saveProfilePreferences(userId, [...profile.preferences, preference])
}

export async function updatePreference(
  userId: string,
  preferenceId: string,
  updates: Partial<Pick<AtomicPreference, 'category' | 'subject' | 'statement' | 'scope' | 'polarity' | 'status'>>
): Promise<UserMemoryProfileDocument | null> {
  const profile = await getOrCreateProfile(userId)
  let found = false
  const preferences = profile.preferences.map(item => {
    if (item.preference_id !== preferenceId) return item
    found = true
    return { ...item, ...updates, updated_at: new Date() } as AtomicPreference
  })
  return found ? saveProfilePreferences(userId, preferences) : null
}

export async function deletePreference(userId: string, preferenceId: string): Promise<UserMemoryProfileDocument | null> {
  await connectDB()
  const profile = await getOrCreateProfile(userId)
  const target = profile.preferences.find(item => item.preference_id === preferenceId)
  if (!target) return null
  const fingerprint = preferenceFingerprint(target)
  const preferences = profile.preferences.filter(item => item.preference_id !== preferenceId)
  const { text, tokenCount } = compileProfile(preferences)
  return UserMemoryProfile.findOneAndUpdate(
    { user_id: userId },
    {
      $set: { preferences, compiled_text: text, token_count: tokenCount },
      $addToSet: { suppressed_fingerprints: fingerprint },
      $inc: { version: 1 },
    },
    { returnDocument: 'after' }
  )
}

export async function createHistoryEvent(
  userId: string,
  conversationId: string | null,
  input: HistoryEventInput,
  source: MemoryHistoryEventDocument['source'] = 'memory_v2',
  sourceRunId: string | null = null
): Promise<MemoryHistoryEventDocument> {
  await connectDB()
  if (sourceRunId) {
    const existing = await MemoryHistoryEvent.findOne({ user_id: userId, source_run_id: sourceRunId })
    if (existing) return existing
  }
  const tokenCount = estimateHistoryEventTokens(input)
  const capacity = await getMemoryCapacity(userId)
  if (capacity.used_tokens + tokenCount > capacity.limit_tokens) {
    throw new MemoryQuotaExceededError(capacity.used_tokens, capacity.limit_tokens, tokenCount)
  }
  const document = {
    event_id: id('hist'), user_id: userId, conversation_id: conversationId, source_run_id: sourceRunId,
    ...input, detail: input.detail ?? '', project: input.project ?? '', decisions: input.decisions ?? [],
    artifacts: input.artifacts ?? [], tags: input.tags ?? [], search_terms: input.search_terms ?? [],
    normalized_search_text: buildSearchText(input), token_count: tokenCount, source, event_at: new Date(),
  }
  if (!sourceRunId) return MemoryHistoryEvent.create(document)
  return MemoryHistoryEvent.findOneAndUpdate(
    { user_id: userId, source_run_id: sourceRunId },
    { $setOnInsert: document },
    { upsert: true, returnDocument: 'after' }
  )
}

export async function listHistoryEvents(userId: string, limit = 50): Promise<MemoryHistoryEventDocument[]> {
  await connectDB()
  return MemoryHistoryEvent.find({ user_id: userId, status: 'active' }).sort({ event_at: -1 }).limit(Math.min(limit, 100))
}

export async function recallHistory(userId: string, args: RecallHistoryArgs): Promise<MemoryHistoryEventDocument[]> {
  await connectDB()
  const limit = Math.max(1, Math.min(args.limit ?? 4, 10))
  if (args.refs?.length) {
    const exact = await MemoryHistoryEvent.find({ user_id: userId, status: 'active', event_id: { $in: args.refs } })
    const order = new Map(args.refs.map((ref, index) => [ref, index]))
    return exact.sort((a, b) => (order.get(a.event_id) ?? 999) - (order.get(b.event_id) ?? 999)).slice(0, limit)
  }
  if (!args.query?.trim()) return []
  const candidates = await MemoryHistoryEvent.find({ user_id: userId, status: 'active' }).sort({ event_at: -1 }).limit(300)
  return candidates
    .map(event => ({ event, score: scoreHistoryEvent(event, args.query!) }))
    .filter(item => item.score >= 3)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(item => item.event)
}

export async function selectFirstTurnHistory(userId: string, query: string, limit = 4): Promise<MemoryHistoryEventDocument[]> {
  const matched = query.trim().length >= 4 ? await recallHistory(userId, { query, limit }) : []
  return matched.length ? matched : listHistoryEvents(userId, limit)
}

export async function updateHistoryEvent(
  userId: string,
  eventId: string,
  updates: Partial<HistoryEventInput>
): Promise<MemoryHistoryEventDocument | null> {
  await connectDB()
  const current = await MemoryHistoryEvent.findOne({ user_id: userId, event_id: eventId, status: 'active' })
  if (!current) return null
  const merged = {
    title: updates.title ?? current.title,
    summary: updates.summary ?? current.summary,
    detail: updates.detail ?? current.detail,
    project: updates.project ?? current.project,
    decisions: updates.decisions ?? current.decisions,
    artifacts: updates.artifacts ?? current.artifacts,
    tags: updates.tags ?? current.tags,
    search_terms: updates.search_terms ?? current.search_terms,
  }
  const nextTokenCount = estimateHistoryEventTokens(merged)
  const capacity = await getMemoryCapacity(userId)
  const currentTokenCount = current.token_count > 0
    ? current.token_count
    : estimateHistoryEventTokens(current)
  if (
    capacity.used_tokens - currentTokenCount + nextTokenCount > capacity.limit_tokens
    && nextTokenCount > currentTokenCount
  ) {
    throw new MemoryQuotaExceededError(
      capacity.used_tokens,
      capacity.limit_tokens,
      nextTokenCount - currentTokenCount,
    )
  }
  return MemoryHistoryEvent.findOneAndUpdate(
    { user_id: userId, event_id: eventId },
    { $set: { ...merged, normalized_search_text: buildSearchText(merged), token_count: nextTokenCount } },
    { returnDocument: 'after' }
  )
}

export async function deleteHistoryEvent(userId: string, eventId: string): Promise<boolean> {
  await connectDB()
  const result = await MemoryHistoryEvent.updateOne(
    { user_id: userId, event_id: eventId, status: 'active' },
    { $set: { status: 'deleted' } }
  )
  return result.modifiedCount > 0
}

export async function createMemoryRun(
  userId: string,
  conversationId: string,
  agentRunId?: string,
): Promise<MemoryRunDocument> {
  await connectDB()
  return MemoryRun.create({
    run_id: id('mrun'),
    agent_run_id: agentRunId ?? null,
    user_id: userId,
    conversation_id: conversationId,
    status: 'recording',
  })
}

export async function getMemoryRun(runId: string, userId: string): Promise<MemoryRunDocument | null> {
  await connectDB()
  return MemoryRun.findOne({ run_id: runId, user_id: userId })
}

export async function bindMemoryRunToAgentRun(
  runId: string,
  userId: string,
  agentRunId: string,
): Promise<void> {
  await connectDB()
  await MemoryRun.updateOne(
    { run_id: runId, user_id: userId },
    { $set: { agent_run_id: agentRunId } },
  )
}

export async function appendRunEvidence(runId: string, userId: string, evidence: MemoryEvidenceRef[]): Promise<void> {
  if (!evidence.length) return
  await connectDB()
  await MemoryRun.updateOne(
    { run_id: runId, user_id: userId, status: { $in: ['recording', 'awaiting_user'] } },
    { $push: { evidence: { $each: evidence } }, $set: { status: 'recording' } }
  )
}

export async function setMemoryRunStatus(
  runId: string,
  userId: string,
  status: MemoryRunStatus,
  error = ''
): Promise<void> {
  await connectDB()
  await MemoryRun.updateOne(
    { run_id: runId, user_id: userId },
    {
      $set: {
        status,
        error,
        available_at: status === 'queued' ? new Date() : undefined,
        completed_at: ['completed', 'discarded'].includes(status) ? new Date() : null,
        ...(status !== 'processing' ? { locked_until: null, lease_id: null } : {}),
      },
    }
  )
}

export async function leaseNextMemoryRun(leaseMs = 60_000): Promise<MemoryRunDocument | null> {
  await connectDB()
  const now = new Date()
  const leaseId = id('lease')
  return MemoryRun.findOneAndUpdate(
    {
      status: { $in: ['queued', 'processing'] },
      attempts: { $lt: 5 },
      available_at: { $lte: now },
      $or: [{ locked_until: null }, { locked_until: { $lte: now } }],
    },
    {
      $set: { status: 'processing', lease_id: leaseId, locked_until: new Date(now.getTime() + leaseMs) },
      $inc: { attempts: 1 },
    },
    { sort: { available_at: 1 }, returnDocument: 'after' }
  )
}

export async function releaseRunAfterFailure(run: MemoryRunDocument, message: string): Promise<void> {
  await connectDB()
  const terminal = run.attempts >= 5
  const delayMs = Math.min(15 * 60_000, 5_000 * 2 ** Math.max(0, run.attempts - 1))
  await MemoryRun.updateOne(
    { run_id: run.run_id, lease_id: run.lease_id },
    {
      $set: {
        status: terminal ? 'failed' : 'queued',
        error: message.slice(0, 2_000),
        available_at: new Date(Date.now() + delayMs),
        locked_until: null,
        lease_id: null,
      },
    }
  )
}

export async function createPreferenceCandidates(
  userId: string,
  runId: string,
  candidates: PreferenceCandidateInput[],
  evidence: MemoryEvidenceRef[]
): Promise<MemoryCandidateDocument[]> {
  await connectDB()
  const evidenceMap = new Map(evidence.map(item => [item.evidence_id, item]))
  const profile = await getOrCreateProfile(userId)
  const docs = candidates.flatMap(candidate => {
    const refs = candidate.evidence_ids.map(value => evidenceMap.get(value)).filter(Boolean) as MemoryEvidenceRef[]
    if (!refs.some(ref => ref.role === 'user')) return []
    const shape = {
      category: candidate.category.trim(),
      subject: candidate.subject.trim(),
      statement: candidate.statement.trim(),
      scope: candidate.scope?.trim() || 'general',
      polarity: candidate.polarity ?? 'neutral',
    }
    const fingerprint = preferenceFingerprint(shape)
    if (profile.suppressed_fingerprints.includes(fingerprint)) return []
    return [{
      candidate_id: id('cand'), user_id: userId, run_id: runId, kind: 'preference' as const,
      ...shape, evidence_refs: refs, cluster_key: `${shape.category}|${shape.subject}|${shape.scope}`.toLowerCase(),
      status: 'pending' as const, suppression_fingerprint: fingerprint,
    }]
  })
  if (!docs.length) return []
  await MemoryCandidate.bulkWrite(docs.map(document => ({
    updateOne: {
      filter: {
        user_id: document.user_id,
        run_id: document.run_id,
        suppression_fingerprint: document.suppression_fingerprint,
      },
      update: { $setOnInsert: document },
      upsert: true,
    },
  })), { ordered: false })
  return MemoryCandidate.find({ user_id: userId, run_id: runId })
}

export async function getMemoryActivity(userId: string): Promise<{
  pendingCount: number
  conflicts: MemoryCandidateDocument[]
  candidates: MemoryCandidateDocument[]
  runs: MemoryRunDocument[]
}> {
  await connectDB()
  const [pendingCount, conflicts, candidates, runs] = await Promise.all([
    MemoryCandidate.countDocuments({ user_id: userId, status: 'pending' }),
    MemoryCandidate.find({ user_id: userId, status: 'conflict' }).sort({ updated_at: -1 }).limit(30),
    MemoryCandidate.find({ user_id: userId }).sort({ updated_at: -1 }).limit(50),
    MemoryRun.find({ user_id: userId }).sort({ updated_at: -1 }).limit(30),
  ])
  return { pendingCount, conflicts, candidates, runs }
}

export async function resolveConflict(
  userId: string,
  candidateId: string,
  resolution: 'accept' | 'ignore',
  note = ''
): Promise<MemoryCandidateDocument | null> {
  await connectDB()
  return MemoryCandidate.findOneAndUpdate(
    { user_id: userId, candidate_id: candidateId, status: 'conflict' },
    { $set: { status: resolution === 'accept' ? 'pending' : 'ignored', resolution_note: note } },
    { returnDocument: 'after' }
  )
}

export async function claimPreferenceBatch(userId: string, size = 10): Promise<MemoryCandidateDocument[]> {
  await connectDB()
  const candidates = await MemoryCandidate.find({ user_id: userId, status: 'pending' })
    .sort({ created_at: 1 })
    .limit(size)
  if (candidates.length < size) return []
  const batchId = id('batch')
  const ids = candidates.map(item => item.candidate_id)
  const result = await MemoryCandidate.updateMany(
    { user_id: userId, candidate_id: { $in: ids }, status: 'pending' },
    { $set: { status: 'claimed', batch_id: batchId } }
  )
  if (result.modifiedCount !== size) {
    await MemoryCandidate.updateMany({ user_id: userId, batch_id: batchId }, { $set: { status: 'pending', batch_id: null } })
    return []
  }
  return MemoryCandidate.find({ user_id: userId, batch_id: batchId }).sort({ created_at: 1 })
}

export async function finalizeCandidate(
  userId: string,
  candidateId: string,
  status: 'promoted' | 'ignored' | 'conflict' | 'quota_blocked',
  note: string
): Promise<void> {
  await connectDB()
  await MemoryCandidate.updateOne(
    { user_id: userId, candidate_id: candidateId, status: 'claimed' },
    { $set: { status, resolution_note: note } }
  )
}

export async function resetClaimedBatch(userId: string, batchId: string): Promise<void> {
  await connectDB()
  await MemoryCandidate.updateMany(
    { user_id: userId, batch_id: batchId, status: 'claimed' },
    { $set: { status: 'pending', batch_id: null } }
  )
}
