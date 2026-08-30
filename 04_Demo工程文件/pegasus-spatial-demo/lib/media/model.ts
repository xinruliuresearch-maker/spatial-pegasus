import mongoose, { Document, Schema } from 'mongoose'
import type { MediaStorageDriver } from './config'

export const RASTER_ASSET_SOURCES = [
  'user_upload',
  'tool_output',
] as const

export const RASTER_ASSET_STATES = ['staged', 'active', 'deleted'] as const
export const RASTER_ASSET_VARIANTS = ['original', 'model', 'thumbnail'] as const

export type RasterAssetSource = typeof RASTER_ASSET_SOURCES[number]
export type RasterAssetState = typeof RASTER_ASSET_STATES[number]
export type RasterAssetVariantName = typeof RASTER_ASSET_VARIANTS[number]

export interface AssetVariantDocument {
  storage_key: string
  mime_type: string
  width: number
  height: number
  size_bytes: number
}

export interface ImageAssetDocument extends Document {
  asset_id: string
  owner_user_id: string
  conversation_id?: string | null
  source?: RasterAssetSource
  sha256?: string
  transform_version?: number
  state?: RasterAssetState
  storage_driver: MediaStorageDriver
  variants?: {
    original: AssetVariantDocument
    model: AssetVariantDocument
    thumbnail: AssetVariantDocument
  }
  created_at: Date
  claimed_at?: Date | null
  deleted_at?: Date | null
}

const AssetVariantSchema = new Schema<AssetVariantDocument>({
  storage_key: { type: String, required: true },
  mime_type: { type: String, required: true },
  width: { type: Number, required: true },
  height: { type: Number, required: true },
  size_bytes: { type: Number, required: true },
}, { _id: false })

const ImageAssetSchema = new Schema<ImageAssetDocument>({
  asset_id: { type: String, required: true, unique: true, index: true },
  owner_user_id: { type: String, required: true, index: true },
  conversation_id: { type: String, default: null, index: true },
  source: { type: String, enum: RASTER_ASSET_SOURCES, default: 'user_upload' },
  sha256: { type: String, index: true },
  transform_version: { type: Number, default: 1 },
  state: { type: String, enum: RASTER_ASSET_STATES, default: 'active', index: true },
  storage_driver: { type: String, enum: ['gridfs', 'oss'], required: true },
  variants: {
    original: { type: AssetVariantSchema, required: false },
    model: { type: AssetVariantSchema, required: false },
    thumbnail: { type: AssetVariantSchema, required: false },
  },
  created_at: { type: Date, default: Date.now },
  claimed_at: { type: Date, default: null },
  deleted_at: { type: Date, default: null },
})

ImageAssetSchema.index({ owner_user_id: 1, conversation_id: 1, state: 1 })
ImageAssetSchema.index(
  { owner_user_id: 1, conversation_id: 1, sha256: 1, transform_version: 1 },
  {
    unique: true,
    partialFilterExpression: {
      conversation_id: { $type: 'string' },
      sha256: { $type: 'string' },
      state: 'active',
    },
  },
)

export const ImageAsset =
  mongoose.models.ImageAsset ||
  mongoose.model<ImageAssetDocument>('ImageAsset', ImageAssetSchema)
