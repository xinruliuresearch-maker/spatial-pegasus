import { createHash, randomUUID } from 'node:crypto'
import { connectDB } from '../db/mongodb'
import { AgentRun } from '../agent-runtime/models'
import {
  AgentCommandReceiptModel,
  AgentExecutionSlotModel,
  AgentMailboxMessageModel,
  AgentSessionRuntimeModel,
  AgentTeamModel,
  TeamAgentModel,
  TeamEventModel,
  TeamSupervisionBatchModel,
} from './models'
import {
  AgentCommandFenceLostError,
  AgentCommandInProgressError,
} from './errors'
import type {
  AgentExecutionSlotRecord,
  AgentMailboxMessageRecord,
  AgentSessionRuntimeRecord,
  AgentTeamRecord,
  CommandReceiptRecord,
  TeamEventRecord,
  TeamEventType,
  TeamSupervisionBatchRecord,
} from './types'

const DEFAULT_COMMAND_LEASE_MS = 30_000
const DEFAULT_EXECUTION_LEASE_MS = 45_000
const DEFAULT_MAILBOX_CLAIM_STALE_MS = 5 * 60_000
const DEFAULT_SUPERVISION_LEASE_MS = 60_000

function isDuplicateKey(error: unknown): boolean {
  return (error as { code?: number }).code === 11000
}

function asRecord<T>(value: { toObject(): unknown }): T {
  return value.toObject() as T
}

export interface CommandLease<T = unknown> {
  receipt: CommandReceiptRecord
  lease_owner_id: string
  replay?: T
}

export interface AppendTeamEventInput {
  teamId: string
  userId: string
  type: TeamEventType
  actorAgentId?: string
  subjectAgentId?: string
  taskId?: string
  runId?: string
  payload?: Record<string, unknown>
  dedupeKey?: string
}

export interface ClaimExecutionSlotInput {
  teamId: string
  userId: string
  agentId: string
  sessionId: string
  runId: string
  ownerId: string
  limit?: number
  leaseMs?: number
}

export interface ExecutionLeaseIdentity {
  runId: string
  ownerId: string
  fenceToken: string
}

export interface SupervisionLeaseIdentity {
  ownerId: string
  leaseToken: string
}

export interface ClaimAgentSessionRunInput {
  teamId: string
  userId: string
  sessionId: string
  runId: string
  ownerId: string
  leaseMs?: number
}

export class MongoAgentTeamRepository {
  async connect(): Promise<void> {
    await connectDB()
  }

  async beginCommand<T = unknown>(input: {
    teamId: string
    userId: string
    actorAgentId: string
    runId: string
    toolUseId: string
    commandName: string
    commandKey: string
    reservations: Record<string, string>
    leaseMs?: number
  }): Promise<CommandLease<T>> {
    await this.connect()
    const now = new Date()
    const leaseOwnerId = `command_owner_${randomUUID()}`
    const leaseExpiresAt = new Date(now.getTime() + (input.leaseMs ?? DEFAULT_COMMAND_LEASE_MS))
    try {
      const created = await AgentCommandReceiptModel.create({
        receipt_id: `command_receipt_${randomUUID()}`,
        team_id: input.teamId,
        user_id: input.userId,
        command_key: input.commandKey,
        command_name: input.commandName,
        run_id: input.runId,
        tool_use_id: input.toolUseId,
        actor_agent_id: input.actorAgentId,
        status: 'processing',
        reservations: input.reservations,
        response: null,
        error: null,
        attempt: 1,
        lease_owner_id: leaseOwnerId,
        lease_expires_at: leaseExpiresAt,
        completed_at: null,
      })
      return { receipt: asRecord<CommandReceiptRecord>(created), lease_owner_id: leaseOwnerId }
    } catch (error) {
      if (!isDuplicateKey(error)) throw error
    }

    const existing = await AgentCommandReceiptModel.findOne({
      team_id: input.teamId,
      user_id: input.userId,
      command_key: input.commandKey,
    })
    if (!existing) throw new AgentCommandInProgressError(input.commandKey)
    if (existing.status === 'completed') {
      return {
        receipt: asRecord<CommandReceiptRecord>(existing),
        lease_owner_id: '',
        replay: existing.response as T,
      }
    }

    const reclaimed = await AgentCommandReceiptModel.findOneAndUpdate(
      {
        _id: existing._id,
        status: existing.status,
        $or: [
          { status: 'failed' },
          { lease_expires_at: { $lte: now } },
          { lease_expires_at: null },
        ],
      },
      {
        $set: {
          status: 'processing',
          lease_owner_id: leaseOwnerId,
          lease_expires_at: leaseExpiresAt,
          error: null,
        },
        $inc: { attempt: 1 },
      },
      { returnDocument: 'after' },
    )
    if (!reclaimed) throw new AgentCommandInProgressError(input.commandKey)
    return { receipt: asRecord<CommandReceiptRecord>(reclaimed), lease_owner_id: leaseOwnerId }
  }

