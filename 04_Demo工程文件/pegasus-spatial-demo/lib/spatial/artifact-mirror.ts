import { createHash } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { posix } from 'node:path'
import { canonicalSpatialJson, normalizeSpatialWorkspacePrefix } from './identity'
import { inspectGlbMetadata } from './glb-metadata'
import type {
  MaterializedSpatialArtifact,
  ProviderArtifactDescriptor,
  SpatialArtifactRelation,
  SpatialAssetPublisher,
  SpatialBuildJobRecord,
  StagedSpatialAsset,
} from './types'

// Keep the remote-download ceiling aligned with Workspace immutable-document
// publication. Accepting bytes that can never be committed only creates a
// retry loop after the provider URL has started expiring.
const DEFAULT_MAX_ASSET_BYTES = 200 * 1024 * 1024
const DEFAULT_MAX_BATCH_BYTES = 384 * 1024 * 1024
const DEFAULT_MAX_ARTIFACT_COUNT = 16

export class SpatialAssetValidationError extends Error {
  readonly code = 'SPATIAL_ASSET_VALIDATION_ERROR'

  constructor(message: string) {
    super(message)
    this.name = 'SpatialAssetValidationError'
  }
}

/**
 * DNS transport failures are deliberately retryable. A provider artifact URL
 * may be short lived, but a temporary resolver outage is not evidence that
 * the already-paid provider output is unsafe or permanently invalid.
 */
export class SpatialArtifactDnsResolutionError extends Error {
  readonly code = 'SPATIAL_ARTIFACT_DNS_RESOLUTION_ERROR'

  constructor(hostname: string) {
    super(`Provider artifact hostname could not be resolved safely: ${hostname}`)
    this.name = 'SpatialArtifactDnsResolutionError'
  }
}

/** A temporary artifact transport response; the durable paid job may retry. */
export class SpatialArtifactDownloadTransientError extends Error {
  readonly code = 'SPATIAL_ARTIFACT_DOWNLOAD_TRANSIENT'

  constructor(status: number) {
    super(`Provider artifact download is temporarily unavailable (HTTP ${status}).`)
    this.name = 'SpatialArtifactDownloadTransientError'
  }
}

export interface InspectedSpatialAsset {
  mimeType: string
  extension: string
}

const MIME_ALIASES: Readonly<Record<string, readonly string[]>> = {
  'image/png': ['image/png'],
  'image/jpeg': ['image/jpeg', 'image/jpg'],
  'image/webp': ['image/webp'],
  'image/gif': ['image/gif'],
  'model/gltf-binary': ['model/gltf-binary', 'application/octet-stream'],
  'model/gltf+json': ['model/gltf+json', 'application/json', 'text/plain'],
  'application/ply': ['application/ply', 'application/octet-stream', 'text/plain'],
  'application/vnd.aholo.spz': ['application/vnd.aholo.spz', 'application/gzip', 'application/x-gzip', 'application/octet-stream'],
  'application/json': ['application/json', 'text/json', 'text/plain'],
}

function extensionOf(fileName: string): string {
  return posix.extname(fileName).slice(1).toLowerCase()
}

function startsWith(buffer: Buffer, bytes: readonly number[]): boolean {
  return bytes.every((value, index) => buffer[index] === value)
}

