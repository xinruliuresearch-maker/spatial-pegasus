import { randomUUID } from 'node:crypto'
import { connectDB } from '../db/mongodb'
import { SpatialBuildJobModel, SpatialPaidSlotModel } from './models'
import type {
  SpatialPaidHolderType,
  SpatialPaidSlotClaim,
  SpatialPaidSlotRecord,
} from './types'

const DEFAULT_RESERVATION_MS = 60_000

function duplicateKey(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === 11000
}

function text(label: string, value: string): string {
  const normalized = value.trim()
  if (!normalized) throw new TypeError(`${label} must not be empty.`)
  return normalized
}

function toClaim(record: SpatialPaidSlotRecord): SpatialPaidSlotClaim {
  return {
    projectId: record.project_id,
    userId: record.user_id,
    slot: record.slot,
    holderType: record.holder_type,
    holderKey: record.holder_key,
    reservationToken: record.reservation_token,
    state: record.state,
  }
}

export class SpatialPaidCapacityError extends Error {
  readonly code = 'SPATIAL_PAID_CAPACITY_EXCEEDED'

  constructor(
    public readonly projectId: string,
    public readonly holderType?: SpatialPaidHolderType,
  ) {
    super(
      `Spatial project ${projectId} already has two active or reserved `
      + `${holderType === 'image_generation' ? 'image generation' : holderType === 'spatial_build' ? '3D build' : 'paid'} operations.`,
    )
    this.name = 'SpatialPaidCapacityError'
  }
}

export class SpatialPaidSlotCommandRejectedError extends Error {
  readonly code = 'SPATIAL_PAID_SLOT_COMMAND_REJECTED'

  constructor() {
    super('Spatial paid-slot command rejected: identity did not match.')
    this.name = 'SpatialPaidSlotCommandRejectedError'
  }
}

export async function acquireSpatialPaidSlot(input: {
  projectId: string
  userId: string
  holderType: SpatialPaidHolderType
  holderKey: string
  reservationMs?: number
}): Promise<SpatialPaidSlotClaim> {
  await connectDB()
  const projectId = text('projectId', input.projectId)
  const userId = text('userId', input.userId)
  const holderKey = text('holderKey', input.holderKey)
  const existing = await SpatialPaidSlotModel.findOne({
    project_id: projectId,
    holder_type: input.holderType,
    holder_key: holderKey,
  }).lean<SpatialPaidSlotRecord>()
  if (existing) {
    if (existing.user_id !== userId) throw new SpatialPaidSlotCommandRejectedError()
    return toClaim(existing)
  }

  const now = new Date()
  const reservationMs = Math.max(5_000, input.reservationMs ?? DEFAULT_RESERVATION_MS)
  for (const slot of [0, 1] as const) {
    const reservationToken = `sppaid_${randomUUID()}`
    try {
      const created = await SpatialPaidSlotModel.create({
        project_id: projectId,
        user_id: userId,
        slot,
        holder_type: input.holderType,
        holder_key: holderKey,
        reservation_token: reservationToken,
        state: 'reserved',
        reservation_expires_at: new Date(now.getTime() + reservationMs),
      })
      return toClaim(created.toObject() as SpatialPaidSlotRecord)
    } catch (error) {
      if (!duplicateKey(error)) throw error
      const winner = await SpatialPaidSlotModel.findOne({
        project_id: projectId,
        holder_type: input.holderType,
        holder_key: holderKey,
      }).lean<SpatialPaidSlotRecord>()
      if (winner) {
        if (winner.user_id !== userId) throw new SpatialPaidSlotCommandRejectedError()
        return toClaim(winner)
      }
    }
  }
  throw new SpatialPaidCapacityError(projectId, input.holderType)
}

export async function bindSpatialPaidSlot(
  claim: SpatialPaidSlotClaim,
): Promise<SpatialPaidSlotClaim> {
  await connectDB()
  const record = await SpatialPaidSlotModel.findOneAndUpdate(
    {
      project_id: claim.projectId,
      user_id: claim.userId,
      slot: claim.slot,
      holder_type: claim.holderType,
      holder_key: claim.holderKey,
      reservation_token: claim.reservationToken,
    },
    { $set: { state: 'active', reservation_expires_at: null } },
    { returnDocument: 'after' },
  ).lean<SpatialPaidSlotRecord>()
  if (!record) throw new SpatialPaidSlotCommandRejectedError()
  return toClaim(record)
}

export async function releaseSpatialPaidSlot(input: {
  projectId: string
  userId: string
  holderType: SpatialPaidHolderType
  holderKey: string
  reservationToken?: string
}): Promise<boolean> {
  await connectDB()
  const result = await SpatialPaidSlotModel.deleteOne({
    project_id: input.projectId.trim(),
    user_id: input.userId.trim(),
    holder_type: input.holderType,
    holder_key: input.holderKey.trim(),
    ...(input.reservationToken ? { reservation_token: input.reservationToken } : {}),
  })
  return result.deletedCount === 1
}

export async function reconcileSpatialPaidSlots(input: {
  holderType: SpatialPaidHolderType
  inspectHolder(slot: SpatialPaidSlotRecord): Promise<'active' | 'terminal_or_missing'>
  now?: Date
}): Promise<{ bound: number; released: number }> {
  await connectDB()
  const now = input.now ?? new Date()
  const records = await SpatialPaidSlotModel.find({
    holder_type: input.holderType,
    $or: [
      { state: 'active' },
      { state: 'reserved', reservation_expires_at: { $lte: now } },
    ],
  }).limit(1_000).lean<SpatialPaidSlotRecord[]>()
  let bound = 0
  let released = 0
  for (const record of records) {
    const state = await input.inspectHolder(record)
    if (state === 'active') {
      if (record.state === 'reserved') {
        const result = await SpatialPaidSlotModel.updateOne(
          {
            project_id: record.project_id,
            slot: record.slot,
            holder_type: record.holder_type,
            reservation_token: record.reservation_token,
            state: 'reserved',
          },
          { $set: { state: 'active', reservation_expires_at: null } },
        )
        bound += result.modifiedCount
      }
      continue
    }
    const result = await SpatialPaidSlotModel.deleteOne({
      project_id: record.project_id,
      slot: record.slot,
      holder_type: record.holder_type,
      reservation_token: record.reservation_token,
    })
    released += result.deletedCount
  }
  return { bound, released }
}

export async function reconcileSpatialBuildPaidSlots(now = new Date()): Promise<{
  bound: number
  released: number
}> {
  return reconcileSpatialPaidSlots({
    holderType: 'spatial_build',
    now,
    async inspectHolder(slot) {
      const job = await SpatialBuildJobModel.findOne({
        job_id: slot.holder_key,
        project_id: slot.project_id,
        user_id: slot.user_id,
      }).select('status').lean<{ status: string }>()
      return job && ['prepared', 'submitting', 'submitted', 'running', 'materializing'].includes(job.status)
        ? 'active'
        : 'terminal_or_missing'
    },
  })
}
