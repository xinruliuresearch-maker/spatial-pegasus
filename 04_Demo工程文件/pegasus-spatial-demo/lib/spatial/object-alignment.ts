import type { SceneObjectNormalization, Vec3 } from './scene-types'

export interface ObjectBounds { min: Vec3; max: Vec3 }

export interface ObjectLocalAlignment {
  correction: SceneObjectNormalization['glb_basis_correction'] | SceneObjectNormalization['ply_basis_correction']
  pivot: Vec3
  scale: Vec3
  rotationRadians: Vec3
  matrix: [Vec3, Vec3, Vec3]
}

const GLTF_Y_UP_TO_SCENE_Z_UP = {
  matrix: [[1, 0, 0], [0, 0, -1], [0, 1, 0]] as [Vec3, Vec3, Vec3],
  rotationRadians: [Math.PI / 2, 0, 0] as Vec3,
}

const LUX_PLY_NEGATIVE_Y_UP_TO_SCENE_Z_UP = {
  matrix: [[1, 0, 0], [0, 0, 1], [0, -1, 0]] as [Vec3, Vec3, Vec3],
  rotationRadians: [-Math.PI / 2, 0, 0] as Vec3,
}

function sizeOf(bounds: ObjectBounds): Vec3 {
  return bounds.max.map((maximum, axis) => maximum - bounds.min[axis]) as Vec3
}

function safeRatio(target: number, source: number): number {
  return Number.isFinite(target) && target > 0 && Number.isFinite(source) && source > 1e-6
    ? target / source
    : 1
}

export function rotateObjectBounds(bounds: ObjectBounds, matrix: [Vec3, Vec3, Vec3]): ObjectBounds {
  const corners: Vec3[] = []
  for (const x of [bounds.min[0], bounds.max[0]]) {
    for (const y of [bounds.min[1], bounds.max[1]]) {
      for (const z of [bounds.min[2], bounds.max[2]]) {
        corners.push(matrix.map(row => row[0] * x + row[1] * y + row[2] * z) as Vec3)
      }
    }
  }
  return {
    min: [0, 1, 2].map(axis => Math.min(...corners.map(corner => corner[axis]))) as Vec3,
    max: [0, 1, 2].map(axis => Math.max(...corners.map(corner => corner[axis]))) as Vec3,
  }
}

function bottomCenterPivot(bounds: ObjectBounds): Vec3 {
  return [
    -(bounds.min[0] + bounds.max[0]) / 2 || 0,
    -(bounds.min[1] + bounds.max[1]) / 2 || 0,
    -bounds.min[2] || 0,
  ]
}

export function sceneAlignedGlbBounds(normalization: SceneObjectNormalization): ObjectBounds | null {
  if (!normalization.bounds) return null
  return rotateObjectBounds(
    { min: normalization.bounds.min, max: normalization.bounds.max },
    GLTF_Y_UP_TO_SCENE_Z_UP.matrix,
  )
}

export function sceneAlignedGlbSize(normalization: SceneObjectNormalization): Vec3 | null {
  const bounds = sceneAlignedGlbBounds(normalization)
  return bounds ? sizeOf(bounds) : null
}

export function computeGlbObjectAlignment(normalization: SceneObjectNormalization): ObjectLocalAlignment {
  const correction = normalization.glb_basis_correction ?? 'gltf_y_up_to_scene_z_up'
  if (correction !== 'gltf_y_up_to_scene_z_up') throw new TypeError(`Unsupported GLB basis correction: ${correction}`)
  const rotatedBounds = sceneAlignedGlbBounds(normalization)
    ?? { min: [0, 0, 0] as Vec3, max: [0, 0, 0] as Vec3 }
  return {
    correction,
    pivot: bottomCenterPivot(rotatedBounds),
    scale: [1, 1, 1],
    rotationRadians: GLTF_Y_UP_TO_SCENE_Z_UP.rotationRadians,
    matrix: GLTF_Y_UP_TO_SCENE_Z_UP.matrix,
  }
}

export function computeLuxPlyAlignment(
  normalization: SceneObjectNormalization,
  plyBounds: ObjectBounds,
): ObjectLocalAlignment {
  const correction = normalization.ply_basis_correction ?? 'lux_ply_negative_y_up_to_scene_z_up'
  if (correction !== 'lux_ply_negative_y_up_to_scene_z_up') {
    throw new TypeError(`Unsupported PLY basis correction: ${correction}`)
  }
  const rotatedBounds = rotateObjectBounds(plyBounds, LUX_PLY_NEGATIVE_Y_UP_TO_SCENE_Z_UP.matrix)
  const targetBounds = sceneAlignedGlbBounds(normalization)
  const targetSize = targetBounds ? sizeOf(targetBounds) : null
  const sourceSize = sizeOf(rotatedBounds)
  return {
    correction,
    pivot: bottomCenterPivot(rotatedBounds),
    scale: targetSize
      ? targetSize.map((target, axis) => safeRatio(target, sourceSize[axis])) as Vec3
      : [1, 1, 1],
    rotationRadians: LUX_PLY_NEGATIVE_Y_UP_TO_SCENE_Z_UP.rotationRadians,
    matrix: LUX_PLY_NEGATIVE_Y_UP_TO_SCENE_Z_UP.matrix,
  }
}

export function applyObjectLocalAlignment(point: Vec3, alignment: ObjectLocalAlignment): Vec3 {
  const rotated = alignment.matrix.map(row => row[0] * point[0] + row[1] * point[1] + row[2] * point[2]) as Vec3
  return rotated.map((value, axis) => (value + alignment.pivot[axis]) * alignment.scale[axis]) as Vec3
}
