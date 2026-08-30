import mongoose, { Schema, Document } from 'mongoose'

/**
 * Read-only mirror of the `plan_limits` collection. Sci-Pegasus reads these
 * documents via `lib/rate-limit/limits.ts`; field naming is snake_case in
 * Mongo and the runtime mapper converts to the
 * camelCase `UserLimits` interface that callers expect.
 *
 * Why a loose schema (`strict: false`): the admin owner of this collection
 * is allowed to add fields without a Sci-Pegasus deploy; we just ignore the
 * ones we don't recognize. Adding `strict: true` would silently drop those
 * fields on any incidental write from this side, which would corrupt the
 * admin source of truth — better to keep mongoose out of the way entirely.
 */
export interface PlanLimitDocument extends Document {
  plan: string
  messages_per_minute?: number
  messages_per_day?: number
  concurrent_loops?: number
  updated_at?: Date
  updated_by?: string
}

const PlanLimitSchema = new Schema<PlanLimitDocument>(
  {
    plan: { type: String, required: true, unique: true, index: true },
  },
  {
    collection: 'plan_limits',
    strict: false,
  }
)

export const PlanLimit =
  (mongoose.models.PlanLimit as mongoose.Model<PlanLimitDocument>) ||
  mongoose.model<PlanLimitDocument>('PlanLimit', PlanLimitSchema)