export function inspectSpatialAssetBytes(
  buffer: Buffer,
  fileName: string,
  claimedMimeType?: string,
): InspectedSpatialAsset {
  if (!buffer.length) throw new SpatialAssetValidationError('Provider artifact was empty.')
  const extension = extensionOf(fileName)
  let mimeType: string | null = null
  if (extension === 'png' && startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    mimeType = 'image/png'
  } else if ((extension === 'jpg' || extension === 'jpeg') && startsWith(buffer, [0xff, 0xd8, 0xff])) {
    mimeType = 'image/jpeg'
  } else if (
    extension === 'webp'
    && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    mimeType = 'image/webp'
  } else if (
    extension === 'gif'
    && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))
  ) {
    mimeType = 'image/gif'
  } else if (extension === 'glb' && buffer.subarray(0, 4).toString('ascii') === 'glTF' && buffer.length >= 12) {
    const version = buffer.readUInt32LE(4)
    const declaredLength = buffer.readUInt32LE(8)
    if (![1, 2].includes(version) || declaredLength !== buffer.length) {
      throw new SpatialAssetValidationError('GLB header version or declared byte length is invalid.')
    }
    mimeType = 'model/gltf-binary'
  } else if (extension === 'ply' && /^ply\r?\nformat\s+(ascii|binary_little_endian|binary_big_endian)\s+1\.0\r?\n/.test(buffer.subarray(0, 160).toString('ascii'))) {
    mimeType = 'application/ply'
  } else if (extension === 'spz' && startsWith(buffer, [0x1f, 0x8b])) {
    // Aholo's SPZ payload is gzip-framed. Full decompression is intentionally
    // deferred to the viewer; the bounded download and hash remain authoritative.
    mimeType = 'application/vnd.aholo.spz'
  } else if (extension === 'gltf' || extension === 'json') {
    try {
      JSON.parse(buffer.toString('utf8'))
      mimeType = extension === 'gltf' ? 'model/gltf+json' : 'application/json'
    } catch {
      throw new SpatialAssetValidationError(`.${extension} artifact is not valid JSON.`)
    }
  }
  if (!mimeType) {
    throw new SpatialAssetValidationError(
      `Artifact ${fileName} has unsupported or mismatched extension/magic bytes.`,
    )
  }

  const claim = claimedMimeType?.split(';', 1)[0]?.trim().toLowerCase()
  if (claim && !(MIME_ALIASES[mimeType] ?? []).includes(claim)) {
    throw new SpatialAssetValidationError(
      `Artifact MIME ${claim} conflicts with sniffed ${mimeType}.`,
    )
  }
  return { mimeType, extension }
}

function validateRemoteUrl(
  raw: string,
  options: { allowedHosts?: readonly string[]; allowInsecureLocalhost?: boolean },
): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new SpatialAssetValidationError('Provider artifact URL is invalid.')
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const local = ['127.0.0.1', 'localhost', '::1'].includes(hostname)
  if (url.protocol !== 'https:' && !(options.allowInsecureLocalhost && local && url.protocol === 'http:')) {
    throw new SpatialAssetValidationError('Provider artifact URL must use HTTPS.')
  }
  if (url.username || url.password) {
    throw new SpatialAssetValidationError('Provider artifact URL must not contain userinfo.')
  }
  if (url.port && !(options.allowInsecureLocalhost && local)) {
    throw new SpatialAssetValidationError('Provider artifact URL must use the default HTTPS port.')
  }
  if (isUnsafeSpatialArtifactHost(hostname) && !(options.allowInsecureLocalhost && local)) {
    throw new SpatialAssetValidationError(`Provider artifact host is not publicly routable: ${hostname}`)
  }
  if (options.allowedHosts?.length) {
    if (!options.allowedHosts.map(value => value.toLowerCase()).includes(hostname)) {
      throw new SpatialAssetValidationError(`Provider artifact host is not allowed: ${hostname}`)
    }
  }
  return url
}

function ipv4Octets(address: string): [number, number, number, number] | null {
  if (isIP(address) !== 4) return null
  const values = address.split('.').map(Number)
  return values.length === 4 && values.every(value => Number.isInteger(value) && value >= 0 && value <= 255)
    ? values as [number, number, number, number]
    : null
}

function isUnsafeIpv4Address(address: string): boolean {
  const octets = ipv4Octets(address)
  if (!octets) return true
  const [a, b, c] = octets
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 192 && b === 88 && c === 99)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224
}

function expandIpv6(address: string): number[] | null {
  let candidate = address.toLowerCase()
  const zone = candidate.indexOf('%')
  if (zone >= 0) candidate = candidate.slice(0, zone)
  if (candidate.includes('.')) {
    const separator = candidate.lastIndexOf(':')
    const octets = ipv4Octets(candidate.slice(separator + 1))
    if (separator < 0 || !octets) return null
    candidate = `${candidate.slice(0, separator)}:${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`
  }
  if (candidate.split('::').length > 2) return null
  const [leftRaw, rightRaw] = candidate.split('::')
  const left = leftRaw ? leftRaw.split(':') : []
  const right = rightRaw ? rightRaw.split(':') : []
  const compressed = candidate.includes('::')
  const missing = 8 - left.length - right.length
  if ((!compressed && missing !== 0) || (compressed && missing < 1)) return null
  const parts = [...left, ...Array.from({ length: missing }, () => '0'), ...right]
  if (parts.length !== 8 || parts.some(part => !/^[a-f0-9]{1,4}$/.test(part))) return null
  return parts.map(part => Number.parseInt(part, 16))
}

