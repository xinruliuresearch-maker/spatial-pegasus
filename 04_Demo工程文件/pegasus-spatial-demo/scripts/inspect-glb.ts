import { readFile } from 'node:fs/promises'

interface GltfAccessor { count?: number; min?: number[]; max?: number[] }
interface GltfPrimitive { attributes?: Record<string, number>; indices?: number; material?: number; mode?: number }
interface GltfDocument {
  accessors?: GltfAccessor[]
  meshes?: Array<{ primitives?: GltfPrimitive[] }>
  materials?: unknown[]
  textures?: unknown[]
  images?: Array<{ uri?: string; bufferView?: number; mimeType?: string }>
  nodes?: unknown[]
  animations?: unknown[]
  extensionsUsed?: string[]
}

async function inspect(path: string): Promise<void> {
  const bytes = await readFile(path)
  if (bytes.subarray(0, 4).toString('ascii') !== 'glTF') throw new Error(`${path} is not a GLB.`)
  const jsonLength = bytes.readUInt32LE(12)
  const jsonType = bytes.subarray(16, 20).toString('ascii')
  if (jsonType !== 'JSON') throw new Error(`${path} has no leading JSON chunk.`)
  const document = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8').replace(/\0+$/g, '')) as GltfDocument
  const primitives = (document.meshes ?? []).flatMap(mesh => mesh.primitives ?? [])
  let vertices = 0
  let indices = 0
  const minimum = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY]
  const maximum = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY]
  for (const primitive of primitives) {
    const position = primitive.attributes?.POSITION
    if (position !== undefined) {
      const accessor = document.accessors?.[position]
      vertices += accessor?.count ?? 0
      for (let axis = 0; axis < 3; axis += 1) {
        if (accessor?.min?.[axis] !== undefined) minimum[axis] = Math.min(minimum[axis], accessor.min[axis])
        if (accessor?.max?.[axis] !== undefined) maximum[axis] = Math.max(maximum[axis], accessor.max[axis])
      }
    }
    if (primitive.indices !== undefined) indices += document.accessors?.[primitive.indices]?.count ?? 0
  }
  console.log(JSON.stringify({
    path,
    bytes: bytes.length,
    version: bytes.readUInt32LE(4),
    declared_bytes: bytes.readUInt32LE(8),
    meshes: document.meshes?.length ?? 0,
    primitives: primitives.length,
    vertices,
    indices,
    approximate_triangles: Math.floor(indices / 3),
    materials: document.materials?.length ?? 0,
    textures: document.textures?.length ?? 0,
    images: (document.images ?? []).map(image => ({
      storage: image.uri ? 'external-uri' : image.bufferView !== undefined ? 'embedded' : 'unknown',
      mime_type: image.mimeType ?? null,
      uri: image.uri ?? null,
    })),
    nodes: document.nodes?.length ?? 0,
    animations: document.animations?.length ?? 0,
    bounds: minimum.every(Number.isFinite) && maximum.every(Number.isFinite)
      ? { min: minimum, max: maximum, size: maximum.map((value, axis) => value - minimum[axis]) }
      : null,
    extensions_used: document.extensionsUsed ?? [],
  }))
}

void Promise.all(process.argv.slice(2).map(inspect)).catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
