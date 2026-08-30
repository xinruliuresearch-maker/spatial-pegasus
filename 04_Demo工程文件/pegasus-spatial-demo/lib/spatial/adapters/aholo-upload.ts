import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { ProviderDefinitelyNotAcceptedError } from './errors'

const OFFICIAL_UPLOAD_HOSTS = new Set(['ous-cos.kujiale.com'])
const MAX_RESPONSE_BYTES = 64 * 1024
const MAX_UPLOAD_WAIT_MS = 120_000

export interface AholoUploadSource {
  buffer: Buffer
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp'
  filename: string
}

interface UploadCredential {
  token: string
  origin: string
  blockSize: number
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProviderDefinitelyNotAcceptedError(`${label} returned an invalid response; World was not submitted.`)
  }
  return value as Record<string, unknown>
}

async function jsonResponse(response: Response, label: string): Promise<Record<string, unknown>> {
  const text = await response.text()
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new ProviderDefinitelyNotAcceptedError(`${label} response exceeded the safe limit; World was not submitted.`)
  }
  let value: unknown
  try { value = JSON.parse(text) } catch {
    throw new ProviderDefinitelyNotAcceptedError(`${label} returned invalid JSON; World was not submitted.`)
  }
  return object(value, label)
}

function cleanMessage(value: unknown): string {
  return typeof value === 'string'
    ? value.replace(/https?:\/\/\S+/gi, '[url]').replace(/[\r\n\t]+/g, ' ').slice(0, 500)
    : 'unknown error'
}

function assertOusSuccess(value: Record<string, unknown>, label: string): Record<string, unknown> {
  if (String(value.c) !== '0') {
    throw new ProviderDefinitelyNotAcceptedError(
      `${label} failed before World submission: ${cleanMessage(value.m)}`,
    )
  }
  return object(value.d ?? {}, `${label}.d`)
}

function resolveApiUrl(baseUrl: string, path: string): URL {
  let base: URL
  try { base = new URL(baseUrl) } catch {
    throw new ProviderDefinitelyNotAcceptedError('Aholo API base URL is invalid; World was not submitted.')
  }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
    throw new ProviderDefinitelyNotAcceptedError('Aholo API base URL must be a credential-free HTTPS URL.')
  }
  return new URL(path, base)
}

async function uploadCredential(input: {
  baseUrl: string
  apiKey: string
  fetchImpl: typeof fetch
  signal?: AbortSignal
}): Promise<UploadCredential> {
  let response: Response
  try {
    response = await input.fetchImpl(resolveApiUrl(input.baseUrl, '/asset/v1/token'), {
      headers: { Authorization: input.apiKey },
      signal: input.signal,
      redirect: 'error',
    })
  } catch (error) {
    throw new ProviderDefinitelyNotAcceptedError(
      'Aholo upload credential transport failed before World submission.',
      { cause: error },
    )
  }
  const payload = await jsonResponse(response, 'Aholo upload credential')
  if (!response.ok) {
    throw new ProviderDefinitelyNotAcceptedError(
      `Aholo upload credential returned HTTP ${response.status}: ${cleanMessage(payload.message)}`,
    )
  }
  const token = typeof payload.ousToken === 'string' ? payload.ousToken.trim() : ''
  const rawDomain = typeof payload.globalDomain === 'string' ? payload.globalDomain.trim() : ''
  const blockSize = Number(payload.blockSize)
  let domain: URL
  try { domain = new URL(rawDomain) } catch {
    throw new ProviderDefinitelyNotAcceptedError('Aholo upload credential returned an invalid OUS domain.')
  }
  if (
    !token
    || domain.protocol !== 'https:'
    || domain.username
    || domain.password
    || domain.search
    || domain.hash
    || !OFFICIAL_UPLOAD_HOSTS.has(domain.hostname.toLowerCase())
    || !Number.isSafeInteger(blockSize)
    || blockSize < 256 * 1024
    || blockSize > 64 * 1024 * 1024
  ) {
    throw new ProviderDefinitelyNotAcceptedError('Aholo upload credential failed strict validation.')
  }
  return { token, origin: domain.origin, blockSize }
}

