import type {
  SpatialBuildJobRecord,
  SpatialProviderPollResult,
  SpatialProviderSubmission,
} from '../types'
import {
  ProviderDefinitelyNotAcceptedError,
  ProviderConfigurationBlockedError,
  ProviderSubmissionUnknownError,
  ProviderTransientError,
} from './errors'

export type SubmitFailureCertainty = 'not_accepted' | 'unknown'

/**
 * Provider REST fields deliberately live behind this contract. Aholo/Lux wire
 * formats are frozen only after a fixture from their official API is verified;
 * the durable core never guesses task-id or output fields.
 */
export interface SpatialHttpWireContract {
  submitPath(job: SpatialBuildJobRecord): string
  pollPath(job: SpatialBuildJobRecord): string
  /** Provider-specific, non-secret headers required by the official create contract. */
  submissionHeaders?(job: SpatialBuildJobRecord): Readonly<Record<string, string>>
  /** Only set when the provider officially documents a request idempotency header. */
  idempotencyHeaderName?: string
  encodeSubmission(job: SpatialBuildJobRecord): unknown
  decodeSubmission(payload: unknown): SpatialProviderSubmission
  decodePoll(payload: unknown, job: SpatialBuildJobRecord): SpatialProviderPollResult
  classifySubmissionFailure?(input: {
    response: Response
    payload: unknown
  }): SubmitFailureCertainty
}

export interface SpatialHttpAdapterOptions {
  provider: string
  baseUrl?: string
  token?: string
  allowPaidCalls?: boolean
  contract?: SpatialHttpWireContract
  fetchImpl?: typeof fetch
  authorizationHeader?: (token: string) => string
}

function parseBaseUrl(value: string | undefined): URL {
  if (!value?.trim()) {
    throw new ProviderDefinitelyNotAcceptedError('Provider API base URL is not configured; no request was sent.')
  }
  let url: URL
  try {
    url = new URL(value)
  } catch (error) {
    throw new ProviderDefinitelyNotAcceptedError('Provider API base URL is invalid; no request was sent.', { cause: error })
  }
  const localHttp = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname)
  if (url.protocol !== 'https:' && !localHttp) {
    throw new ProviderDefinitelyNotAcceptedError('Provider API must use HTTPS outside localhost; no request was sent.')
  }
  return url
}

function resolveProviderUrl(base: URL, path: string): URL {
  const normalized = path.trim()
  if (!normalized) {
    throw new ProviderDefinitelyNotAcceptedError('Provider wire contract returned an empty path; no request was sent.')
  }
  const resolved = new URL(normalized, base)
  if (resolved.origin !== base.origin) {
    throw new ProviderDefinitelyNotAcceptedError('Provider wire contract attempted a cross-origin request; no request was sent.')
  }
  return resolved
}

async function responsePayload(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return { raw_text: text.slice(0, 4_000) }
  }
}

function providerErrorDetail(payload: unknown, token: string): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return ''
  const root = payload as Record<string, unknown>
  const details = root.details && typeof root.details === 'object' && !Array.isArray(root.details)
    ? root.details as Record<string, unknown>
    : null
  const safe = (value: unknown): string | null => {
    if (typeof value !== 'string' && typeof value !== 'number') return null
    return String(value)
      .split(token).join('[redacted]')
      .replace(/https?:\/\/\S+/gi, '[url]')
      .replace(/[\r\n\t]+/g, ' ')
      .slice(0, 500)
  }
  const fields = [
    ['code', safe(root.code)],
    ['status', safe(root.status)],
    ['reason', safe(details?.reason)],
    ['message', safe(root.message) ?? safe(details?.message)],
  ].filter((entry): entry is [string, string] => Boolean(entry[1]))
  return fields.length > 0 ? ` (${fields.map(([key, value]) => `${key}=${value}`).join('; ')})` : ''
}

export abstract class ContractDrivenSpatialHttpAdapter {
  abstract readonly supportedKind: 'object' | 'world'
  readonly provider: string
  private readonly baseUrl?: string
  private readonly token?: string
  private readonly allowPaidCalls: boolean
  private readonly contract?: SpatialHttpWireContract
  private readonly fetchImpl: typeof fetch
  private readonly authorizationHeader: (token: string) => string

  protected constructor(options: SpatialHttpAdapterOptions) {
    this.provider = options.provider
    this.baseUrl = options.baseUrl
    this.token = options.token
    this.allowPaidCalls = options.allowPaidCalls === true
    this.contract = options.contract
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.authorizationHeader = options.authorizationHeader ?? (token => `Bearer ${token}`)
  }

