import type { Quaternion, SceneTransform3D, SceneViewpoint, Vec3 } from './scene-types'

function finite(label: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${label} 必须是有限数字。`)
  return value
}

export function normalizeVec3(label: string, value: unknown): Vec3 {
  if (!Array.isArray(value) || value.length !== 3) throw new TypeError(`${label} 必须是三个数字。`)
  return [finite(`${label}[0]`, value[0]), finite(`${label}[1]`, value[1]), finite(`${label}[2]`, value[2])]
}

export function eulerDegreesToQuaternion(rotation: unknown): Quaternion {
  const [x, y, z] = normalizeVec3('rotation_deg', rotation)
  const half = Math.PI / 360
  const cx = Math.cos(x * half); const sx = Math.sin(x * half)
  const cy = Math.cos(y * half); const sy = Math.sin(y * half)
  const cz = Math.cos(z * half); const sz = Math.sin(z * half)
  const quaternion: Quaternion = [
    sx * cy * cz - cx * sy * sz,
    cx * sy * cz + sx * cy * sz,
    cx * cy * sz - sx * sy * cz,
    cx * cy * cz + sx * sy * sz,
  ]
  const magnitude = Math.hypot(...quaternion)
  if (!Number.isFinite(magnitude) || magnitude < 1e-12) throw new TypeError('rotation_deg 无法转换为有效旋转。')
  return quaternion.map(value => value / magnitude) as Quaternion
}

export function quaternionToEulerDegrees(value: unknown): Vec3 {
  if (!Array.isArray(value) || value.length !== 4) throw new TypeError('rotation_quaternion 必须是四个数字。')
  const [rawX, rawY, rawZ, rawW] = value.map((item, index) => finite(`rotation_quaternion[${index}]`, item))
  const magnitude = Math.hypot(rawX, rawY, rawZ, rawW)
  if (!Number.isFinite(magnitude) || magnitude < 1e-12) throw new TypeError('rotation_quaternion 不是有效旋转。')
  const x = rawX / magnitude; const y = rawY / magnitude; const z = rawZ / magnitude; const w = rawW / magnitude
  const roll = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y))
  const pitchInput = 2 * (w * y - z * x)
  const pitch = Math.abs(pitchInput) >= 1 ? Math.sign(pitchInput) * Math.PI / 2 : Math.asin(pitchInput)
  const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z))
  const degrees = 180 / Math.PI
  return [roll * degrees, pitch * degrees, yaw * degrees]
}

export function normalizeScale(value: unknown): Vec3 {
  const scale = normalizeVec3('scale', value)
  if (scale.some(component => component <= 0)) throw new TypeError('scale 的三个分量都必须大于 0。')
  return scale
}

export function normalizeTransform(input: {
  position?: unknown
  rotation_deg?: unknown
  scale?: unknown
}, fallback?: SceneTransform3D): SceneTransform3D {
  return {
    position: input.position === undefined ? (fallback?.position ?? [0, 0, 0]) : normalizeVec3('position', input.position),
    rotation_quaternion: input.rotation_deg === undefined
      ? (fallback?.rotation_quaternion ?? [0, 0, 0, 1])
      : eulerDegreesToQuaternion(input.rotation_deg),
    scale: input.scale === undefined ? (fallback?.scale ?? [1, 1, 1]) : normalizeScale(input.scale),
  }
}

function dot(a: Vec3, b: Vec3): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] }
function subtract(a: Vec3, b: Vec3): Vec3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]] }
function length(value: Vec3): number { return Math.hypot(...value) }

export function normalizeViewpoint(value: {
  position: unknown
  target: unknown
  up?: unknown
  fov_deg?: unknown
}): SceneViewpoint {
  const position = normalizeVec3('position', value.position)
  const target = normalizeVec3('target', value.target)
  const up = value.up === undefined ? [0, 0, 1] as Vec3 : normalizeVec3('up', value.up)
  const direction = subtract(target, position)
  if (length(direction) < 1e-6) throw new TypeError('position 与 target 不能重合。')
  if (length(up) < 1e-6) throw new TypeError('up 不能是零向量。')
  const cosine = Math.abs(dot(direction, up) / (length(direction) * length(up)))
  if (cosine > 0.999) throw new TypeError('up 不能与观察方向共线。')
  const fov = value.fov_deg === undefined ? 56 : finite('fov_deg', value.fov_deg)
  if (fov < 20 || fov > 100) throw new TypeError('fov_deg 必须位于 20–100。')
  return { position, target, up, fov_deg: fov }
}