function isUnsafeIpv6Address(address: string): boolean {
  const parts = expandIpv6(address)
  if (!parts) return true
  // Fail closed to the currently allocated global-unicast block, then exclude
  // special-purpose ranges inside it. This also rejects IPv4-mapped, ULA,
  // link-local, multicast, NAT64 and unspecified/loopback addresses.
  if ((parts[0] & 0xe000) !== 0x2000) return true
  return (parts[0] === 0x2001 && parts[1] === 0x0000) // Teredo
    || (parts[0] === 0x2001 && parts[1] === 0x0002 && parts[2] === 0x0000) // benchmarking
    || (parts[0] === 0x2001 && (parts[1] & 0xfff0) === 0x0010) // ORCHIDv1
    || (parts[0] === 0x2001 && (parts[1] & 0xfff0) === 0x0020) // ORCHIDv2
    || (parts[0] === 0x2001 && parts[1] === 0x0db8) // documentation
    || parts[0] === 0x2002 // 6to4
}

export function isUnsafeSpatialArtifactAddress(address: string): boolean {
  const version = isIP(address)
  if (version === 4) return isUnsafeIpv4Address(address)
  if (version === 6) return isUnsafeIpv6Address(address)
  return true
}

export type SpatialHostnameResolver = (hostname: string) => Promise<readonly string[]>

const resolveSpatialArtifactHostname: SpatialHostnameResolver = async hostname => {
  const records = await lookup(hostname, { all: true, verbatim: true })
  return [...new Set(records.map(record => record.address))]
}

/**
 * Explicit proxy/Fake-IP compatibility path. Clash-style TUN DNS commonly
 * returns RFC 2544 addresses from 198.18.0.0/15, which must never be treated
 * as proof that a provider hostname is public. Resolve the hostname through a
 * fixed HTTPS DNS endpoint instead; the caller still applies the exact-host
 * allowlist and public-address checks to every returned A/AAAA record.
 */
export const resolveSpatialArtifactHostnameWithGoogleDoh: SpatialHostnameResolver = async hostname => {
  const addresses = new Set<string>()
  for (const type of ['A', 'AAAA'] as const) {
    const endpoint = new URL('https://dns.google/resolve')
    endpoint.searchParams.set('name', hostname)
    endpoint.searchParams.set('type', type)
    const response = await fetch(endpoint, {
      method: 'GET',
      redirect: 'error',
      headers: { Accept: 'application/dns-json' },
    })
    if (!response.ok) throw new SpatialArtifactDnsResolutionError(hostname)
    const raw = await boundedResponseBuffer(response, 64 * 1024)
    let payload: unknown
    try {
      payload = JSON.parse(raw.toString('utf8'))
    } catch {
      throw new SpatialArtifactDnsResolutionError(hostname)
    }
    const answers = payload && typeof payload === 'object' && Array.isArray((payload as { Answer?: unknown }).Answer)
      ? (payload as { Answer: Array<{ type?: unknown; data?: unknown }> }).Answer
      : []
    for (const answer of answers) {
      if ((answer.type === 1 || answer.type === 28) && typeof answer.data === 'string' && isIP(answer.data)) {
        addresses.add(answer.data)
      }
    }
  }
  if (addresses.size === 0) throw new SpatialArtifactDnsResolutionError(hostname)
  return [...addresses]
}

async function assertPublicDnsResolution(
  hostname: string,
  resolver: SpatialHostnameResolver,
): Promise<void> {
  let addresses: readonly string[]
  try {
    addresses = await resolver(hostname)
  } catch {
    throw new SpatialArtifactDnsResolutionError(hostname)
  }
  if (addresses.length === 0) {
    throw new SpatialArtifactDnsResolutionError(hostname)
  }
  if (addresses.some(isUnsafeSpatialArtifactAddress)) {
    throw new SpatialAssetValidationError(
      `Provider artifact hostname resolved to a private or reserved address: ${hostname}`,
    )
  }
}

function isExplicitlyAllowedLocalArtifact(
  hostname: string,
  allowInsecureLocalhost: boolean | undefined,
): boolean {
  return allowInsecureLocalhost === true
    && ['127.0.0.1', 'localhost', '::1'].includes(hostname)
}