  async completeCommand<T>(lease: CommandLease, response: T): Promise<void> {
    await this.connect()
    const completedAt = new Date()
    const result = await AgentCommandReceiptModel.updateOne(
      {
        receipt_id: lease.receipt.receipt_id,
        status: 'processing',
        lease_owner_id: lease.lease_owner_id,
        lease_expires_at: { $gt: completedAt },
      },
      {
        $set: {
          status: 'completed',
          response,
          error: null,
          completed_at: completedAt,
          lease_owner_id: null,
          lease_expires_at: null,
        },
      },
    )
    if (result.matchedCount !== 1) {
      throw new AgentCommandFenceLostError(lease.receipt.command_key)
    }
  }

  /**
   * Renew the command's own write permit. The AgentRun/Team fences authorize
   * minting and renewing this short child lease; every business-write phase
   * rechecks them around this CAS. This is the standalone-Mongo substitute for
   * a cross-collection transaction and prevents a reclaimed command owner from
   * finalizing another process's attempt.
   */
  async renewCommandLease(
    lease: CommandLease,
    leaseMs = DEFAULT_COMMAND_LEASE_MS,
  ): Promise<boolean> {
    await this.connect()
    const now = new Date()
    const result = await AgentCommandReceiptModel.updateOne(
      {
        receipt_id: lease.receipt.receipt_id,
        status: 'processing',
        lease_owner_id: lease.lease_owner_id,
        lease_expires_at: { $gt: now },
      },
      {
        $set: {
          lease_expires_at: new Date(now.getTime() + Math.max(1_000, leaseMs)),
        },
      },
    )
    return result.matchedCount === 1
  }

  async failCommand(lease: CommandLease, error: unknown): Promise<void> {
    await this.connect()
    await AgentCommandReceiptModel.updateOne(
      {
        receipt_id: lease.receipt.receipt_id,
        status: 'processing',
        lease_owner_id: lease.lease_owner_id,
      },
      {
        $set: {
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
          lease_owner_id: null,
          lease_expires_at: null,
        },
      },
    )
  }

  async appendEvent(input: AppendTeamEventInput): Promise<TeamEventRecord> {
    await this.connect()
    if (input.dedupeKey) {
      const existing = await TeamEventModel.findOne({
        team_id: input.teamId,
        user_id: input.userId,
        dedupe_key: input.dedupeKey,
      }).lean<TeamEventRecord>()
      if (existing) return existing
    }

    const team = await AgentTeamModel.findOneAndUpdate(
      { team_id: input.teamId, user_id: input.userId },
      { $inc: { next_event_seq: 1 } },
      { returnDocument: 'after' },
    )
    if (!team) throw new Error('Agent team is missing while appending an event.')
    const event = {
      event_id: `team_event_${randomUUID()}`,
      team_id: team.team_id,
      conversation_id: team.conversation_id,
      user_id: team.user_id,
      seq: team.next_event_seq,
      type: input.type,
      actor_agent_id: input.actorAgentId ?? null,
      subject_agent_id: input.subjectAgentId ?? null,
      task_id: input.taskId ?? null,
      run_id: input.runId ?? null,
      payload: input.payload ?? {},
      dedupe_key: input.dedupeKey ?? null,
      created_at: new Date(),
    } satisfies TeamEventRecord
    try {
      const created = await TeamEventModel.create(event)
      return asRecord<TeamEventRecord>(created)
    } catch (error) {
      if (!isDuplicateKey(error) || !input.dedupeKey) throw error
      const existing = await TeamEventModel.findOne({
        team_id: input.teamId,
        dedupe_key: input.dedupeKey,
      }).lean<TeamEventRecord>()
      if (!existing) throw error
      return existing
    }
  }

  async listEventsAfter(input: {
    teamId: string
    userId: string
    afterSeq?: number
    limit?: number
  }): Promise<TeamEventRecord[]> {
    await this.connect()
    const limit = Math.max(1, Math.min(input.limit ?? 200, 1_000))
    return TeamEventModel.find({
      team_id: input.teamId,
      user_id: input.userId,
      seq: { $gt: Math.max(0, input.afterSeq ?? 0) },
    }).sort({ seq: 1 }).limit(limit).lean<TeamEventRecord[]>()
  }

  async advanceSupervisionCursor(input: {
    teamId: string
    userId: string
    throughSeq: number
    lease?: SupervisionLeaseIdentity
  }): Promise<AgentTeamRecord | null> {
    await this.connect()
    const throughSeq = Math.max(0, Math.floor(input.throughSeq))
    const advanced = await AgentTeamModel.findOneAndUpdate(
      {
        team_id: input.teamId,
        user_id: input.userId,
        supervision_cursor: { $lt: throughSeq },
        ...(input.lease ? {
          supervision_lease_owner_id: input.lease.ownerId,
          supervision_lease_token: input.lease.leaseToken,
          supervision_lease_expires_at: { $gt: new Date() },
        } : {}),
      },
      { $set: { supervision_cursor: throughSeq } },
      { returnDocument: 'after' },
    ).lean<AgentTeamRecord>()
    if (advanced) return advanced
    return AgentTeamModel.findOne({
      team_id: input.teamId,
      user_id: input.userId,
      ...(input.lease ? {
        supervision_lease_owner_id: input.lease.ownerId,
        supervision_lease_token: input.lease.leaseToken,
        supervision_lease_expires_at: { $gt: new Date() },
      } : {}),
    }).lean<AgentTeamRecord>()
  }

