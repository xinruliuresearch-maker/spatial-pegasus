import type { SceneObjectInstance, SceneObjectNormalization } from '@/lib/spatial/scene-types'

type AholoViewerSdk = typeof import('@manycore/aholo-viewer')
type Vec3 = [number, number, number]

export type SpatialProxyShape = 'box' | 'cylinder' | 'arch'

/**
 * Lightweight geometry authored directly in Scene coordinates.
 *
 * Canonical `dimensions` are `[width X, depth Y, height Z]`. Aliases are
 * accepted intentionally so old draft Scene specs remain viewable while the
 * persisted contract uses `primitive + dimensions`.
 */
export interface SpatialProxyDescription {
  primitive?: SpatialProxyShape
  shape?: SpatialProxyShape
  type?: SpatialProxyShape
  kind?: SpatialProxyShape
  size?: Vec3
  dimensions?: Vec3
  width?: number
  depth?: number
  height?: number
  radius?: number
  thickness?: number
  color?: string
  opacity?: number
  material?: string
}

export type SpatialStageInstance = Omit<SceneObjectInstance, 'source_job_id' | 'glb_artifact' | 'normalization' | 'proxy'> & {
  source_job_id?: string | null
  glb_artifact?: SceneObjectInstance['glb_artifact'] | null
  normalization?: SceneObjectNormalization | null
  proxy?: SpatialProxyDescription | null
}

export interface NormalizedSpatialProxy {
  shape: SpatialProxyShape
  size: Vec3
  thickness: number
  color: string
  opacity: number
}

const DEFAULT_SIZE: Vec3 = [1, 1, 1]

