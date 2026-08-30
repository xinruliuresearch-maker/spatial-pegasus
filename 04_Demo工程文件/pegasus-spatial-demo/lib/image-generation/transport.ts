import { ImageGenerationProviderError } from './errors'

export const DEFAULT_IMAGE_GENERATION_TIMEOUT_MS = 5 * 60_000

export interface ImageGenerationHTTPResult {
  ok: boolean
  status: number
  data?: unknown
  errorText?: string
  requestId?: string
}

function abortReasonAsError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  const error = new Error(
    typeof signal.reason === 'string' && signal.reason
      ? signal.reason
      : 'Image generation request was cancelled',
  )
  error.name = 'AbortError'
  return error
}

/**
 * The deadline covers response headers and the complete response body. fetch()
 * resolving on headers must not leave a stalled JSON body running forever.
 */
export async function fetchImageGenerationJSON(input: {
  url: string
  init: RequestInit
  signal?: AbortSignal
  timeoutMs?: number
  fetchImpl?: typeof fetch
}): Promise<ImageGenerationHTTPResult> {
  const controller = new AbortController()
  const timeoutMs = input.timeoutMs ?? DEFAULT_IMAGE_GENERATION_TIMEOUT_MS
  const timeoutError = new Error(`Image generation timed out after ${timeoutMs / 1000}s`)
  timeoutError.name = 'TimeoutError'
  const timeout = setTimeout(() => controller.abort(timeoutError), timeoutMs)
  const abortFromCaller = () => controller.abort(input.signal?.reason)
  input.signal?.addEventListener('abort', abortFromCaller, { once: true })
  if (input.signal?.aborted) abortFromCaller()

  try {
    const response = await (input.fetchImpl ?? fetch)(input.url, {
      ...input.init,
      signal: controller.signal,
    })
    const requestId = response.headers?.get?.('x-request-id') || undefined
    let body = ''
    try {
      body = await response.text()
    } catch (error) {
      if (controller.signal.aborted) throw abortReasonAsError(controller.signal)
      throw error
    }
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        errorText: body,
        requestId,
      }
    }
    try {
      return {
        ok: true,
        status: response.status,
        data: body ? JSON.parse(body) : {},
        requestId,
      }
    } catch (error) {
      throw new ImageGenerationProviderError('Image provider returned invalid JSON', {
        code: 'invalid_provider_json',
        requestMayHaveBeenAccepted: true,
        cause: error,
      })
    }
  } catch (error) {
    if (controller.signal.aborted) throw abortReasonAsError(controller.signal)
    throw error
  } finally {
    clearTimeout(timeout)
    input.signal?.removeEventListener('abort', abortFromCaller)
  }
}