  async claimSupervisionLease(input: {
    teamId: string
    userId: string
    ownerId: string
    leaseMs?: number
    now?: Date
  }): Promise<{ team: AgentTeamRecord; lease: SupervisionLeaseIdentity } | null> {
    await this.connect()
    const now = input.now ?? new Date()
    const leaseToken = `supervision_fence_${randomUUID()}`
    const team = await AgentTeamModel.findOneAndUpdate(
      {
        team_id: input.teamId,
        user_id: input.userId,
        status: 'active',
        $or: [
          { supervision_lease_expires_at: null },
          { supervision_lease_expires_at: { $exists: false } },
          { supervision_lease_expires_at: { $lte: now } },
        ],
      },
      {
        $set: {
          supervision_lease_owner_id: input.ownerId,
          supervision_lease_token: leaseToken,
          supervision_lease_expires_at: new Date(
            now.getTime() + Math.max(5_000, input.leaseMs ?? DEFAULT_SUPERVISION_LEASE_MS),
          ),
        },
      },
      { returnDocument: 'after' },
    ).lean<AgentTeamRecord>()
    return team ? { team, lease: { ownerId: input.ownerId, leaseToken } } : null
  }

  async releaseSupervisionLease(input: {
    teamId: string
    userId: string
    ownerId: string
    leaseToken: string
  }): Promise<boolean> {
    await this.connect()
    const result = await AgentTeamModel.updateOne(
      {
        team_id: input.teamId,
        user_id: input.userId,
        supervision_lease_owner_id: input.ownerId,
        supervision_lease_token: input.leaseToken,
      },
      {
        $set: {
          supervision_lease_owner_id: null,
          supervision_lease_token: null,
          supervision_lease_expires_at: null,
        },
      },
    )
    return result.modifiedCount === 1
  }

  async getOrCreateSupervisionBatch(input: {
    teamId: string
    userId: string
    afterSeq: number
    events: TeamEventRecord[]
  }): Promise<TeamSupervisionBatchRecord> {
    await this.connect()
    const existing = await TeamSupervisionBatchModel.findOne({
      team_id: input.teamId,
      user_id: input.userId,
      after_seq: input.afterSeq,
    }).lean<TeamSupervisionBatchRecord>()
    if (existing) return existing
    if (input.events.length === 0) throw new Error('A supervision batch requires at least one event.')
    const digest = createHash('sha256')
      .update(`${input.teamId}\u0000${input.afterSeq}`)
      .digest('hex')
      .slice(0, 40)
    try {
      const created = await TeamSupervisionBatchModel.create({
        batch_id: `team_supervision_batch_${digest}`,
        team_id: input.teamId,
        user_id: input.userId,
        after_seq: input.afterSeq,
        through_seq: input.events.at(-1)!.seq,
        events: input.events,
        message_ids: input.events.flatMap(event => (
          event.type === 'message_sent' && typeof event.payload.message_id === 'string'
            ? [event.payload.message_id]
            : []
        )),
        delivered_run_id: null,
        delivered_at: null,
      })
      return asRecord<TeamSupervisionBatchRecord>(created)
    } catch (error) {
      if (!isDuplicateKey(error)) throw error
      const winner = await TeamSupervisionBatchModel.findOne({
        team_id: input.teamId,
        user_id: input.userId,
        after_seq: input.afterSeq,
      }).lean<TeamSupervisionBatchRecord>()
      if (!winner) throw error
      return winner
    }
  }

  async markSupervisionBatchDelivered(input: {
    teamId: string
    userId: string
    batchId: string
    runId?: string | null
  }): Promise<boolean> {
    await this.connect()
    const result = await TeamSupervisionBatchModel.updateOne(
      {
        team_id: input.teamId,
        user_id: input.userId,
        batch_id: input.batchId,
        delivered_at: null,
      },
      {
        $set: {
          delivered_run_id: input.runId ?? null,
          delivered_at: new Date(),
        },
      },
    )
    return result.matchedCount === 1
  }

  async recoverExpiredExecutionSlots(input: {
    teamId?: string
    userId?: string
    now?: Date
  } = {}): Promise<string[]> {
    await this.connect()
    const expired = await AgentExecutionSlotModel.find({
      ...(input.teamId ? { team_id: input.teamId } : {}),
      ...(input.userId ? { user_id: input.userId } : {}),
      expires_at: { $lte: input.now ?? new Date() },
    }).lean<AgentExecutionSlotRecord[]>()
    const recovered: string[] = []
    for (const slot of expired) {
      const deleted = await AgentExecutionSlotModel.deleteOne({
        run_id: slot.run_id,
        owner_id: slot.owner_id,
        fence_token: slot.fence_token,
        expires_at: { $lte: input.now ?? new Date() },
      })
      if (deleted.deletedCount === 1) {
        recovered.push(slot.run_id)
        await this.appendEvent({
          teamId: slot.team_id,
          userId: slot.user_id,
          type: 'execution_slot_released',
          subjectAgentId: slot.agent_id,
          runId: slot.run_id,
          payload: { execution_slot: slot.slot, reason: 'lease_expired' },
          dedupeKey: `execution_slot_expired:${slot.run_id}:${slot.fence_token}`,
        }).catch(() => undefined)
      }
    }
    return recovered
  }