function positive(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

function tuple(value: unknown): Vec3 | null {
  if (!Array.isArray(value) || value.length !== 3) return null
  const result = value.map((item, index) => positive(item, DEFAULT_SIZE[index])) as Vec3
  return result
}

export function normalizeSpatialProxy(instance: SpatialStageInstance): NormalizedSpatialProxy | null {
  const value = instance.proxy
  if (!value || typeof value !== 'object') return null
  const shape = value.primitive ?? value.shape ?? value.type ?? value.kind
  if (shape !== 'box' && shape !== 'cylinder' && shape !== 'arch') return null

  let size = tuple(value.size) ?? tuple(value.dimensions)
  if (!size) {
    if (shape === 'cylinder') {
      const diameter = positive(value.radius, 0.5) * 2
      size = [positive(value.width, diameter), positive(value.depth, diameter), positive(value.height, 1)]
    } else {
      size = [positive(value.width, 1), positive(value.depth, 1), positive(value.height, 1)]
    }
  }

  const smallestArchDimension = Math.min(size[0], size[2])
  const thickness = Math.min(
    positive(value.thickness, smallestArchDimension * 0.18),
    smallestArchDimension * 0.48,
  )

  return {
    shape,
    size,
    thickness,
    color: typeof value.color === 'string' && value.color.trim() ? value.color : '#95a1b3',
    opacity: Math.min(1, Math.max(0.15, positive(value.opacity, 0.92))),
  }
}

export function spatialInstanceLocalSize(instance: SpatialStageInstance): Vec3 {
  const proxy = normalizeSpatialProxy(instance)
  if (proxy) return proxy.size
  if (!instance.glb_artifact) return DEFAULT_SIZE
  return instance.normalization?.bounds?.size ?? DEFAULT_SIZE
}

export function spatialInstanceAssetKey(instance: SpatialStageInstance): string | null {
  const proxy = normalizeSpatialProxy(instance)
  if (proxy) return `proxy:${JSON.stringify(proxy)}`
  if (instance.glb_artifact) {
    return `glb:${instance.glb_artifact.sha256}:${instance.glb_artifact.workspace_path}`
  }
  return null
}

function createProxyMaterial(sdk: AholoViewerSdk, proxy: NormalizedSpatialProxy) {
  return new sdk.MeshPhongMaterial({
    color: proxy.color,
    specular: '#1d2530',
    shininess: 10,
    opacity: proxy.opacity,
    transparent: proxy.opacity < 1,
  })
}

function createGeometry(
  sdk: AholoViewerSdk,
  positions: number[],
  normals: number[],
  indices: number[],
) {
  const geometry = new sdk.BufferGeometry()
  geometry.addOrSetAttribute('position', new Float32Array(positions), 3)
  geometry.addOrSetAttribute('normal', new Float32Array(normals), 3)
  geometry.setIndex(indices)
  return geometry
}

/** Build a bottom-centred Z-up box without relying on undocumented SDK helpers. */
function createBoxGeometry(sdk: AholoViewerSdk, size: Vec3) {
  const [width, depth, height] = size
  const x = width / 2
  const y = depth / 2
  const z0 = 0
  const z1 = height
  const positions = [
    // +X
    x, -y, z0, x, y, z0, x, y, z1, x, -y, z1,
    // -X
    -x, y, z0, -x, -y, z0, -x, -y, z1, -x, y, z1,
    // +Y
    x, y, z0, -x, y, z0, -x, y, z1, x, y, z1,
    // -Y
    -x, -y, z0, x, -y, z0, x, -y, z1, -x, -y, z1,
    // +Z
    -x, -y, z1, x, -y, z1, x, y, z1, -x, y, z1,
    // -Z
    -x, y, z0, x, y, z0, x, -y, z0, -x, -y, z0,
  ]
  const normals = [
    ...Array(4).fill([1, 0, 0]).flat(),
    ...Array(4).fill([-1, 0, 0]).flat(),
    ...Array(4).fill([0, 1, 0]).flat(),
    ...Array(4).fill([0, -1, 0]).flat(),
    ...Array(4).fill([0, 0, 1]).flat(),
    ...Array(4).fill([0, 0, -1]).flat(),
  ]
  const indices: number[] = []
  for (let face = 0; face < 6; face += 1) {
    const base = face * 4
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }
  return createGeometry(sdk, positions, normals, indices)
}

/** Build an elliptical, bottom-centred Z-up cylinder. */
function createCylinderGeometry(sdk: AholoViewerSdk, size: Vec3, segments = 24) {
  const [width, depth, height] = size
  const rx = width / 2
  const ry = depth / 2
  const positions: number[] = []
  const normals: number[] = []
  const indices: number[] = []

  for (let i = 0; i <= segments; i += 1) {
    const angle = (i / segments) * Math.PI * 2
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    const nxRaw = cos / rx
    const nyRaw = sin / ry
    const normalLength = Math.hypot(nxRaw, nyRaw)
    const nx = nxRaw / normalLength
    const ny = nyRaw / normalLength
    positions.push(rx * cos, ry * sin, 0, rx * cos, ry * sin, height)
    normals.push(nx, ny, 0, nx, ny, 0)
  }
  for (let i = 0; i < segments; i += 1) {
    const base = i * 2
    indices.push(base, base + 2, base + 3, base, base + 3, base + 1)
  }

  const bottomCenter = positions.length / 3
  positions.push(0, 0, 0)
  normals.push(0, 0, -1)
  const topCenter = positions.length / 3
  positions.push(0, 0, height)
  normals.push(0, 0, 1)
  const bottomStart = positions.length / 3
  for (let i = 0; i < segments; i += 1) {
    const angle = (i / segments) * Math.PI * 2
    positions.push(rx * Math.cos(angle), ry * Math.sin(angle), 0)
    normals.push(0, 0, -1)
  }
  const topStart = positions.length / 3
  for (let i = 0; i < segments; i += 1) {
    const angle = (i / segments) * Math.PI * 2
    positions.push(rx * Math.cos(angle), ry * Math.sin(angle), height)
    normals.push(0, 0, 1)
  }
  for (let i = 0; i < segments; i += 1) {
    const next = (i + 1) % segments
    indices.push(bottomCenter, bottomStart + next, bottomStart + i)
    indices.push(topCenter, topStart + i, topStart + next)
  }

  return createGeometry(sdk, positions, normals, indices)
}

function addBox(
  sdk: AholoViewerSdk,
  parent: import('@manycore/aholo-viewer').Object3D,
  proxy: NormalizedSpatialProxy,
  size: Vec3,
  position: Vec3,
) {
  const geometry = createBoxGeometry(sdk, size)
  const mesh = new sdk.Mesh(geometry, createProxyMaterial(sdk, proxy))
  mesh.position.set(...position)
  parent.add(mesh)
}

export function createSpatialProxyObject(
  sdk: AholoViewerSdk,
  instance: SpatialStageInstance,
): import('@manycore/aholo-viewer').Object3D | null {
  const proxy = normalizeSpatialProxy(instance)
  if (!proxy) return null

  const outer = new sdk.Object3D()
  outer.name = instance.label
  outer.userData.instanceId = instance.instance_id
  outer.userData.spatialProxy = true
  const [width, depth, height] = proxy.size

  if (proxy.shape === 'box') {
    addBox(sdk, outer, proxy, proxy.size, [0, 0, 0])
  } else if (proxy.shape === 'cylinder') {
    const mesh = new sdk.Mesh(
      createCylinderGeometry(sdk, proxy.size),
      createProxyMaterial(sdk, proxy),
    )
    outer.add(mesh)
  } else {
    const thickness = proxy.thickness
    const pillarHeight = Math.max(height - thickness, thickness)
    const pillarOffset = Math.max((width - thickness) / 2, 0)
    addBox(sdk, outer, proxy, [thickness, depth, pillarHeight], [-pillarOffset, 0, 0])
    addBox(sdk, outer, proxy, [thickness, depth, pillarHeight], [pillarOffset, 0, 0])
    addBox(sdk, outer, proxy, [width, depth, thickness], [0, 0, height - thickness])
  }

  return outer
}