  supports(kind: 'image' | 'object' | 'world'): boolean {
    return kind === this.supportedKind
  }

  private requireConfigured(): {
    base: URL
    token: string
    contract: SpatialHttpWireContract
  } {
    if (!this.contract) {
      throw new ProviderDefinitelyNotAcceptedError(
        `${this.provider} official wire contract is not installed; refusing to guess API fields.`,
      )
    }
    if (!this.token?.trim()) {
      throw new ProviderDefinitelyNotAcceptedError(
        `${this.provider} API token is not configured; no request was sent.`,
      )
    }
    return { base: parseBaseUrl(this.baseUrl), token: this.token.trim(), contract: this.contract }
  }

  private requireSubmissionEnabled(): {
    base: URL
    token: string
    contract: SpatialHttpWireContract
  } {
    if (!this.allowPaidCalls) {
      throw new ProviderDefinitelyNotAcceptedError(
        `${this.provider} paid submissions are disabled; no request was sent.`,
      )
    }
    return this.requireConfigured()
  }

  async submit(
    job: SpatialBuildJobRecord,
    context: { providerIdempotencyKey: string; signal?: AbortSignal },
  ): Promise<SpatialProviderSubmission> {
    const { base, token, contract } = this.requireSubmissionEnabled()
    if (!this.supports(job.kind)) {
      throw new ProviderDefinitelyNotAcceptedError(
        `${this.provider} does not support ${job.kind} jobs; no request was sent.`,
      )
    }
    let url: URL
    let body: string
    try {
      url = resolveProviderUrl(base, contract.submitPath(job))
      body = JSON.stringify(contract.encodeSubmission(job))
    } catch (error) {
      throw new ProviderDefinitelyNotAcceptedError(
        `${this.provider} submission input failed local wire validation: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }
    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          ...(contract.submissionHeaders?.(job) ?? {}),
          Authorization: this.authorizationHeader(token),
          'Content-Type': 'application/json',
          ...(contract.idempotencyHeaderName
            ? { [contract.idempotencyHeaderName]: context.providerIdempotencyKey }
            : {}),
        },
        body,
        signal: context.signal,
        redirect: 'error',
      })
    } catch (error) {
      throw new ProviderSubmissionUnknownError(
        `${this.provider} submission transport ended without a trustworthy acceptance result.`,
        { cause: error },
      )
    }
    const payload = await responsePayload(response)
    if (!response.ok) {
      const certainty = contract.classifySubmissionFailure?.({ response, payload }) ?? 'unknown'
      const message = `${this.provider} submission returned HTTP ${response.status}${providerErrorDetail(payload, token)}.`
      if (certainty === 'not_accepted') throw new ProviderDefinitelyNotAcceptedError(message)
      throw new ProviderSubmissionUnknownError(message)
    }
    try {
      const decoded = contract.decodeSubmission(payload)
      if (!decoded.externalJobId?.trim()) throw new Error('externalJobId was empty')
      return { ...decoded, externalJobId: decoded.externalJobId.trim() }
    } catch (error) {
      throw new ProviderSubmissionUnknownError(
        `${this.provider} accepted a submission response but its external job id could not be decoded.`,
        { cause: error },
      )
    }
  }

  async poll(
    job: SpatialBuildJobRecord,
    context: { signal?: AbortSignal },
  ): Promise<SpatialProviderPollResult> {
    // Recovery of an already-paid external job must remain available while
    // operators disable new paid submissions during an incident.
    let configured: ReturnType<ContractDrivenSpatialHttpAdapter['requireConfigured']>
    try {
      configured = this.requireConfigured()
    } catch (error) {
      if (error instanceof ProviderDefinitelyNotAcceptedError) {
        throw new ProviderConfigurationBlockedError(error.message, { cause: error })
      }
      throw error
    }
    const { base, token, contract } = configured
    if (!job.external_job_id) {
      throw new ProviderTransientError(`${this.provider} job has no external id to poll.`)
    }
    const url = resolveProviderUrl(base, contract.pollPath(job))
    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: { Authorization: this.authorizationHeader(token) },
        signal: context.signal,
        redirect: 'error',
      })
    } catch (error) {
      throw new ProviderTransientError(`${this.provider} poll transport failed.`, { cause: error })
    }
    const payload = await responsePayload(response)
    if (!response.ok) {
      throw new ProviderTransientError(`${this.provider} poll returned HTTP ${response.status}.`)
    }
    try {
      return contract.decodePoll(payload, job)
    } catch (error) {
      throw new ProviderTransientError(`${this.provider} poll response could not be decoded.`, { cause: error })
    }
  }
}