  async claimExecutionSlot(input: ClaimExecutionSlotInput): Promise<AgentExecutionSlotRecord | null> {
    await this.connect()
    const [team, runnableAgent] = await Promise.all([
      AgentTeamModel.findOne({ team_id: input.teamId, user_id: input.userId }),
      TeamAgentModel.exists({
        team_id: input.teamId,
        user_id: input.userId,
        agent_id: input.agentId,
        current_session_id: input.sessionId,
        status: { $in: ['idle', 'running'] },
      }),
    ])
    if (!team || team.status !== 'active' || !runnableAgent) return null
    const max = Math.max(1, Math.min(input.limit ?? team.policy.max_active_agents, team.policy.max_active_agents))
    const now = new Date()
    const leaseMs = Math.max(1_000, input.leaseMs ?? DEFAULT_EXECUTION_LEASE_MS)
    const expiresAt = new Date(now.getTime() + leaseMs)

    const existing = await AgentExecutionSlotModel.findOne({ run_id: input.runId })
    if (existing) {
      if (existing.owner_id === input.ownerId && existing.expires_at > now) {
        existing.heartbeat_at = now
        existing.expires_at = expiresAt
        await existing.save()
        return asRecord<AgentExecutionSlotRecord>(existing)
      }
      if (existing.expires_at > now) return null
      await AgentExecutionSlotModel.deleteOne({
        run_id: input.runId,
        fence_token: existing.fence_token,
        expires_at: { $lte: now },
      })
    }
    await this.recoverExpiredExecutionSlots({ teamId: input.teamId, userId: input.userId, now })

    for (let slot = 0; slot < max; slot += 1) {
      try {
        const created = await AgentExecutionSlotModel.create({
          execution_slot_id: `execution_slot_${randomUUID()}`,
          team_id: input.teamId,
          user_id: input.userId,
          slot,
          agent_id: input.agentId,
          session_id: input.sessionId,
          run_id: input.runId,
          owner_id: input.ownerId,
          fence_token: `execution_fence_${randomUUID()}`,
          heartbeat_at: now,
          expires_at: expiresAt,
        })
        const record = asRecord<AgentExecutionSlotRecord>(created)
        const stillRunnable = await TeamAgentModel.exists({
          team_id: input.teamId,
          user_id: input.userId,
          agent_id: input.agentId,
          current_session_id: input.sessionId,
          status: { $in: ['idle', 'running'] },
        })
        const teamStillActive = await AgentTeamModel.exists({
          team_id: input.teamId,
          user_id: input.userId,
          status: 'active',
        })
        if (!stillRunnable || !teamStillActive) {
          await AgentExecutionSlotModel.deleteOne({
            run_id: record.run_id,
            owner_id: record.owner_id,
            fence_token: record.fence_token,
          })
          return null
        }
        await this.appendEvent({
          teamId: input.teamId,
          userId: input.userId,
          type: 'execution_slot_claimed',
          subjectAgentId: input.agentId,
          runId: input.runId,
          payload: { execution_slot: slot, owner_id: input.ownerId },
          dedupeKey: `execution_slot_claimed:${input.runId}:${record.fence_token}`,
        }).catch(() => undefined)
        return record
      } catch (error) {
        if (!isDuplicateKey(error)) throw error
        const competing = await AgentExecutionSlotModel.findOne({ run_id: input.runId })
        if (competing) {
          return competing.owner_id === input.ownerId
            ? asRecord<AgentExecutionSlotRecord>(competing)
            : null
        }
      }
    }
    return null
  }

  async heartbeatExecutionSlot(
    lease: ExecutionLeaseIdentity,
    leaseMs = DEFAULT_EXECUTION_LEASE_MS,
  ): Promise<boolean> {
    await this.connect()
    const now = new Date()
    const slot = await AgentExecutionSlotModel.findOne({
      run_id: lease.runId,
      owner_id: lease.ownerId,
      fence_token: lease.fenceToken,
      expires_at: { $gt: now },
    }).lean<AgentExecutionSlotRecord>()
    if (!slot) return false
    const [teamActive, agentRunning] = await Promise.all([
      AgentTeamModel.exists({
        team_id: slot.team_id,
        user_id: slot.user_id,
        status: 'active',
      }),
      TeamAgentModel.exists({
        team_id: slot.team_id,
        user_id: slot.user_id,
        agent_id: slot.agent_id,
        current_session_id: slot.session_id,
        status: 'running',
      }),
    ])
    if (!teamActive || !agentRunning) return false
    const result = await AgentExecutionSlotModel.updateOne(
      {
        run_id: lease.runId,
        owner_id: lease.ownerId,
        fence_token: lease.fenceToken,
        expires_at: { $gt: now },
      },
      {
        $set: {
          heartbeat_at: now,
          expires_at: new Date(now.getTime() + Math.max(1_000, leaseMs)),
        },
      },
    )
    return result.matchedCount === 1
  }