export function isUnsafeSpatialArtifactHost(hostname: string): boolean {
  if (
    hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || hostname === 'metadata.google.internal'
  ) return true
  const ipVersion = isIP(hostname)
  if (ipVersion) return isUnsafeSpatialArtifactAddress(hostname)
  return false
}

async function boundedResponseBuffer(response: Response, maximum: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maximum) {
    throw new SpatialAssetValidationError(`Provider artifact exceeds ${maximum} bytes.`)
  }
  if (!response.body) throw new SpatialAssetValidationError('Provider artifact response had no body.')
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maximum) {
        await reader.cancel('spatial asset size limit exceeded')
        throw new SpatialAssetValidationError(`Provider artifact exceeds ${maximum} bytes.`)
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, size)
}

function providerFileName(value: string): string {
  const fileName = value.trim()
  if (
    !fileName
    || fileName === '.'
    || fileName === '..'
    || fileName.includes('/')
    || fileName.includes('\\')
    || fileName.includes('\0')
  ) {
    throw new SpatialAssetValidationError('Provider artifact filename must be a safe basename.')
  }
  return fileName
}

function artifactId(jobId: string, publicationToken: string, assetKey: string): string {
  const digest = createHash('sha256')
    .update(`${jobId}\0${publicationToken}\0${assetKey}`)
    .digest('hex')
    .slice(0, 40)
  return `spart_${digest}`
}

function uniqueRelations(
  job: SpatialBuildJobRecord,
  descriptor: ProviderArtifactDescriptor,
): SpatialArtifactRelation[] {
  const values = [
    ...(job.request_snapshot.relations ?? []),
    ...(descriptor.relations ?? []),
    ...sourceAssetRelations(job),
  ]
  const deduplicated = new Map<string, SpatialArtifactRelation>()
  for (const value of values) {
    const artifact = value.artifact_id?.trim()
    if (!artifact) continue
    deduplicated.set(`${value.kind}\0${artifact}`, { kind: value.kind, artifact_id: artifact })
  }
  return [...deduplicated.values()]
}

function sourceAssetRelations(job: SpatialBuildJobRecord): SpatialArtifactRelation[] {
  const options = job.request_snapshot.provider_options
  if (!options || typeof options !== 'object' || Array.isArray(options)) return []
  const singular = typeof options.source_asset_id === 'string' ? [options.source_asset_id] : []
  const plural = Array.isArray(options.source_asset_ids)
    ? options.source_asset_ids.filter((value): value is string => typeof value === 'string')
    : []
  return [...new Set([...singular, ...plural].map(value => value.trim()).filter(Boolean))]
    .map(artifact_id => ({ kind: 'conditioned_by' as const, artifact_id }))
}

export interface MirrorRemoteSpatialArtifactsOptions {
  job: SpatialBuildJobRecord
  publicationToken: string
  artifacts: readonly ProviderArtifactDescriptor[]
  publisher: SpatialAssetPublisher
  fetchImpl?: typeof fetch
  maxAssetBytes?: number
  maxBatchBytes?: number
  maxArtifactCount?: number
  allowedHosts?: readonly string[]
  resolveHostname?: SpatialHostnameResolver
  allowInsecureLocalhost?: boolean
  signal?: AbortSignal
  deriveArtifacts?: (staged: readonly StagedSpatialAsset[]) => readonly ProviderArtifactDescriptor[]
}

function materializedBatch(
  staged: readonly StagedSpatialAsset[],
  published: readonly import('./types').PublishedSpatialAsset[],
): MaterializedSpatialArtifact[] {
  if (published.length !== staged.length) {
    throw new SpatialAssetValidationError('Spatial publisher did not publish the complete staged batch.')
  }
  const byId = new Map(published.map(asset => [asset.artifactId, asset]))
  return staged.map(asset => {
    const visible = byId.get(asset.artifactId)
    if (!visible || visible.sha256 !== asset.sha256) {
      throw new SpatialAssetValidationError('Spatial publisher returned an inconsistent published batch.')
    }
    return {
      artifactId: asset.artifactId,
      providerAssetKey: asset.providerAssetKey,
      kind: asset.kind,
      filename: asset.filename,
      workspacePath: asset.workspacePath,
      storageUri: visible.storageUri,
      mimeType: asset.mimeType,
      sizeBytes: asset.sizeBytes,
      sha256: asset.sha256,
      relations: structuredClone(asset.relations),
      metadata: structuredClone(asset.metadata),
    }
  })
}

