interface Accessor { count?: number; min?: number[]; max?: number[] }
interface Primitive { attributes?: Record<string, number>; indices?: number; mode?: number }
interface Document {
  accessors?: Accessor[]
  meshes?: Array<{ primitives?: Primitive[] }>
  materials?: unknown[]
  textures?: unknown[]
  images?: Array<{ uri?: string; bufferView?: number; mimeType?: string }>
  extensionsUsed?: string[]
}

export interface GlbSpatialMetadata {
  format: 'glb'; gltf_version: number; up_axis: 'Y'; meshes: number; primitives: number
  vertices: number; triangles: number; materials: number; textures: number
  images: Array<{ storage: 'embedded' | 'external' | 'unknown'; mime_type: string | null }>
  has_external_resources: boolean
  bounds: { min: [number, number, number]; max: [number, number, number]; size: [number, number, number] } | null
  extensions_used: string[]
}

function invalid(message: string): never { throw new TypeError(message) }

export function inspectGlbMetadata(bytes: Buffer): GlbSpatialMetadata {
  if (bytes.length < 20 || bytes.subarray(0, 4).toString('ascii') !== 'glTF') invalid('GLB 缺少 glTF magic。')
  const version = bytes.readUInt32LE(4); const declared = bytes.readUInt32LE(8); const jsonLength = bytes.readUInt32LE(12)
  if (version !== 2 || declared !== bytes.length || jsonLength < 2 || 20 + jsonLength > bytes.length) invalid('GLB header 或声明长度无效。')
  if (bytes.subarray(16, 20).toString('ascii') !== 'JSON') invalid('GLB 首个 chunk 不是 JSON。')
  let document: Document
  try { document = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8').replace(/\0+$/g, '')) as Document } catch { invalid('GLB JSON chunk 无法解析。') }
  const primitives = (document.meshes ?? []).flatMap(mesh => mesh.primitives ?? [])
  let vertices = 0; let triangles = 0
  const minimum = [Infinity, Infinity, Infinity]; const maximum = [-Infinity, -Infinity, -Infinity]
  for (const primitive of primitives) {
    const positionIndex = primitive.attributes?.POSITION
    if (positionIndex !== undefined) {
      const accessor = document.accessors?.[positionIndex]; vertices += accessor?.count ?? 0
      for (let axis = 0; axis < 3; axis += 1) {
        const min = accessor?.min?.[axis]; const max = accessor?.max?.[axis]
        if (typeof min === 'number' && Number.isFinite(min)) minimum[axis] = Math.min(minimum[axis], min)
        if (typeof max === 'number' && Number.isFinite(max)) maximum[axis] = Math.max(maximum[axis], max)
      }
    }
    const indexCount = primitive.indices === undefined ? undefined : document.accessors?.[primitive.indices]?.count
    const count = indexCount ?? (positionIndex === undefined ? 0 : document.accessors?.[positionIndex]?.count ?? 0)
    if ((primitive.mode ?? 4) === 4) triangles += Math.floor(count / 3)
  }
  const images = (document.images ?? []).map(image => ({ storage: image.uri ? 'external' as const : image.bufferView !== undefined ? 'embedded' as const : 'unknown' as const, mime_type: image.mimeType ?? null }))
  return {
    format: 'glb', gltf_version: version, up_axis: 'Y', meshes: document.meshes?.length ?? 0,
    primitives: primitives.length, vertices, triangles, materials: document.materials?.length ?? 0,
    textures: document.textures?.length ?? 0, images,
    has_external_resources: images.some(image => image.storage === 'external'),
    bounds: minimum.every(Number.isFinite) && maximum.every(Number.isFinite)
      ? { min: minimum as [number, number, number], max: maximum as [number, number, number], size: maximum.map((value, axis) => value - minimum[axis]) as [number, number, number] }
      : null,
    extensions_used: (document.extensionsUsed ?? []).filter(value => typeof value === 'string'),
  }
}