  async releaseExecutionSlot(lease: ExecutionLeaseIdentity): Promise<boolean> {
    await this.connect()
    const slot = await AgentExecutionSlotModel.findOne({
      run_id: lease.runId,
      owner_id: lease.ownerId,
      fence_token: lease.fenceToken,
    }).lean<AgentExecutionSlotRecord>()
    if (!slot) return false
    const result = await AgentExecutionSlotModel.deleteOne({
      run_id: lease.runId,
      owner_id: lease.ownerId,
      fence_token: lease.fenceToken,
    })
    if (result.deletedCount !== 1) return false
    await this.appendEvent({
      teamId: slot.team_id,
      userId: slot.user_id,
      type: 'execution_slot_released',
      subjectAgentId: slot.agent_id,
      runId: slot.run_id,
      payload: { execution_slot: slot.slot, owner_id: slot.owner_id },
      dedupeKey: `execution_slot_released:${slot.run_id}:${slot.fence_token}`,
    }).catch(() => undefined)
    return true
  }

  async validateExecutionFence(input: {
    teamId: string
    userId: string
    agentId: string
    sessionId: string
    runId: string
    ownerId: string
  }): Promise<boolean> {
    await this.connect()
    const now = new Date()
    const [team, agent, slot, session] = await Promise.all([
      AgentTeamModel.exists({
        team_id: input.teamId,
        user_id: input.userId,
        status: 'active',
      }),
      TeamAgentModel.exists({
        team_id: input.teamId,
        user_id: input.userId,
        agent_id: input.agentId,
        current_session_id: input.sessionId,
        status: 'running',
      }),
      AgentExecutionSlotModel.exists({
        team_id: input.teamId,
        user_id: input.userId,
        agent_id: input.agentId,
        session_id: input.sessionId,
        run_id: input.runId,
        owner_id: input.ownerId,
        expires_at: { $gt: now },
      }),
      AgentSessionRuntimeModel.exists({
        team_id: input.teamId,
        user_id: input.userId,
        agent_id: input.agentId,
        session_id: input.sessionId,
        active_run_id: input.runId,
        active_lease_owner_id: input.ownerId,
        'run_lease.owner_id': input.ownerId,
        'run_lease.expires_at': { $gt: now },
      }),
    ])
    return Boolean(team && agent && slot && session)
  }

  async claimAgentSessionRun(input: ClaimAgentSessionRunInput): Promise<AgentSessionRuntimeRecord | null> {
    await this.connect()
    const now = new Date()
    const expiresAt = new Date(now.getTime() + Math.max(1_000, input.leaseMs ?? DEFAULT_EXECUTION_LEASE_MS))
    const existing = await AgentSessionRuntimeModel.findOne({
      session_id: input.sessionId,
      team_id: input.teamId,
      user_id: input.userId,
    })
    if (!existing) return null
    const [teamActive, runnableAgent] = await Promise.all([
      AgentTeamModel.exists({
        team_id: input.teamId,
        user_id: input.userId,
        status: 'active',
      }),
      TeamAgentModel.exists({
        team_id: input.teamId,
        user_id: input.userId,
        agent_id: existing.agent_id,
        current_session_id: input.sessionId,
        status: { $in: ['idle', 'running'] },
      }),
    ])
    if (!teamActive || !runnableAgent) return null
    if (existing.active_run_id === input.runId
      && existing.run_lease?.owner_id === input.ownerId
      && existing.run_lease.expires_at > now) {
      return AgentSessionRuntimeModel.findOneAndUpdate(
        {
          session_id: input.sessionId,
          active_run_id: input.runId,
          active_lease_owner_id: input.ownerId,
          'run_lease.fence_token': existing.run_lease.fence_token,
          'run_lease.expires_at': { $gt: now },
        },
        {
          $set: {
            'run_lease.heartbeat_at': now,
            'run_lease.expires_at': expiresAt,
          },
          $inc: { revision: 1 },
        },
        { returnDocument: 'after' },
      ).lean<AgentSessionRuntimeRecord>()
    }
    if (existing.active_run_id && existing.run_lease?.expires_at && existing.run_lease.expires_at > now) {
      return null
    }

    const fenceToken = `session_fence_${randomUUID()}`
    let claimed: AgentSessionRuntimeRecord | null
    try {
      claimed = await AgentSessionRuntimeModel.findOneAndUpdate(
        {
          session_id: input.sessionId,
          team_id: input.teamId,
          user_id: input.userId,
          $or: [
            { active_run_id: null },
            { active_run_id: { $exists: false } },
            { 'run_lease.expires_at': { $lte: now } },
          ],
        },
        {
          $set: {
            active_run_id: input.runId,
            active_lease_owner_id: input.ownerId,
            run_lease: {
              owner_id: input.ownerId,
              fence_token: fenceToken,
              heartbeat_at: now,
              expires_at: expiresAt,
            },
          },
          $inc: { revision: 1 },
        },
        { returnDocument: 'after' },
      ).lean<AgentSessionRuntimeRecord>()
    } catch (error) {
      if (!isDuplicateKey(error)) throw error
      return null
    }
    if (!claimed) return null
    const statusChanged = await TeamAgentModel.updateOne(
      {
        team_id: input.teamId,
        user_id: input.userId,
        current_session_id: input.sessionId,
        status: 'idle',
      },
      { $set: { status: 'running', last_transition_at: now, interrupt_requested_at: null } },
    )
    const stillRunnable = statusChanged.modifiedCount === 1 || Boolean(await TeamAgentModel.exists({
      team_id: input.teamId,
      user_id: input.userId,
      agent_id: claimed.agent_id,
      current_session_id: input.sessionId,
      status: 'running',
    }))
    const teamStillActive = Boolean(await AgentTeamModel.exists({
      team_id: input.teamId,
      user_id: input.userId,
      status: 'active',
    }))
    if (!stillRunnable || !teamStillActive) {
      await AgentSessionRuntimeModel.updateOne(
        {
          session_id: input.sessionId,
          active_run_id: input.runId,
          active_lease_owner_id: input.ownerId,
          'run_lease.fence_token': fenceToken,
        },
        {
          $set: { active_run_id: null, active_lease_owner_id: null, run_lease: null },
          $inc: { revision: 1 },
        },
      )
      return null
    }
    if (statusChanged.modifiedCount === 1) {
      await this.appendEvent({
        teamId: input.teamId,
        userId: input.userId,
        type: 'agent_status_changed',
        subjectAgentId: claimed.agent_id,
        runId: input.runId,
        payload: { status: 'running' },
        dedupeKey: `agent_running:${input.runId}:${fenceToken}`,
      }).catch(() => undefined)
    }
    return claimed
  }

