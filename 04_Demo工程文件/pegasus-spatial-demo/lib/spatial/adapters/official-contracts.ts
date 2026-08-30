import { posix } from 'node:path'
import type { ProviderArtifactDescriptor, SpatialBuildJobRecord, SpatialProviderPollResult } from '../types'
import type { SpatialHttpWireContract } from './http-contract'

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`)
  }
  return value as Record<string, unknown>
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function providerOptions(job: SpatialBuildJobRecord): Record<string, unknown> {
  const value = job.request_snapshot.provider_options
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {}
}

function frozenSourceImages(job: SpatialBuildJobRecord): string[] {
  const options = providerOptions(job)
  const singular = optionalText(options.source_image_url)
  const plural = Array.isArray(options.source_image_urls)
    ? options.source_image_urls.map(optionalText).filter((value): value is string => !!value)
    : []
  const values = [...(singular ? [singular] : []), ...plural]
  return [...new Set(values)]
}

type LuxOutputFormat = 'glb' | 'ply'
type LuxVersion = 'G1' | 'G1-Turbo'

function frozenLuxVersion(job: SpatialBuildJobRecord, imageCount: number): LuxVersion {
  const configured = optionalText(providerOptions(job).version)
  const version = configured ?? (imageCount > 1 ? 'G1-Turbo' : 'G1')
  if (version !== 'G1' && version !== 'G1-Turbo') {
    throw new TypeError('Lux3D version must be G1 or G1-Turbo.')
  }
  if (imageCount > 1 && version !== 'G1-Turbo') {
    throw new TypeError('Lux3D multi-image generation requires G1-Turbo.')
  }
  return version
}

function frozenLuxOutputFormats(job: SpatialBuildJobRecord): LuxOutputFormat[] {
  const configured = providerOptions(job).output_formats
  if (configured === undefined) return ['glb']
  if (!Array.isArray(configured) || configured.length < 1 || configured.length > 2) {
    throw new TypeError('Lux3D output_formats must contain one or two formats.')
  }
  const formats = configured.map(value => optionalText(value)?.toLowerCase())
  if (formats.some(value => value !== 'glb' && value !== 'ply')) {
    throw new TypeError('Lux3D output_formats only supports glb and ply.')
  }
  if (new Set(formats).size !== formats.length) {
    throw new TypeError('Lux3D output_formats cannot contain duplicates.')
  }
  return formats as LuxOutputFormat[]
}

function safeRemoteFilename(urlValue: string, fallback: string): string {
  try {
    const name = posix.basename(new URL(urlValue).pathname)
    return name && name.includes('.') ? name : fallback
  } catch {
    return fallback
  }
}

function providerFailureCertainty(response: Response): 'not_accepted' | 'unknown' {
  return [400, 401, 403, 404, 405, 415, 422].includes(response.status)
    ? 'not_accepted'
    : 'unknown'
}

export function createAholoOfficialWireContract(): SpatialHttpWireContract {
  return {
    submitPath: () => '/world/v1/generations',
    pollPath: job => `/world/v1/${encodeURIComponent(job.external_job_id || '')}`,
    submissionHeaders: () => ({ 'x-source': 'skills' }),
    encodeSubmission(job) {
      const options = providerOptions(job)
      const images = frozenSourceImages(job)
      if (images.length > 1) {
        throw new TypeError('Aholo World generation accepts at most one frozen source image.')
      }
      const prompt = optionalText(job.request_snapshot.prompt)
      if (!prompt && images.length === 0) {
        throw new TypeError('Aholo World generation requires prompt or one frozen source image.')
      }
      return {
        ...(optionalText(options.name) ? { name: optionalText(options.name) } : {}),
        ...(optionalText(options.cover) ? { cover: optionalText(options.cover) } : {}),
        ...(images[0] ? { resources: [{ url: images[0], type: 'image' as const }] } : {}),
        ...(prompt ? { prompt } : {}),
      }
    },
    decodeSubmission(payload) {
      const worldId = optionalText(object(payload, 'Aholo generation response').worldId)
      if (!worldId) throw new TypeError('Aholo generation response did not contain worldId.')
      return { externalJobId: worldId, providerStatus: 'submitted' }
    },
    decodePoll(payload): SpatialProviderPollResult {
      const root = object(payload, 'Aholo world response')
      const status = optionalText(root.status)?.toLowerCase()
      if (!status) throw new TypeError('Aholo world response did not contain a status.')
      if (['failed', 'timeout', 'rejected'].includes(status)) {
        return { state: 'failed', providerStatus: status, error: optionalText(root.message) }
      }
      if (status === 'canceled') {
        return { state: 'cancelled', providerStatus: status, error: optionalText(root.message) }
      }
      if (status === 'pending') return { state: 'queued', providerStatus: status }
      if (status === 'preprocessing' || status === 'running') {
        return { state: 'running', providerStatus: status }
      }
      if (status !== 'succeeded') {
        throw new TypeError(`Aholo world response contained unsupported status: ${status}`)
      }
      const assets = root.assets && typeof root.assets === 'object' && !Array.isArray(root.assets)
        ? root.assets as Record<string, unknown>
        : null
      const imagery = assets?.imagery && typeof assets.imagery === 'object' && !Array.isArray(assets.imagery)
        ? assets.imagery as Record<string, unknown>
        : null
      const splats = assets?.splats && typeof assets.splats === 'object' && !Array.isArray(assets.splats)
        ? assets.splats as Record<string, unknown>
        : null
      const urls = splats?.urls && typeof splats.urls === 'object' && !Array.isArray(splats.urls)
        ? splats.urls as Record<string, unknown>
        : null
      const semantics = assets?.semanticsMetadata
        && typeof assets.semanticsMetadata === 'object'
        && !Array.isArray(assets.semanticsMetadata)
        ? assets.semanticsMetadata as Record<string, unknown>
        : null
      const upAxis = optionalText(semantics?.upAxis)
      const descriptors: ProviderArtifactDescriptor[] = []
      const panoUrl = optionalText(imagery?.panoUrl)
      if (panoUrl) descriptors.push({
        assetKey: 'world-pano',
        kind: 'thumbnail',
        fileName: safeRemoteFilename(panoUrl, 'panorama.jpg'),
        remoteUrl: panoUrl,
        claimedMimeType: 'image/jpeg',
        metadata: { ...(upAxis ? { up_axis: upAxis } : {}) },
      })
      const plyPath = optionalText(urls?.plyPath)
      if (plyPath) descriptors.push({
        assetKey: 'world-ply',
        kind: 'point_cloud',
        fileName: safeRemoteFilename(plyPath, 'world.ply'),
        remoteUrl: plyPath,
        claimedMimeType: 'application/octet-stream',
        metadata: { ...(upAxis ? { up_axis: upAxis } : {}) },
      })
      const spzPath = optionalText(urls?.spzPath)
      if (spzPath) descriptors.push({
        assetKey: 'world-spz',
        kind: 'point_cloud',
        fileName: safeRemoteFilename(spzPath, 'world.spz'),
        remoteUrl: spzPath,
        claimedMimeType: 'application/octet-stream',
        metadata: { ...(upAxis ? { up_axis: upAxis } : {}) },
      })
      const lodMetaPath = optionalText(urls?.lodMetaPath)
      if (lodMetaPath) descriptors.push({
        assetKey: 'world-lod-metadata',
        kind: 'manifest',
        fileName: safeRemoteFilename(lodMetaPath, 'lod-metadata.json'),
        remoteUrl: lodMetaPath,
        claimedMimeType: 'application/json',
        metadata: { ...(upAxis ? { up_axis: upAxis } : {}) },
      })
      if (!descriptors.length) {
        throw new TypeError('Aholo SUCCEEDED response contained no downloadable assets.')
      }
      return { state: 'succeeded', providerStatus: status, artifacts: descriptors }
    },
    classifySubmissionFailure: ({ response }) => providerFailureCertainty(response),
  }
}

export function createLux3DOfficialG1WireContract(): SpatialHttpWireContract {
  return {
    submitPath(job) {
      return optionalText(job.request_snapshot.prompt)
        ? '/lux3d/v1/generate/text-to-3d/task/create'
        : '/lux3d/v1/generate/img-to-3d/task/create'
    },
    pollPath: job => `/lux3d/v1/generate/task/get?taskid=${encodeURIComponent(job.external_job_id || '')}`,
    encodeSubmission(job) {
      const images = frozenSourceImages(job)
      const outputFormats = frozenLuxOutputFormats(job)
      const version = frozenLuxVersion(job, images.length)
      if (images.length > 32) throw new TypeError('Lux3D accepts at most 32 frozen source images.')
      const prompt = optionalText(job.request_snapshot.prompt)
      if (prompt && images.length > 1) {
        throw new TypeError('Lux3D text-to-3D accepts at most one frozen reference image.')
      }
      if (!images.length && !prompt) {
        throw new TypeError('Lux3D requires prompt or at least one frozen source image.')
      }
      return {
        ...(images.length === 1 ? { img: images[0] } : {}),
        ...(images.length > 1 ? { imgs: images } : {}),
        ...(prompt ? { prompt } : {}),
        outputFormat: outputFormats,
        version,
        faceCount: version === 'G1-Turbo' ? 200000 : 60000,
        ...(version === 'G1-Turbo' ? { enablePbr: true } : {}),
      }
    },
    decodeSubmission(payload) {
      const root = object(payload, 'Lux3D creation response')
      const rawTaskId = root.d
      const taskId = typeof rawTaskId === 'number' && Number.isFinite(rawTaskId)
        ? String(rawTaskId)
        : optionalText(rawTaskId)
      if (!taskId) throw new TypeError('Lux3D creation response did not contain d:taskId.')
      return { externalJobId: taskId, providerStatus: optionalText(root.m) || 'submitted' }
    },
    decodePoll(payload, job): SpatialProviderPollResult {
      const root = object(payload, 'Lux3D task response')
      const data = object(root.d, 'Lux3D task response.d')
      const status = Number(data.status)
      if (status === 0) return { state: 'queued', providerStatus: '0' }
      if (status === 1) return { state: 'running', providerStatus: '1' }
      if (status === 4) {
        return {
          state: 'failed',
          providerStatus: '4',
          error: optionalText(data.message) || optionalText(root.m) || 'Lux3D task failed.',
        }
      }
      if (status !== 3) {
        throw new TypeError(`Lux3D task response contained unknown status: ${String(data.status)}`)
      }
      // G1 uses fixed response slots: ZIP, GLB, then optional PLY. G1-Turbo
      // returns the explicitly requested formats in request order. Keep those
      // contracts separate so a Turbo GLB at index 0 is never mistaken for a
      // G1 ZIP, and a G1 ZIP is never published as a GLB.
      const outputFormats = frozenLuxOutputFormats(job)
      const version = frozenLuxVersion(job, frozenSourceImages(job).length)
      const outputs = Array.isArray(data.outputs) ? data.outputs : []
      const outputUrl = (index: number): string | null => {
        const entry = outputs[index]
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
        const value = optionalText((entry as Record<string, unknown>).content)
        return value && value !== 'NOT_REQUESTED' ? value : null
      }
      const artifacts: ProviderArtifactDescriptor[] = []
      const append = (format: LuxOutputFormat, index: number, remoteUrl: string | null) => {
        if (!remoteUrl) return
        artifacts.push(format === 'glb' ? {
          assetKey: `${version.toLowerCase()}-mesh-glb`,
          kind: 'model',
          fileName: 'model.glb',
          remoteUrl,
          claimedMimeType: 'model/gltf-binary',
          metadata: { output_index: index, output_format: format, lux_version: version },
        } : {
          assetKey: `${version.toLowerCase()}-gaussian-ply`,
          kind: 'point_cloud',
          fileName: 'gaussian.ply',
          remoteUrl,
          claimedMimeType: 'application/octet-stream',
          metadata: { output_index: index, output_format: format, lux_version: version },
        })
      }
      if (version === 'G1-Turbo') {
        outputFormats.forEach((format, index) => append(format, index, outputUrl(index)))
      } else {
        append('glb', 1, outputUrl(1))
        if (outputFormats.includes('ply')) append('ply', 2, outputUrl(2))
      }
      if (!artifacts.length) {
        throw new TypeError('Lux3D status=3 response contained no downloadable outputs[].content.')
      }
      return { state: 'succeeded', providerStatus: '3', artifacts }
    },
    classifySubmissionFailure: ({ response }) => providerFailureCertainty(response),
  }
}
