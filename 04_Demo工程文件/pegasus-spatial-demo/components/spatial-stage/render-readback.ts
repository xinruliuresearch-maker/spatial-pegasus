export interface RenderReadbackViewer {
  render(): void
  waitForRenderOver(timeoutMs: number): Promise<void>
  readRenderResultAsync(
    pixels: Uint8Array,
    range: { x: number; y: number; width: number; height: number },
  ): Promise<void> | void
  readRenderResult(
    pixels: Uint8Array,
    range: { x: number; y: number; width: number; height: number },
  ): void
}

/**
 * Aholo's asynchronous framebuffer read uses WebGL clientWaitSync. A browser
 * or GPU may intermittently report WAIT_FAILED even when the rendered target
 * is valid. Retry the preferred async path, then use one bounded synchronous
 * SDK read. The caller still validates that the returned frame is non-empty.
 */
export async function readRenderPixelsWithRetry(
  viewer: RenderReadbackViewer,
  pixels: Uint8Array,
  range: { x: number; y: number; width: number; height: number },
): Promise<void> {
  let lastError: unknown = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    viewer.render()
    await viewer.waitForRenderOver(48 + attempt * 32)
    try {
      await viewer.readRenderResultAsync(pixels, range)
      return
    } catch (cause) {
      lastError = cause
      if (!(cause instanceof Error) || !/GL client sync failed/i.test(cause.message) || attempt === 2) break
      await new Promise(resolve => setTimeout(resolve, 40 * (attempt + 1)))
    }
  }
  if (lastError instanceof Error && /GL client sync failed/i.test(lastError.message)) {
    viewer.render()
    await viewer.waitForRenderOver(96)
    viewer.readRenderResult(pixels, range)
    return
  }
  throw lastError
}