  async heartbeatAgentSessionRun(input: {
    sessionId: string
    runId: string
    ownerId: string
    fenceToken: string
    leaseMs?: number
  }): Promise<boolean> {
    await this.connect()
    const now = new Date()
    const session = await AgentSessionRuntimeModel.findOne({
      session_id: input.sessionId,
      active_run_id: input.runId,
      active_lease_owner_id: input.ownerId,
      'run_lease.fence_token': input.fenceToken,
      'run_lease.expires_at': { $gt: now },
    }).lean<AgentSessionRuntimeRecord>()
    if (!session) return false
    const [teamActive, agentRunning] = await Promise.all([
      AgentTeamModel.exists({
        team_id: session.team_id,
        user_id: session.user_id,
        status: 'active',
      }),
      TeamAgentModel.exists({
        team_id: session.team_id,
        user_id: session.user_id,
        agent_id: session.agent_id,
        current_session_id: session.session_id,
        status: 'running',
      }),
    ])
    if (!teamActive || !agentRunning) return false
    const result = await AgentSessionRuntimeModel.updateOne(
      {
        session_id: input.sessionId,
        active_run_id: input.runId,
        active_lease_owner_id: input.ownerId,
        'run_lease.fence_token': input.fenceToken,
        'run_lease.expires_at': { $gt: now },
      },
      {
        $set: {
          'run_lease.heartbeat_at': now,
          'run_lease.expires_at': new Date(now.getTime() + Math.max(1_000, input.leaseMs ?? DEFAULT_EXECUTION_LEASE_MS)),
        },
        $inc: { revision: 1 },
      },
    )
    return result.matchedCount === 1
  }

  async revokeAgentExecutionLeases(input: {
    teamId: string
    userId: string
    agentId: string
    sessionId: string
  }): Promise<{ execution_slots: number; active_run_id: string | null }> {
    await this.connect()
    const session = await AgentSessionRuntimeModel.findOneAndUpdate(
      {
        session_id: input.sessionId,
        team_id: input.teamId,
        user_id: input.userId,
        agent_id: input.agentId,
        active_run_id: { $type: 'string' },
      },
      {
        $set: { active_run_id: null, active_lease_owner_id: null, run_lease: null },
        $inc: { revision: 1 },
      },
      { returnDocument: 'before' },
    ).lean<AgentSessionRuntimeRecord>()
    const slots = await AgentExecutionSlotModel.deleteMany({
      team_id: input.teamId,
      user_id: input.userId,
      agent_id: input.agentId,
      session_id: input.sessionId,
    })
    return {
      execution_slots: slots.deletedCount,
      active_run_id: session?.active_run_id ?? null,
    }
  }

  async releaseAgentSessionRun(input: {
    sessionId: string
    runId: string
    ownerId: string
    fenceToken: string
    nextAgentStatus?: 'idle' | 'paused' | 'completed' | 'failed'
    transitionReason?:
      | 'supervision_run_failed'
      | 'run_failure_contained'
      | 'supervision_failure_circuit_open'
      | 'fatal_run_failure'
  }): Promise<boolean> {
    await this.connect()
    const session = await AgentSessionRuntimeModel.findOneAndUpdate(
      {
        session_id: input.sessionId,
        active_run_id: input.runId,
        active_lease_owner_id: input.ownerId,
        'run_lease.fence_token': input.fenceToken,
      },
      {
        $set: {
          active_run_id: null,
          active_lease_owner_id: null,
          run_lease: null,
        },
        $inc: { revision: 1 },
      },
      { returnDocument: 'before' },
    )
    if (!session) return false
    const nextStatus = input.nextAgentStatus ?? 'idle'
    const statusChanged = await TeamAgentModel.updateOne(
      {
        team_id: session.team_id,
        user_id: session.user_id,
        agent_id: session.agent_id,
        current_session_id: session.session_id,
        status: 'running',
      },
      {
        $set: {
          status: nextStatus,
          last_transition_at: new Date(),
          ...(nextStatus === 'completed' ? { completed_at: new Date() } : {}),
        },
      },
    )
    if (statusChanged.modifiedCount === 1) {
      await this.appendEvent({
        teamId: session.team_id,
        userId: session.user_id,
        type: 'agent_status_changed',
        subjectAgentId: session.agent_id,
        runId: input.runId,
        payload: {
          status: nextStatus,
          ...(input.transitionReason ? { reason: input.transitionReason } : {}),
        },
        dedupeKey: `agent_released:${input.runId}:${input.fenceToken}`,
      }).catch(() => undefined)
    }
    return true
  }

