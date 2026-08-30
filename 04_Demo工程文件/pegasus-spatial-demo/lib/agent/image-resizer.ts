// Image Resizer — preprocess images before they enter the conversation context
// Adapted from Claude Code's progressive compression strategy
//
// Goals:
// 1. Keep fetched image bytes under the provider's 5MB image limit
// 2. Cap dimensions to 2000×2000 (API internally resizes to 1568px anyway)
// 3. Preserve useful visual detail; image tokens are dimension-based, not
//    derived from base64 character length
//
// Strategy (progressive, least-lossy first):
// 1. If already acceptable (≤ target size, ≤ max dimensions) → return as-is
// 2. Resize to max dimensions if too large
// 3. Try PNG compression (lossless, palette mode)
// 4. Try JPEG quality progression: 80 → 60 → 40 → 20
// 5. Reduce dimensions further: 1000 → 800 → 600 → 400

import sharp from 'sharp'

// ==================== Constants ====================

/** Anthropic API hard limit for base64-encoded image size */
const API_BASE64_MAX_BYTES = 5 * 1024 * 1024

/** Target raw size before base64 encoding (raw × 4/3 = base64, so 3.75MB → 5MB) */
const TARGET_RAW_BYTES = Math.floor(API_BASE64_MAX_BYTES * 3 / 4)

/** Max image dimensions (client-side cap, API internally resizes above 1568px) */
const MAX_WIDTH = 2000
const MAX_HEIGHT = 2000

/** JPEG quality levels for progressive compression */
const JPEG_QUALITY_LEVELS = [80, 60, 40, 20] as const

/** Dimension fallback levels for aggressive compression */
const FALLBACK_DIMENSIONS = [1000, 800, 600, 400] as const

const EFFECTIVE_RAW_LIMIT = TARGET_RAW_BYTES

// ==================== Public API ====================

export interface ImageResizeResult {
  /** Base64-encoded image data (no data URI prefix) */
  base64: string
  /** MIME type of the output image */
  mimeType: string
  /** Original dimensions */
  originalWidth: number
  originalHeight: number
  /** Output dimensions */
  width: number
  height: number
  /** Whether the image was modified */
  wasProcessed: boolean
}

/**
 * Process a base64-encoded image: resize and compress to fit within limits.
 * Returns the processed image, or the original if it's already within limits.
 */
export async function processImageForContext(
  base64Data: string,
  mimeType: string,
): Promise<ImageResizeResult> {
  const rawBuffer = Buffer.from(base64Data, 'base64')

  // Get metadata
  const metadata = await sharp(rawBuffer).metadata()
  const origWidth = metadata.width ?? 0
  const origHeight = metadata.height ?? 0

  // Check if already acceptable
  const rawLen = rawBuffer.length
  if (rawLen <= EFFECTIVE_RAW_LIMIT && origWidth <= MAX_WIDTH && origHeight <= MAX_HEIGHT) {
    return {
      base64: base64Data,
      mimeType,
      originalWidth: origWidth,
      originalHeight: origHeight,
      width: origWidth,
      height: origHeight,
      wasProcessed: false,
    }
  }

  console.log(`[image-resizer] Processing: ${origWidth}×${origHeight}, ${(rawLen / 1024).toFixed(0)}KB raw`)

  // Step 1: Resize to max dimensions if needed
  let pipeline = sharp(rawBuffer)
  let currentWidth = origWidth
  let currentHeight = origHeight

  if (origWidth > MAX_WIDTH || origHeight > MAX_HEIGHT) {
    pipeline = pipeline.resize(MAX_WIDTH, MAX_HEIGHT, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    // Calculate actual output dimensions
    const scale = Math.min(MAX_WIDTH / origWidth, MAX_HEIGHT / origHeight)
    currentWidth = Math.round(origWidth * scale)
    currentHeight = Math.round(origHeight * scale)
  }

  // Step 2: Try PNG compression first (lossless)
  let outputBuffer = await pipeline.png({ compressionLevel: 9, palette: true }).toBuffer()
  if (outputBuffer.length <= EFFECTIVE_RAW_LIMIT) {
    const outBase64 = outputBuffer.toString('base64')
    console.log(`[image-resizer] PNG compressed: ${currentWidth}×${currentHeight}, ${(outputBuffer.length / 1024).toFixed(0)}KB`)
    return {
      base64: outBase64,
      mimeType: 'image/png',
      originalWidth: origWidth,
      originalHeight: origHeight,
      width: currentWidth,
      height: currentHeight,
      wasProcessed: true,
    }
  }

  // Step 3: Try JPEG quality progression
  for (const quality of JPEG_QUALITY_LEVELS) {
    outputBuffer = await sharp(rawBuffer)
      .resize(currentWidth, currentHeight, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality })
      .toBuffer()

    if (outputBuffer.length <= EFFECTIVE_RAW_LIMIT) {
      const outBase64 = outputBuffer.toString('base64')
      console.log(`[image-resizer] JPEG q${quality}: ${currentWidth}×${currentHeight}, ${(outputBuffer.length / 1024).toFixed(0)}KB`)
      return {
        base64: outBase64,
        mimeType: 'image/jpeg',
        originalWidth: origWidth,
        originalHeight: origHeight,
        width: currentWidth,
        height: currentHeight,
        wasProcessed: true,
      }
    }
  }

  // Step 4: Reduce dimensions further with JPEG compression
  for (const maxDim of FALLBACK_DIMENSIONS) {
    for (const quality of JPEG_QUALITY_LEVELS) {
      outputBuffer = await sharp(rawBuffer)
        .resize(maxDim, maxDim, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality })
        .toBuffer()

      if (outputBuffer.length <= EFFECTIVE_RAW_LIMIT) {
        const meta = await sharp(outputBuffer).metadata()
        const outBase64 = outputBuffer.toString('base64')
        console.log(`[image-resizer] Fallback ${maxDim}px JPEG q${quality}: ${meta.width}×${meta.height}, ${(outputBuffer.length / 1024).toFixed(0)}KB`)
        return {
          base64: outBase64,
          mimeType: 'image/jpeg',
          originalWidth: origWidth,
          originalHeight: origHeight,
          width: meta.width ?? maxDim,
          height: meta.height ?? maxDim,
          wasProcessed: true,
        }
      }
    }
  }

  // Ultimate fallback: 400×400 JPEG q20 (should always fit)
  outputBuffer = await sharp(rawBuffer)
    .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 20 })
    .toBuffer()

  const meta = await sharp(outputBuffer).metadata()
  const outBase64 = outputBuffer.toString('base64')
  console.log(`[image-resizer] Ultimate fallback 400px: ${(outputBuffer.length / 1024).toFixed(0)}KB`)
  return {
    base64: outBase64,
    mimeType: 'image/jpeg',
    originalWidth: origWidth,
    originalHeight: origHeight,
    width: meta.width ?? 400,
    height: meta.height ?? 400,
    wasProcessed: true,
  }
}

/**
 * Process multiple images in parallel.
 */
export async function processImagesForContext(
  images: { base64: string; mimeType: string }[]
): Promise<ImageResizeResult[]> {
  return Promise.all(images.map(img => processImageForContext(img.base64, img.mimeType)))
}
