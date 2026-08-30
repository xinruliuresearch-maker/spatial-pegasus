import type { UpdateQuery } from 'mongoose'
import type {
  ConversationMessage,
} from '../types'
import type {
  FrozenProfileSnapshot,
  FrozenProjectContextSnapshot,
  PersistentHippocampusState,
} from './types'
import {
  AgentExecutionSlotModel,
  AgentSessionRuntimeModel,
} from '../agent-team/models'
import { validateExecutionFence } from '../agent-team/repository'
import type { AgentSessionRuntimeRecord } from '../agent-team/types'
import { validateAgentRunLeaseFence } from './repository'

export interface MemberSessionHippocampusState extends PersistentHippocampusState {
  project_context_snapshot?: FrozenProjectContextSnapshot | null
  profile_snapshot?: FrozenProfileSnapshot | null
  prompt_cache_last_activity_at?: Date | null
}

export interface MemberSessionLeaseIdentity {
  teamId: string
  userId: string
  agentId: string
  sessionId: string
  runId: string
  ownerId: string
  sessionFenceToken: string
}

export interface MemberExecutionFenceIdentity extends MemberSessionLeaseIdentity {
  executionFenceToken: string
}

export class MemberSessionLeaseLostError extends Error {
  readonly code = 'MEMBER_SESSION_LEASE_LOST'

  constructor(public readonly runId: string) {
    super(`Member Agent session lease was lost for Run ${runId}`)
    this.name = 'MemberSessionLeaseLostError'
  }
}

function sessionFenceFilter(
  lease: MemberSessionLeaseIdentity,
): Record<string, unknown> {
  return {
    session_id: lease.sessionId,
    team_id: lease.teamId,
    user_id: lease.userId,
    agent_id: lease.agentId,
    active_run_id: lease.runId,
    active_lease_owner_id: lease.ownerId,
    'run_lease.fence_token': lease.sessionFenceToken,
    'run_lease.expires_at': { $gt: new Date() },
  }
}

function copyMessage(message: ConversationMessage): ConversationMessage {
  return structuredClone(message)
}

export function memberSessionHippocampus(
  session: AgentSessionRuntimeRecord,
): MemberSessionHippocampusState {
  const raw = session.hippocampus as Partial<MemberSessionHippocampusState> | undefined
  return {
    snapshot_version: raw?.snapshot_version ?? 1,
    telemetry: raw?.telemetry ?? null,
    breaker_state: raw?.breaker_state ?? null,
    rapid_refills: raw?.rapid_refills ?? 0,
    turns_since_merge: raw?.turns_since_merge ?? 0,
    ...(raw?.last_settled_compaction_id
      ? { last_settled_compaction_id: raw.last_settled_compaction_id }
      : {}),
    ...(raw?.active_compaction ? { active_compaction: raw.active_compaction } : {}),
    ...(raw?.project_context_snapshot
      ? { project_context_snapshot: raw.project_context_snapshot }
      : {}),
    ...(raw?.profile_snapshot ? { profile_snapshot: raw.profile_snapshot } : {}),
    ...(raw?.prompt_cache_last_activity_at
      ? { prompt_cache_last_activity_at: new Date(raw.prompt_cache_last_activity_at) }
      : {}),
  }
}

export async function loadFencedMemberSession(
  lease: MemberSessionLeaseIdentity,
): Promise<AgentSessionRuntimeRecord | null> {
  return AgentSessionRuntimeModel.findOne(sessionFenceFilter(lease))
    .lean<AgentSessionRuntimeRecord>()
}

export async function validateMemberExecutionFences(
  lease: MemberExecutionFenceIdentity,
): Promise<boolean> {
  const [runAlive, teamFenceAlive, sessionTokenAlive, slotTokenAlive] = await Promise.all([
    validateAgentRunLeaseFence(lease.runId, lease.ownerId),
    validateExecutionFence({
      teamId: lease.teamId,
      userId: lease.userId,
      agentId: lease.agentId,
      sessionId: lease.sessionId,
      runId: lease.runId,
      ownerId: lease.ownerId,
    }),
    AgentSessionRuntimeModel.exists(sessionFenceFilter(lease)),
    AgentExecutionSlotModel.exists({
      team_id: lease.teamId,
      user_id: lease.userId,
      agent_id: lease.agentId,
      session_id: lease.sessionId,
      run_id: lease.runId,
      owner_id: lease.ownerId,
      fence_token: lease.executionFenceToken,
      expires_at: { $gt: new Date() },
    }),
  ])
  return runAlive
    && teamFenceAlive
    && Boolean(sessionTokenAlive)
    && Boolean(slotTokenAlive)
}

async function fencedUpdate(
  lease: MemberSessionLeaseIdentity,
  update: UpdateQuery<AgentSessionRuntimeRecord>,
): Promise<void> {
  const result = await AgentSessionRuntimeModel.updateOne(
    sessionFenceFilter(lease),
    update,
  )
  if (result.matchedCount !== 1) throw new MemberSessionLeaseLostError(lease.runId)
}

async function fencedPipelineUpdate(
  lease: MemberSessionLeaseIdentity,
  pipeline: Record<string, unknown>[],
): Promise<void> {
  const result = await AgentSessionRuntimeModel.collection.updateOne(
    sessionFenceFilter(lease),
    pipeline,
  )
  if (result.matchedCount !== 1) throw new MemberSessionLeaseLostError(lease.runId)
}