  async recoverExpiredAgentSessionRuns(input: {
    teamId?: string
    userId?: string
    now?: Date
  } = {}): Promise<string[]> {
    await this.connect()
    const now = input.now ?? new Date()
    const sessions = await AgentSessionRuntimeModel.find({
      ...(input.teamId ? { team_id: input.teamId } : {}),
      ...(input.userId ? { user_id: input.userId } : {}),
      active_run_id: { $type: 'string' },
      'run_lease.expires_at': { $lte: now },
    }).lean<AgentSessionRuntimeRecord[]>()
    const recovered: string[] = []
    for (const session of sessions) {
      if (!session.active_run_id || !session.run_lease?.fence_token) continue
      // Decide the post-lease Agent state before clearing the session CAS. If
      // Mongo/module loading fails here, the expired durable lease remains for
      // the next sweep instead of stranding TeamAgent in `running` forever.
      const finalRun = await AgentRun.findOne({
        run_id: session.active_run_id,
        user_id: session.user_id,
      })
      const releaseDecision = finalRun
        ? await import('../agent-runtime/runner').then(({ teamAgentReleaseDecisionAfterRun }) => (
            teamAgentReleaseDecisionAfterRun(finalRun, finalRun)
          ))
        : { status: 'idle' as const, transitionReason: undefined }
      const result = await AgentSessionRuntimeModel.updateOne(
        {
          session_id: session.session_id,
          active_run_id: session.active_run_id,
          'run_lease.fence_token': session.run_lease.fence_token,
          'run_lease.expires_at': { $lte: now },
        },
        {
          $set: { active_run_id: null, active_lease_owner_id: null, run_lease: null },
          $inc: { revision: 1 },
        },
      )
      if (result.matchedCount === 1) {
        recovered.push(session.active_run_id)
        const statusChanged = await TeamAgentModel.updateOne(
          {
            team_id: session.team_id,
            user_id: session.user_id,
            agent_id: session.agent_id,
            current_session_id: session.session_id,
            status: 'running',
          },
          { $set: { status: releaseDecision.status, last_transition_at: now } },
        )
        if (statusChanged.modifiedCount === 1) {
          await this.appendEvent({
            teamId: session.team_id,
            userId: session.user_id,
            type: 'agent_status_changed',
            subjectAgentId: session.agent_id,
            runId: session.active_run_id,
            payload: {
              status: releaseDecision.status,
              reason: releaseDecision.transitionReason ?? 'lease_expired',
            },
            dedupeKey: `agent_session_expired:${session.active_run_id}:${session.run_lease.fence_token}`,
          }).catch(() => undefined)
        }
      }
    }
    return recovered
  }

  async claimMailboxMessages(input: {
    teamId: string
    userId: string
    agentId: string
    claimId?: string
    limit?: number
  }): Promise<{ claim_id: string; messages: AgentMailboxMessageRecord[] }> {
    await this.connect()
    const now = new Date()
    await this.releaseStaleMailboxClaims({
      teamId: input.teamId,
      userId: input.userId,
      agentId: input.agentId,
      now,
    })
    const claimId = input.claimId ?? `mail_claim_${randomUUID()}`
    const candidates = await AgentMailboxMessageModel.find({
      team_id: input.teamId,
      user_id: input.userId,
      deliveries: { $elemMatch: { agent_id: input.agentId, status: 'pending' } },
    }).sort({ created_at: 1 }).limit(Math.max(1, Math.min(input.limit ?? 100, 500))).select('message_id').lean<Array<{ message_id: string }>>()
    const claimed: AgentMailboxMessageRecord[] = []
    for (const candidate of candidates) {
      const updated = await AgentMailboxMessageModel.findOneAndUpdate(
        {
          message_id: candidate.message_id,
          deliveries: { $elemMatch: { agent_id: input.agentId, status: 'pending' } },
        },
        {
          $set: {
            'deliveries.$[delivery].status': 'claimed',
            'deliveries.$[delivery].claim_id': claimId,
            'deliveries.$[delivery].claimed_at': now,
          },
        },
        {
          arrayFilters: [{ 'delivery.agent_id': input.agentId, 'delivery.status': 'pending' }],
          returnDocument: 'after',
        },
      )
      if (updated) claimed.push(asRecord<AgentMailboxMessageRecord>(updated))
    }
    return { claim_id: claimId, messages: claimed }
  }

