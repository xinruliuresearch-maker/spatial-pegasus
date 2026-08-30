import mongoose, { Schema, Document } from 'mongoose'

/**
 * Read-only mirror of the `model_config` single-document collection owned
 * by the deployment administrator. Sci-Pegasus only reads via
 * `lib/llm-registry.ts`; admin
 * writes are operator-controlled and intentionally outside request handlers.
 *
 * Shape mirrors `config/llm-registry.json` exactly so admin "save" and
 * Sci-Pegasus "reload" are a 1:1 copy with no shape translation in between.
 * `strict: false` lets the admin owner add fields without an app deploy.
 */
export interface ModelConfigDocument extends Document {
  config_key: string
  aliases: Record<string, unknown>
  toolSelection: {
    websearch: { free?: string; pro?: string; team?: string }
    memory: { free?: string; pro?: string; team?: string }
  }
  defaultMainAlias: { free?: string; pro?: string; team?: string }
  high_cost_aliases_disabled: string[]
  updated_at?: Date
  updated_by?: string
}

const ModelConfigSchema = new Schema<ModelConfigDocument>(
  {
    config_key: { type: String, required: true, unique: true, index: true, default: 'main' },
  },
  {
    collection: 'model_config',
    strict: false,
  }
)

export const ModelConfig =
  (mongoose.models.ModelConfig as mongoose.Model<ModelConfigDocument>) ||
  mongoose.model<ModelConfigDocument>('ModelConfig', ModelConfigSchema)
