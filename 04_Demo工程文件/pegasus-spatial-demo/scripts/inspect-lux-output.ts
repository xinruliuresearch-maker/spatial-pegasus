import { connectDB } from '../lib/db/mongodb'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Lux3DAdapter } from '../lib/spatial/adapters/lux3d'
import { SpatialBuildJobModel } from '../lib/spatial/models'
import { readSpatialRuntimeConfig } from '../lib/spatial/runtime'

async function main(): Promise<void> {
  const jobId = process.argv[2]
  if (!jobId) throw new TypeError('Usage: inspect-lux-output.ts <job-id>')
  const downloadDir = process.argv[3] ? resolve(process.argv[3]) : null
  if (downloadDir) await mkdir(downloadDir, { recursive: true })
  await connectDB()
  const job = await SpatialBuildJobModel.findOne({ job_id: jobId }).lean()
  if (!job) throw new Error('Lux job not found.')
  const config = readSpatialRuntimeConfig()
  const adapter = new Lux3DAdapter({
    baseUrl: config.lux3d.apiBaseUrl,
    token: config.lux3d.apiKey,
    allowPaidCalls: false,
  })
  const polled = await adapter.poll(job, {})
  if (polled.state !== 'succeeded') throw new Error(`Lux job is not complete (${polled.state}).`)
  for (const [index, descriptor] of polled.artifacts.entries()) {
    if (!descriptor.remoteUrl) continue
    const remote = new URL(descriptor.remoteUrl)
    const response = await fetch(remote, {
      headers: { Range: 'bytes=0-127' },
      redirect: 'error',
    })
    const reader = response.body?.getReader()
    const first = reader ? await reader.read() : null
    await reader?.cancel()
    const bytes = first?.value ? Buffer.from(first.value).subarray(0, 32) : Buffer.alloc(0)
    console.log(JSON.stringify({
      index,
      declared_key: descriptor.assetKey,
      declared_file: descriptor.fileName,
      host: remote.hostname,
      path_extension: remote.pathname.split('.').pop()?.slice(0, 8) ?? null,
      http_status: response.status,
      content_type: response.headers.get('content-type'),
      content_length: response.headers.get('content-length'),
      content_range: response.headers.get('content-range'),
      magic_ascii: bytes.subarray(0, 16).toString('ascii').replace(/[^ -~]/g, '.'),
      magic_hex: bytes.subarray(0, 16).toString('hex'),
    }))
    if (downloadDir) {
      const download = await fetch(remote, { redirect: 'error' })
      if (!download.ok) throw new Error(`Artifact ${index} download returned HTTP ${download.status}.`)
      const buffer = Buffer.from(await download.arrayBuffer())
      if (buffer.length > 160 * 1024 * 1024) throw new Error(`Artifact ${index} exceeded diagnostic size limit.`)
      const extension = remote.pathname.toLowerCase().endsWith('.zip') ? 'zip'
        : bytes.subarray(0, 4).toString('ascii') === 'glTF' ? 'glb'
          : bytes.subarray(0, 3).toString('ascii') === 'ply' ? 'ply'
          : 'bin'
      const path = resolve(downloadDir, `lux-output-${index}.${extension}`)
      await writeFile(path, buffer)
      console.log(JSON.stringify({ index, downloaded_path: path, bytes: buffer.length }))
    }
  }
}

void main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