async function ousRequest(input: {
  credential: UploadCredential
  path: string
  method: 'GET' | 'POST'
  fetchImpl: typeof fetch
  signal?: AbortSignal
  body?: BodyInit
  headers?: Record<string, string>
}): Promise<Record<string, unknown>> {
  let response: Response
  try {
    response = await input.fetchImpl(new URL(input.path, input.credential.origin), {
      method: input.method,
      headers: { 'ous-token-v2': input.credential.token, ...(input.headers ?? {}) },
      body: input.body,
      signal: input.signal,
      redirect: 'error',
    })
  } catch (error) {
    throw new ProviderDefinitelyNotAcceptedError(
      'Aholo OUS transport failed before World submission.',
      { cause: error },
    )
  }
  const payload = await jsonResponse(response, 'Aholo OUS')
  if (!response.ok) {
    throw new ProviderDefinitelyNotAcceptedError(
      `Aholo OUS returned HTTP ${response.status}: ${cleanMessage(payload.m)}`,
    )
  }
  return payload
}

async function pollUpload(input: {
  credential: UploadCredential
  fetchImpl: typeof fetch
  signal?: AbortSignal
}): Promise<string> {
  const deadline = Date.now() + MAX_UPLOAD_WAIT_MS
  while (Date.now() < deadline) {
    const payload = await ousRequest({
      ...input,
      path: '/ous/api/v2/upload/status',
      method: 'GET',
    })
    const data = assertOusSuccess(payload, 'Aholo upload status')
    const status = Number(data.status)
    if (status === 5) {
      const rawUrl = typeof data.url === 'string' ? data.url.trim() : ''
      let url: URL
      try { url = new URL(rawUrl) } catch {
        throw new ProviderDefinitelyNotAcceptedError('Aholo upload completed without a valid asset URL.')
      }
      if (url.protocol !== 'https:' || url.username || url.password || !/\.(png|jpe?g|webp)$/i.test(url.pathname)) {
        throw new ProviderDefinitelyNotAcceptedError('Aholo upload returned an unsafe or unsupported asset URL.')
      }
      return url.toString()
    }
    if (status === 6 || status === 8) {
      throw new ProviderDefinitelyNotAcceptedError(
        `Aholo upload failed before World submission (status=${status}; code=${cleanMessage(data.errorCode)}).`,
      )
    }
    await delay(500, undefined, { signal: input.signal })
  }
  throw new ProviderDefinitelyNotAcceptedError('Aholo upload timed out before World submission.')
}

function uploadForm(source: AholoUploadSource, fieldName = source.filename): FormData {
  const form = new FormData()
  form.set('file', new Blob([new Uint8Array(source.buffer)], { type: source.mimeType }), fieldName)
  return form
}

export async function uploadAholoWorldSource(input: {
  baseUrl: string
  apiKey: string
  source: AholoUploadSource
  fetchImpl?: typeof fetch
  signal?: AbortSignal
}): Promise<string> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch
  const credential = await uploadCredential({ ...input, fetchImpl })
  const md5 = createHash('md5').update(input.source.buffer).digest('hex')

  if (input.source.buffer.length <= credential.blockSize) {
    const form = uploadForm(input.source)
    form.set('md5', md5)
    assertOusSuccess(await ousRequest({
      credential,
      fetchImpl,
      signal: input.signal,
      path: '/ous/api/v2/single/upload',
      method: 'POST',
      body: form,
    }), 'Aholo single upload')
  } else {
    const blocks = Math.ceil(input.source.buffer.length / credential.blockSize)
    const init = assertOusSuccess(await ousRequest({
      credential,
      fetchImpl,
      signal: input.signal,
      path: '/ous/api/v2/block/upload/init',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        md5,
        blocks,
        size: input.source.buffer.length,
        name: input.source.filename,
      }),
    }), 'Aholo block upload init')
    if (init.deduplicated !== true) {
      for (let block = 1; block <= blocks; block += 1) {
        const start = (block - 1) * credential.blockSize
        const chunk = input.source.buffer.subarray(start, start + credential.blockSize)
        const form = uploadForm({ ...input.source, buffer: chunk }, `${input.source.filename}.part${block}`)
        form.set('block', String(block))
        assertOusSuccess(await ousRequest({
          credential,
          fetchImpl,
          signal: input.signal,
          path: '/ous/api/v2/block/upload/part',
          method: 'POST',
          body: form,
        }), `Aholo block upload part ${block}`)
      }
    }
  }
  return pollUpload({ credential, fetchImpl, signal: input.signal })
}
