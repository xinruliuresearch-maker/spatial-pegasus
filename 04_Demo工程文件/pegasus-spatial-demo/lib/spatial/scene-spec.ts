import { createHash } from 'node:crypto'
import { normalizeTransform } from './scene-math'
import { sceneAlignedGlbSize } from './object-alignment'
import type {
  SceneObjectInstance,
  SceneProxyGeometry,
  SceneProxyMaterial,
  SceneProxyPrimitive,
  SceneTransform3D,
  Vec3,
} from './scene-types'

export interface SceneSpecEnvironmentV1 {
  image_path: string
  yaw_deg?: number
  exposure?: number
}

export interface SceneSpecFitV1 {
  width?: number
  depth?: number
  height?: number
}

export interface SceneSpecNodeV1 {
  key: string
  label?: string
  group?: string
  role?: 'terrain' | 'object'
  /** Exactly one of object_job_id or proxy is required. */
  object_job_id?: string
  /** Procedural greybox primitive. It does not require a published Object Job. */
  proxy?: SceneProxyGeometry
  visible?: boolean
  transform?: {
    position?: Vec3
    rotation_deg?: Vec3
    scale?: Vec3
  }
  fit?: SceneSpecFitV1
}

export interface SceneSpecV1 {
  schema_version: 1
  scene_id: string
  expected_scene_version: number
  environment?: SceneSpecEnvironmentV1 | null
  nodes: SceneSpecNodeV1[]
}

type ObjectSource = Pick<SceneObjectInstance,
  'source_job_id' | 'glb_artifact' | 'optional_ply_artifact' | 'normalization'>

function record(label: string, value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} 必须是对象。`)
  return value as Record<string, unknown>
}

function onlyKeys(label: string, value: Record<string, unknown>, allowed: readonly string[]): void {
  const set = new Set(allowed)
  const unknown = Object.keys(value).filter(key => !set.has(key))
  if (unknown.length) throw new TypeError(`${label} 包含未知字段：${unknown.join(', ')}。`)
}

function text(label: string, value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} 必须是非空字符串。`)
  const result = value.trim()
  if (result.length > max) throw new TypeError(`${label} 不能超过 ${max} 个字符。`)
  return result
}

function optionalText(label: string, value: unknown, max: number): string | undefined {
  return value === undefined ? undefined : text(label, value, max)
}

function finite(label: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${label} 必须是有限数字。`)
  return value
}

function positive(label: string, value: unknown): number {
  const result = finite(label, value)
  if (result <= 0) throw new TypeError(`${label} 必须大于 0。`)
  return result
}

function vec3(label: string, value: unknown, positiveOnly = false): Vec3 {
  if (!Array.isArray(value) || value.length !== 3) throw new TypeError(`${label} 必须是三个数字。`)
  return value.map((item, index) => positiveOnly
    ? positive(`${label}[${index}]`, item)
    : finite(`${label}[${index}]`, item)) as Vec3
}

function parseEnvironment(value: unknown): SceneSpecEnvironmentV1 | null | undefined {
  if (value === undefined || value === null) return value
  const input = record('environment', value)
  onlyKeys('environment', input, ['image_path', 'yaw_deg', 'exposure'])
  return {
    image_path: text('environment.image_path', input.image_path, 512),
    ...(input.yaw_deg === undefined ? {} : { yaw_deg: finite('environment.yaw_deg', input.yaw_deg) }),
    ...(input.exposure === undefined ? {} : { exposure: positive('environment.exposure', input.exposure) }),
  }
}

function parseFit(value: unknown, label: string): SceneSpecFitV1 | undefined {
  if (value === undefined) return undefined
  const input = record(label, value)
  onlyKeys(label, input, ['width', 'depth', 'height'])
  const dimensions = ['width', 'depth', 'height'].filter(key => input[key] !== undefined)
  if (dimensions.length !== 1) throw new TypeError(`${label} 必须且只能提供 width、depth、height 之一。`)
  const key = dimensions[0] as keyof SceneSpecFitV1
  return { [key]: positive(`${label}.${key}`, input[key]) }
}

const PROXY_PRIMITIVES: readonly SceneProxyPrimitive[] = ['box', 'cylinder', 'arch']
const PROXY_MATERIALS: readonly SceneProxyMaterial[] = ['matte', 'metal', 'stone', 'sand', 'glass', 'emissive']

function parseProxy(value: unknown, label: string): SceneProxyGeometry {
  const input = record(label, value)
  onlyKeys(label, input, ['kind', 'dimensions', 'color', 'material', 'opacity'])
  if (!PROXY_PRIMITIVES.includes(input.kind as SceneProxyPrimitive)) {
    throw new TypeError(`${label}.kind 必须是 ${PROXY_PRIMITIVES.join('、')} 之一。`)
  }
  if (!PROXY_MATERIALS.includes(input.material as SceneProxyMaterial)) {
    throw new TypeError(`${label}.material 必须是 ${PROXY_MATERIALS.join('、')} 之一。`)
  }
  const color = text(`${label}.color`, input.color, 9)
  if (!/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/.test(color)) {
    throw new TypeError(`${label}.color 必须是 #RRGGBB 或 #RRGGBBAA。`)
  }
  const opacity = input.opacity === undefined ? 1 : finite(`${label}.opacity`, input.opacity)
  if (opacity <= 0 || opacity > 1) throw new TypeError(`${label}.opacity 必须大于 0 且不超过 1。`)
  return {
    kind: input.kind as SceneProxyPrimitive,
    dimensions: vec3(`${label}.dimensions`, input.dimensions, true),
    color,
    material: input.material as SceneProxyMaterial,
    opacity,
  }
}

