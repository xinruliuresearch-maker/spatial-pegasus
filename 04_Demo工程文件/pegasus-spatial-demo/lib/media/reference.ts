import type { ImageBlock, RasterAssetRef, RasterAssetVariant } from '../types'
import { buildMediaPublicUrl, buildOSSObjectPublicUrl } from './public-url'
import type { StoredImageAsset } from './storage'

/** Convert storage metadata to the byte-free contract used by tools and SSE. */
export function toRasterAssetRef(asset: StoredImageAsset): RasterAssetRef {
  const model = asset.variants.model
  const urlFor = (variant: RasterAssetVariant) => {
    if (asset.storageDriver === 'oss') {
      return buildOSSObjectPublicUrl(asset.variants[variant].storageKey)
    }
    return buildMediaPublicUrl(asset.assetId, variant)
  }
  return {
    assetId: asset.assetId,
    mimeType: model.mimeType,
    width: model.width,
    height: model.height,
    sizeBytes: model.sizeBytes,
    urls: {
      original: urlFor('original'),
      model: urlFor('model'),
      thumbnail: urlFor('thumbnail'),
    },
  }
}

/** Persistable Anthropic-compatible internal image block. */
export function toImageBlock(asset: StoredImageAsset): ImageBlock {
  const model = asset.variants.model
  return {
    type: 'image',
    source: {
      type: 'asset',
      asset_id: asset.assetId,
      media_type: model.mimeType,
      width: model.width,
      height: model.height,
      size_bytes: model.sizeBytes,
    },
  }
}