/** Resume a complete private mirror without polling or touching provider URLs. */
export async function publishReadySpatialArtifacts(input: {
  job: SpatialBuildJobRecord
  publicationToken: string
  publisher: SpatialAssetPublisher
}): Promise<{ artifacts: MaterializedSpatialArtifact[]; stages: StagedSpatialAsset[] } | null> {
  const stages = await input.publisher.recoverReadyBatch(input)
  if (!stages) return null
  const published = await input.publisher.publishBatch({
    job: input.job,
    publicationToken: input.publicationToken,
    assets: stages,
  })
  return { artifacts: materializedBatch(stages, published), stages }
}

/**
 * Download every short-lived provider URL into private staging, validate bytes,
 * and publish only after the complete batch has passed. Signed URLs are never
 * persisted or returned from this boundary.
 */
export async function mirrorRemoteSpatialArtifacts(
  options: MirrorRemoteSpatialArtifactsOptions,
): Promise<MaterializedSpatialArtifact[]> {
  if (!options.artifacts.length) {
    throw new SpatialAssetValidationError('Provider succeeded without any artifacts.')
  }
  const maximum = Math.max(1_024, options.maxAssetBytes ?? DEFAULT_MAX_ASSET_BYTES)
  const maximumBatch = Math.max(maximum, options.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES)
  const maximumArtifacts = Math.max(1, Math.min(64, options.maxArtifactCount ?? DEFAULT_MAX_ARTIFACT_COUNT))
  if (options.artifacts.length > maximumArtifacts) {
    throw new SpatialAssetValidationError(`Provider returned more than ${maximumArtifacts} artifacts.`)
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const prefix = normalizeSpatialWorkspacePrefix(options.job.request_snapshot.output_path_prefix)
  const seenKeys = new Set<string>()
  const seenPaths = new Set<string>()
  const staged: StagedSpatialAsset[] = []
  let totalBytes = 0

  try {
    const stageDescriptor = async (descriptor: ProviderArtifactDescriptor): Promise<void> => {
      const key = descriptor.assetKey.trim()
      if (!key || seenKeys.has(key)) {
        throw new SpatialAssetValidationError('Provider artifact keys must be non-empty and unique.')
      }
      seenKeys.add(key)
      const filename = providerFileName(descriptor.fileName)
      const workspacePath = `${prefix}/${filename}`
      if (seenPaths.has(workspacePath)) {
        throw new SpatialAssetValidationError(`Provider returned duplicate output path: ${workspacePath}`)
      }
      seenPaths.add(workspacePath)
      const hasRemote = typeof descriptor.remoteUrl === 'string' && !!descriptor.remoteUrl.trim()
      const hasInline = typeof descriptor.inlineContent === 'string'
      if (hasRemote === hasInline) {
        throw new SpatialAssetValidationError(
          'Provider artifact must contain exactly one of remoteUrl or inlineContent.',
        )
      }
      let buffer: Buffer
      let claimedMime = descriptor.claimedMimeType
      if (hasInline) {
        buffer = Buffer.from(descriptor.inlineContent!, 'utf8')
        if (buffer.length > maximum) {
          throw new SpatialAssetValidationError(`Provider inline artifact exceeds ${maximum} bytes.`)
        }
      } else {
        const requestedUrl = validateRemoteUrl(descriptor.remoteUrl!, options)
        const requestedHostname = requestedUrl.hostname.replace(/^\[|\]$/g, '').toLowerCase()
        if (!isExplicitlyAllowedLocalArtifact(requestedHostname, options.allowInsecureLocalhost)) {
          await assertPublicDnsResolution(
            requestedHostname,
            options.resolveHostname ?? resolveSpatialArtifactHostname,
          )
        }
        const response = await fetchImpl(requestedUrl, {
          method: 'GET',
          signal: options.signal,
          redirect: 'error',
          headers: { Accept: '*/*' },
        })
        if (!response.ok) {
          if ([408, 425, 429].includes(response.status) || response.status >= 500) {
            throw new SpatialArtifactDownloadTransientError(response.status)
          }
          throw new SpatialAssetValidationError(`Provider artifact download returned HTTP ${response.status}.`)
        }
        if (response.url) {
          const responseUrl = validateRemoteUrl(response.url, options)
          const responseHostname = responseUrl.hostname.replace(/^\[|\]$/g, '').toLowerCase()
          if (!isExplicitlyAllowedLocalArtifact(responseHostname, options.allowInsecureLocalhost)) {
            await assertPublicDnsResolution(
              responseHostname,
              options.resolveHostname ?? resolveSpatialArtifactHostname,
            )
          }
        }
        const remaining = maximumBatch - totalBytes
        if (remaining <= 0) {
          throw new SpatialAssetValidationError(`Provider artifact batch exceeds ${maximumBatch} bytes.`)
        }
        try {
          buffer = await boundedResponseBuffer(response, Math.min(maximum, remaining))
        } catch (error) {
          if (remaining < maximum && error instanceof SpatialAssetValidationError) {
            throw new SpatialAssetValidationError(`Provider artifact batch exceeds ${maximumBatch} bytes.`)
          }
          throw error
        }
        claimedMime ||= response.headers.get('content-type') || undefined
      }
      totalBytes += buffer.length
      if (totalBytes > maximumBatch) {
        throw new SpatialAssetValidationError(`Provider artifact batch exceeds ${maximumBatch} bytes.`)
      }
      const inspected = inspectSpatialAssetBytes(buffer, filename, claimedMime)
      const sha256 = createHash('sha256').update(buffer).digest('hex')
      let metadata = JSON.parse(canonicalSpatialJson(descriptor.metadata ?? {})) as Record<string, unknown>
      if (
        filename.toLowerCase().endsWith('.glb')
        && buffer.length >= 20
        && buffer.readUInt32LE(8) === buffer.length
        && buffer.subarray(16, 20).toString('ascii') === 'JSON'
      ) {
        try { metadata = { ...metadata, ...inspectGlbMetadata(buffer) } } catch (error) {
          throw new SpatialAssetValidationError(error instanceof Error ? error.message : 'GLB 元数据解析失败。')
        }
      }
      const id = artifactId(options.job.job_id, options.publicationToken, key)
      const stored = await options.publisher.stage({
        job: options.job,
        publicationToken: options.publicationToken,
        artifactId: id,
        providerAssetKey: key,
        kind: descriptor.kind,
        filename,
        workspacePath,
        buffer,
        mimeType: inspected.mimeType,
        sha256,
        relations: uniqueRelations(options.job, descriptor),
        metadata,
      })
      if (
        stored.artifactId !== id
        || stored.workspacePath !== workspacePath
        || stored.sha256 !== sha256
        || stored.sizeBytes !== buffer.length
      ) {
        throw new SpatialAssetValidationError('Spatial publisher returned inconsistent staging metadata.')
      }
      staged.push(stored)
    }

    for (const descriptor of options.artifacts) await stageDescriptor(descriptor)
    const derived = options.deriveArtifacts?.(staged) ?? []
    if (staged.length + derived.length > maximumArtifacts) {
      throw new SpatialAssetValidationError(`Provider batch exceeds ${maximumArtifacts} artifacts.`)
    }
    for (const descriptor of derived) {
      if (descriptor.remoteUrl) {
        throw new SpatialAssetValidationError('Derived spatial artifacts must be inline content.')
      }
      await stageDescriptor(descriptor)
    }

    await options.publisher.markBatchReady({
      job: options.job,
      publicationToken: options.publicationToken,
      assets: staged,
    })

    const published = await options.publisher.publishBatch({
      job: options.job,
      publicationToken: options.publicationToken,
      assets: staged,
    })
    return materializedBatch(staged, published)
  } catch (error) {
    // Private stages survive transient publication/process failures. They hold
    // no signed provider URL and are reclaimed by publisher TTL cleanup.
    throw error
  }
}

export function spatialMaxAssetBytesFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.SPATIAL_MAX_ASSET_BYTES)
  return Number.isSafeInteger(configured) && configured >= 1_024
    ? configured
    : DEFAULT_MAX_ASSET_BYTES
}

export function spatialMaxBatchBytesFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.SPATIAL_MAX_BATCH_BYTES)
  return Number.isSafeInteger(configured) && configured >= 1_024
    ? configured
    : DEFAULT_MAX_BATCH_BYTES
}

export function spatialMaxArtifactCountFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.SPATIAL_MAX_ARTIFACT_COUNT)
  return Number.isSafeInteger(configured) && configured >= 1 && configured <= 64
    ? configured
    : DEFAULT_MAX_ARTIFACT_COUNT
}