function parseNode(value: unknown, index: number): SceneSpecNodeV1 {
  const label = `nodes[${index}]`
  const input = record(label, value)
  onlyKeys(label, input, ['key', 'label', 'group', 'role', 'object_job_id', 'proxy', 'visible', 'transform', 'fit'])
  const key = text(`${label}.key`, input.key, 96)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(key)) throw new TypeError(`${label}.key 只能包含字母、数字、下划线和连字符。`)
  const role = input.role === undefined ? 'object' : input.role
  if (role !== 'object' && role !== 'terrain') throw new TypeError(`${label}.role 必须是 object 或 terrain。`)
  if (input.visible !== undefined && typeof input.visible !== 'boolean') throw new TypeError(`${label}.visible 必须是布尔值。`)
  const transformInput = input.transform === undefined ? undefined : record(`${label}.transform`, input.transform)
  if (transformInput) onlyKeys(`${label}.transform`, transformInput, ['position', 'rotation_deg', 'scale'])
  const scale = transformInput?.scale === undefined ? undefined : vec3(`${label}.transform.scale`, transformInput.scale, true)
  const fit = parseFit(input.fit, `${label}.fit`)
  if (scale && fit) throw new TypeError(`${label} 不能同时提供 transform.scale 和 fit。`)
  const hasObject = input.object_job_id !== undefined
  const hasProxy = input.proxy !== undefined
  if (hasObject === hasProxy) throw new TypeError(`${label} 必须且只能提供 object_job_id 或 proxy 之一。`)
  const proxy = hasProxy ? parseProxy(input.proxy, `${label}.proxy`) : undefined
  if (proxy && fit) throw new TypeError(`${label}.proxy 不支持 fit；请直接设置 proxy.dimensions。`)
  return {
    key,
    label: optionalText(`${label}.label`, input.label, 160),
    group: optionalText(`${label}.group`, input.group, 96),
    role,
    ...(hasObject ? { object_job_id: text(`${label}.object_job_id`, input.object_job_id, 160) } : {}),
    ...(proxy ? { proxy } : {}),
    ...(input.visible === undefined ? {} : { visible: input.visible }),
    ...(transformInput ? {
      transform: {
        ...(transformInput.position === undefined ? {} : { position: vec3(`${label}.transform.position`, transformInput.position) }),
        ...(transformInput.rotation_deg === undefined ? {} : { rotation_deg: vec3(`${label}.transform.rotation_deg`, transformInput.rotation_deg) }),
        ...(scale ? { scale } : {}),
      },
    } : {}),
    ...(fit ? { fit } : {}),
  }
}

export function parseSceneSpecV1(raw: string): SceneSpecV1 {
  if (Buffer.byteLength(raw, 'utf8') > 2 * 1024 * 1024) throw new TypeError('Scene spec 不能超过 2MB。')
  let decoded: unknown
  try { decoded = JSON.parse(raw) } catch { throw new TypeError('Scene spec 必须是合法 JSON。') }
  const input = record('Scene spec', decoded)
  onlyKeys('Scene spec', input, ['schema_version', 'scene_id', 'expected_scene_version', 'environment', 'nodes'])
  if (input.schema_version !== 1) throw new TypeError('Scene spec schema_version 必须是 1。')
  if (!Number.isInteger(input.expected_scene_version) || Number(input.expected_scene_version) < 1) {
    throw new TypeError('expected_scene_version 必须是正整数。')
  }
  if (!Array.isArray(input.nodes) || input.nodes.length > 200) throw new TypeError('nodes 必须是最多 200 项的数组。')
  const nodes = input.nodes.map(parseNode)
  const keys = nodes.map(node => node.key)
  if (new Set(keys).size !== keys.length) throw new TypeError('nodes.key 不能重复。')
  return {
    schema_version: 1,
    scene_id: text('scene_id', input.scene_id, 160),
    expected_scene_version: Number(input.expected_scene_version),
    environment: parseEnvironment(input.environment),
    nodes,
  }
}