  async acknowledgeMailboxClaim(input: {
    teamId: string
    userId: string
    agentId: string
    claimId: string
  }): Promise<number> {
    await this.connect()
    const now = new Date()
    const result = await AgentMailboxMessageModel.updateMany(
      {
        team_id: input.teamId,
        user_id: input.userId,
        deliveries: {
          $elemMatch: {
            agent_id: input.agentId,
            status: 'claimed',
            claim_id: input.claimId,
          },
        },
      },
      {
        $set: {
          'deliveries.$[delivery].status': 'acknowledged',
          'deliveries.$[delivery].acknowledged_at': now,
        },
      },
      {
        arrayFilters: [{
          'delivery.agent_id': input.agentId,
          'delivery.status': 'claimed',
          'delivery.claim_id': input.claimId,
        }],
      },
    )
    return result.modifiedCount
  }

  async releaseMailboxClaim(input: {
    teamId: string
    userId: string
    agentId: string
    claimId: string
  }): Promise<number> {
    await this.connect()
    const result = await AgentMailboxMessageModel.updateMany(
      {
        team_id: input.teamId,
        user_id: input.userId,
        deliveries: {
          $elemMatch: {
            agent_id: input.agentId,
            status: 'claimed',
            claim_id: input.claimId,
          },
        },
      },
      {
        $set: {
          'deliveries.$[delivery].status': 'pending',
          'deliveries.$[delivery].claim_id': null,
          'deliveries.$[delivery].claimed_at': null,
        },
      },
      {
        arrayFilters: [{
          'delivery.agent_id': input.agentId,
          'delivery.status': 'claimed',
          'delivery.claim_id': input.claimId,
        }],
      },
    )
    return result.modifiedCount
  }

  async releaseStaleMailboxClaims(input: {
    teamId?: string
    userId?: string
    agentId?: string
    now?: Date
    staleAfterMs?: number
  } = {}): Promise<number> {
    await this.connect()
    const now = input.now ?? new Date()
    const cutoff = new Date(now.getTime() - Math.max(1_000, input.staleAfterMs ?? DEFAULT_MAILBOX_CLAIM_STALE_MS))
    const query = {
      ...(input.teamId ? { team_id: input.teamId } : {}),
      ...(input.userId ? { user_id: input.userId } : {}),
      deliveries: {
        $elemMatch: {
          ...(input.agentId ? { agent_id: input.agentId } : {}),
          status: 'claimed',
          claimed_at: { $lte: cutoff },
        },
      },
    }
    const result = await AgentMailboxMessageModel.updateMany(
      query,
      {
        $set: {
          'deliveries.$[delivery].status': 'pending',
          'deliveries.$[delivery].claim_id': null,
          'deliveries.$[delivery].claimed_at': null,
        },
      },
      {
        arrayFilters: [{
          ...(input.agentId ? { 'delivery.agent_id': input.agentId } : {}),
          'delivery.status': 'claimed',
          'delivery.claimed_at': { $lte: cutoff },
        }],
      },
    )
    return result.modifiedCount
  }

  async mailboxDeliveriesSettled(input: {
    teamId: string
    userId: string
    agentId: string
    messageIds: string[]
  }): Promise<boolean> {
    await this.connect()
    if (input.messageIds.length === 0) return true
    const unsettled = await AgentMailboxMessageModel.exists({
      team_id: input.teamId,
      user_id: input.userId,
      message_id: { $in: input.messageIds },
      deliveries: {
        $elemMatch: {
          agent_id: input.agentId,
          status: { $ne: 'acknowledged' },
        },
      },
    })
    return !unsettled
  }
}

export const agentTeamRepository = new MongoAgentTeamRepository()

export const claimExecutionSlot = agentTeamRepository.claimExecutionSlot.bind(agentTeamRepository)
export const heartbeatExecutionSlot = agentTeamRepository.heartbeatExecutionSlot.bind(agentTeamRepository)
export const releaseExecutionSlot = agentTeamRepository.releaseExecutionSlot.bind(agentTeamRepository)
export const validateExecutionFence = agentTeamRepository.validateExecutionFence.bind(agentTeamRepository)
export const recoverExpiredExecutionSlots = agentTeamRepository.recoverExpiredExecutionSlots.bind(agentTeamRepository)
export const claimAgentSessionRun = agentTeamRepository.claimAgentSessionRun.bind(agentTeamRepository)
export const heartbeatAgentSessionRun = agentTeamRepository.heartbeatAgentSessionRun.bind(agentTeamRepository)
export const releaseAgentSessionRun = agentTeamRepository.releaseAgentSessionRun.bind(agentTeamRepository)
export const recoverExpiredAgentSessionRuns = agentTeamRepository.recoverExpiredAgentSessionRuns.bind(agentTeamRepository)
export const revokeAgentExecutionLeases = agentTeamRepository.revokeAgentExecutionLeases.bind(agentTeamRepository)
export const releaseMailboxClaim = agentTeamRepository.releaseMailboxClaim.bind(agentTeamRepository)
export const releaseStaleMailboxClaims = agentTeamRepository.releaseStaleMailboxClaims.bind(agentTeamRepository)
export const mailboxDeliveriesSettled = agentTeamRepository.mailboxDeliveriesSettled.bind(agentTeamRepository)
export const advanceSupervisionCursor = agentTeamRepository.advanceSupervisionCursor.bind(agentTeamRepository)