function durableMessageBatch(
  messages: readonly ConversationMessage[],
): ConversationMessage[] {
  const byId = new Map<string, ConversationMessage>()
  for (const message of messages) {
    if (!message.message_id) {
      throw new Error('Atomic member-session append requires a stable message_id.')
    }
    byId.delete(message.message_id)
    byId.set(message.message_id, copyMessage(message))
  }
  return [...byId.values()]
}

function reconcileMemberMessageArray(
  field: 'messages' | 'compacted_messages',
  batch: readonly ConversationMessage[],
): Record<string, unknown> {
  const messageIds = batch.map(message => message.message_id)
  return {
    $concatArrays: [
      {
        $filter: {
          input: { $ifNull: [`$${field}`, []] },
          as: 'existing_message',
          cond: {
            $not: [{ $in: ['$$existing_message.message_id', messageIds] }],
          },
        },
      },
      { $literal: batch },
    ],
  }
}

/**
 * Append an exact durable checkpoint without replaying messages after a crash.
 * One Agent owns a session at a time, so the fenced read followed by this
 * update is serialized by the session lease.
 */
export async function appendMemberSessionMessages(
  lease: MemberSessionLeaseIdentity,
  messages: readonly ConversationMessage[],
  _appendToCompacted: boolean,
): Promise<void> {
  if (messages.length === 0) return
  // Compatibility-only hint; document state at the atomic update is authoritative.
  void _appendToCompacted
  const batch = durableMessageBatch(messages)
  await fencedPipelineUpdate(lease, [{
    $set: {
      messages: reconcileMemberMessageArray('messages', batch),
      // Decide against the document in this same atomic pipeline. The durable
      // compaction worker may have installed compacted_messages after the Run
      // took its local `hasActiveCompactedContext` snapshot.
      compacted_messages: {
        $cond: [
          {
            $gt: [
              { $size: { $ifNull: ['$compacted_messages', []] } },
              0,
            ],
          },
          reconcileMemberMessageArray('compacted_messages', batch),
          { $ifNull: ['$compacted_messages', []] },
        ],
      },
      revision: { $add: [{ $ifNull: ['$revision', 0] }, 1] },
      context_revision: { $add: [{ $ifNull: ['$context_revision', 0] }, 1] },
    },
  }])
}

export async function replaceMemberCompactedMessages(
  lease: MemberSessionLeaseIdentity,
  messages: readonly ConversationMessage[],
): Promise<void> {
  await fencedUpdate(lease, {
    $set: { compacted_messages: messages.map(copyMessage) },
    $inc: { revision: 1, context_revision: 1 },
  })
}

export async function patchMemberSessionHippocampus(
  lease: MemberSessionLeaseIdentity,
  fields: Record<string, unknown>,
): Promise<void> {
  const set = Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [`hippocampus.${key}`, value]),
  )
  await fencedUpdate(lease, {
    $set: set,
    $inc: { 'hippocampus.snapshot_version': 1, revision: 1 },
  })
}

export async function clearMemberCompactionCheckpoint(
  lease: MemberSessionLeaseIdentity,
): Promise<void> {
  await fencedUpdate(lease, {
    $unset: { 'hippocampus.active_compaction': 1 },
    $inc: { 'hippocampus.snapshot_version': 1, revision: 1 },
  })
}

export async function freezeMemberSessionModel(
  lease: MemberSessionLeaseIdentity,
  snapshot: NonNullable<AgentSessionRuntimeRecord['model_snapshot']>,
): Promise<void> {
  await fencedUpdate(lease, {
    $set: { model_snapshot: structuredClone(snapshot) },
    $inc: { revision: 1 },
  })
}

/**
 * Reopen starts a new generation/session, but the durable Agent identity keeps
 * its research history. Copy the previous generation only while the new
 * session is still pristine and fenced by its first Run.
 */
export async function inheritPreviousMemberGeneration(
  lease: MemberSessionLeaseIdentity,
  current: AgentSessionRuntimeRecord,
): Promise<AgentSessionRuntimeRecord> {
  if (current.generation <= 1 || current.messages.length > 0 || current.compacted_messages.length > 0) {
    return current
  }
  const previous = await AgentSessionRuntimeModel.findOne({
    team_id: current.team_id,
    user_id: current.user_id,
    agent_id: current.agent_id,
    generation: { $lt: current.generation },
  }).sort({ generation: -1 }).lean<AgentSessionRuntimeRecord>()
  if (!previous) return current

  const previousHippocampus = memberSessionHippocampus(previous)
  delete previousHippocampus.active_compaction
  const result = await AgentSessionRuntimeModel.updateOne(
    {
      ...sessionFenceFilter(lease),
      generation: current.generation,
      messages: { $size: 0 },
      compacted_messages: { $size: 0 },
    },
    {
      $set: {
        messages: structuredClone(previous.messages),
        compacted_messages: structuredClone(previous.compacted_messages),
        hippocampus: previousHippocampus,
      },
      $inc: { revision: 1, context_revision: 1 },
    },
  )
  if (result.matchedCount !== 1) {
    const winner = await loadFencedMemberSession(lease)
    if (!winner) throw new MemberSessionLeaseLostError(lease.runId)
    return winner
  }
  const inherited = await loadFencedMemberSession(lease)
  if (!inherited) throw new MemberSessionLeaseLostError(lease.runId)
  return inherited
}