export function stableSceneInstanceId(sceneId: string, key: string): string {
  return `instance_${createHash('sha256').update(`${sceneId}\0${key}`).digest('hex').slice(0, 32)}`
}

function proxyObjectSource(sceneId: string, key: string, proxy: SceneProxyGeometry): ObjectSource {
  const [width, depth, height] = proxy.dimensions
  // Generic readers align GLB bounds from Y-up into this Z-up Scene. Encode
  // virtual bounds in Y-up so focus and Scene extent calculations still see
  // the requested `[width, depth, height]` dimensions.
  const sourceBounds = {
    min: [-width / 2, 0, -depth / 2] as Vec3,
    max: [width / 2, height, depth / 2] as Vec3,
    size: [width, height, depth] as Vec3,
  }
  const instanceId = stableSceneInstanceId(sceneId, key)
  const sourceJobId = `proxy:${sceneId}:${key}`
  return {
    source_job_id: sourceJobId,
    glb_artifact: {
      artifact_id: `artifact_${instanceId}`,
      job_id: sourceJobId,
      kind: 'scene_proxy',
      workspace_path: `virtual://spatial-scene/${sceneId}/${instanceId}.proxy`,
      mime_type: 'application/vnd.pegasus-spatial.proxy+json',
      size_bytes: 0,
      sha256: createHash('sha256').update(`${sceneId}\0${key}\0${JSON.stringify(proxy)}`).digest('hex'),
      metadata: { virtual: true, proxy },
    },
    normalization: {
      source_up_axis: 'Y',
      scene_up_axis: 'Z',
      pivot: 'bottom_center',
      glb_basis_correction: 'gltf_y_up_to_scene_z_up',
      bounds: sourceBounds,
    },
  }
}

function scaleFromFit(source: ObjectSource, fit: SceneSpecFitV1 | undefined): Vec3 | undefined {
  if (!fit) return undefined
  const size = sceneAlignedGlbSize(source.normalization)
  if (!size) throw new TypeError(`Object Job ${source.source_job_id} 缺少 GLB bounds，无法使用 fit。`)
  const axis = fit.width !== undefined ? 0 : fit.depth !== undefined ? 1 : 2
  const target = fit.width ?? fit.depth ?? fit.height!
  const sourceLength = size[axis]
  if (!Number.isFinite(sourceLength) || sourceLength <= 1e-6) throw new TypeError(`Object Job ${source.source_job_id} 的目标轴 bounds 无效。`)
  const factor = target / sourceLength
  return [factor, factor, factor]
}

export async function compileSceneSpecNodes(input: {
  sceneId: string
  nodes: SceneSpecNodeV1[]
  resolveObject(jobId: string): Promise<ObjectSource>
}): Promise<SceneObjectInstance[]> {
  const sourceCache = new Map<string, Promise<ObjectSource>>()
  const sourceFor = (jobId: string) => {
    const existing = sourceCache.get(jobId)
    if (existing) return existing
    const created = input.resolveObject(jobId)
    sourceCache.set(jobId, created)
    return created
  }
  return Promise.all(input.nodes.map(async node => {
    const source = node.proxy
      ? proxyObjectSource(input.sceneId, node.key, node.proxy)
      : await sourceFor(node.object_job_id!)
    const fittedScale = scaleFromFit(source, node.fit)
    const transform: SceneTransform3D = normalizeTransform({
      position: node.transform?.position,
      rotation_deg: node.transform?.rotation_deg,
      scale: node.transform?.scale ?? fittedScale,
    })
    return {
      instance_id: stableSceneInstanceId(input.sceneId, node.key),
      key: node.key,
      label: node.label ?? node.key,
      ...(node.group ? { group: node.group } : {}),
      visible: node.visible ?? true,
      role: node.role ?? 'object',
      ...(node.proxy ? { proxy: node.proxy } : {}),
      ...source,
      transform,
    }
  }))
}

export function summarizeSceneSpecChange(before: SceneObjectInstance[], after: SceneObjectInstance[]): string {
  const prior = new Map(before.map(instance => [instance.key ?? instance.instance_id, instance]))
  const next = new Map(after.map(instance => [instance.key ?? instance.instance_id, instance]))
  const added = [...next.keys()].filter(key => !prior.has(key)).length
  const removed = [...prior.keys()].filter(key => !next.has(key)).length
  const changed = [...next].filter(([key, value]) => {
    const old = prior.get(key)
    return old && JSON.stringify(old) !== JSON.stringify(value)
  }).length
  return `应用声明式 Scene：新增 ${added}，更新 ${changed}，移除 ${removed}`
}
