import { createHash } from 'node:crypto'

export type FetchImplementation = typeof fetch

export async function readResponseBuffer(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`Remote response exceeds ${maxBytes} byte limit`)
  }

  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let size = 0
  try {
    while (true) {
      if (signal?.aborted) throw abortError()
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new Error(`Remote response exceeds ${maxBytes} byte limit`)
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, size)
}

export async function readResponseText(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  return (await readResponseBuffer(response, maxBytes, signal)).toString('utf8')
}

export function sha256Hex(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function abortError(): Error {
  const error = new Error('Operation aborted')
  error.name = 'AbortError'
  return error
}

export async function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return
  if (signal?.aborted) throw abortError()
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(finish, ms)
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(abortError())
    }
    function finish() {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export async function fetchWithTimeout(
  fetchImpl: FetchImplementation,
  input: string | URL,
  init: RequestInit,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<Response> {
  if (parentSignal?.aborted) throw abortError()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort('request_timeout'), timeoutMs)
  const onAbort = () => controller.abort(parentSignal?.reason)
  parentSignal?.addEventListener('abort', onAbort, { once: true })
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal })
  } catch (error) {
    if (controller.signal.aborted) {
      if (parentSignal?.aborted) throw abortError()
      const timeoutError = new Error(`Remote request timed out after ${timeoutMs}ms`)
      timeoutError.name = 'TimeoutError'
      throw timeoutError
    }
    throw error
  } finally {
    clearTimeout(timeout)
    parentSignal?.removeEventListener('abort', onAbort)
  }
}

export function retryAfterMilliseconds(response: Response): number | null {
  const raw = response.headers.get('retry-after')?.trim()
  if (!raw) return null
  if (/^\d+$/.test(raw)) return Number(raw) * 1_000
  const timestamp = Date.parse(raw)
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : null
}

export function boundedText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (!normalized) return undefined
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars - 1)}…`
}

export function safeError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return {
      name: error.name || 'Error',
      message: redactSecrets(error.message).slice(0, 2_000),
    }
  }
  return { name: 'Error', message: redactSecrets(String(error)).slice(0, 2_000) }
}

function redactSecrets(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/([?&](?:api[_-]?key|token)=)[^&\s]+/gi, '$1[redacted]')
}
