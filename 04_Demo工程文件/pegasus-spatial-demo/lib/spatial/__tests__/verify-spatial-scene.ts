import assert from 'node:assert/strict'
import { eulerDegreesToQuaternion, normalizeScale, normalizeTransform, normalizeViewpoint, quaternionToEulerDegrees } from '../scene-math'
import { inspectGlbMetadata } from '../glb-metadata'

assert.deepEqual(eulerDegreesToQuaternion([0, 0, 0]), [0, 0, 0, 1])
const quarterTurn = eulerDegreesToQuaternion([0, 0, 90])
assert.ok(Math.abs(quarterTurn[2] - Math.SQRT1_2) < 1e-10)
assert.ok(Math.abs(quarterTurn[3] - Math.SQRT1_2) < 1e-10)
const quarterTurnEuler = quaternionToEulerDegrees(quarterTurn)
assert.ok(Math.abs(quarterTurnEuler[0]) < 1e-10)
assert.ok(Math.abs(quarterTurnEuler[1]) < 1e-10)
assert.ok(Math.abs(quarterTurnEuler[2] - 90) < 1e-10)
assert.deepEqual(normalizeTransform({ position: [1, 2, 3], scale: [1, 2, 3] }).position, [1, 2, 3])
assert.throws(() => normalizeScale([1, 0, 1]), /大于 0/)
assert.throws(() => normalizeScale([1, Number.NaN, 1]), /有限数字/)
assert.throws(() => normalizeViewpoint({ position: [0, 0, 0], target: [0, 0, 0] }), /不能重合/)
assert.throws(() => normalizeViewpoint({ position: [0, 0, 0], target: [0, 0, 1], up: [0, 0, 2] }), /共线/)
assert.throws(() => normalizeViewpoint({ position: [0, 0, 0], target: [1, 0, 0], fov_deg: 101 }), /20–100/)

const json = Buffer.from(JSON.stringify({
  asset: { version: '2.0' },
  accessors: [
    { count: 6, min: [-1, 0, -2], max: [1, 4, 2] },
    { count: 6 },
  ],
  meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
  materials: [{}], textures: [{}], images: [{ bufferView: 0, mimeType: 'image/png' }],
}))
const padded = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 0x20)])
const glb = Buffer.alloc(20 + padded.length)
glb.write('glTF', 0, 'ascii'); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(glb.length, 8)
glb.writeUInt32LE(padded.length, 12); glb.write('JSON', 16, 'ascii'); padded.copy(glb, 20)
const metadata = inspectGlbMetadata(glb)
assert.equal(metadata.up_axis, 'Y')
assert.equal(metadata.meshes, 1)
assert.equal(metadata.triangles, 2)
assert.deepEqual(metadata.bounds?.size, [2, 4, 4])
assert.equal(metadata.has_external_resources, false)

console.log('spatial scene pure verification passed')
