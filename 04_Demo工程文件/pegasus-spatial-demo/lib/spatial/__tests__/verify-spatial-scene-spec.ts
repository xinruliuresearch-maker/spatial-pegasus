import assert from 'node:assert/strict'
import {
  compileSceneSpecNodes,
  parseSceneSpecV1,
  stableSceneInstanceId,
  summarizeSceneSpecChange,
} from '../scene-spec'
import type { SceneObjectInstance } from '../scene-types'

const artifact = {
  artifact_id: 'artifact_arch',
  job_id: 'job_arch',
  kind: 'glb',
  workspace_path: 'output/spatial/objects/arch/model.glb',
  mime_type: 'model/gltf-binary',
  size_bytes: 1024,
  sha256: 'a'.repeat(64),
  metadata: {},
}

async function run(): Promise<void> {
  const spec = parseSceneSpecV1(JSON.stringify({
    schema_version: 1,
    scene_id: 'scene_demo',
    expected_scene_version: 7,
    nodes: [{
      key: 'north-gate',
      label: '北门',
      group: 'architecture',
      role: 'object',
      object_job_id: 'job_arch',
      transform: { position: [0, 12, 2], rotation_deg: [0, 0, 180] },
      fit: { height: 30 },
    }],
  }))
  assert.equal(spec.nodes[0].key, 'north-gate')
  assert.equal(stableSceneInstanceId('scene_demo', 'north-gate'), stableSceneInstanceId('scene_demo', 'north-gate'))

  const compiled = await compileSceneSpecNodes({
    sceneId: spec.scene_id,
    nodes: spec.nodes,
    resolveObject: async jobId => ({
      source_job_id: jobId,
      glb_artifact: artifact,
      normalization: {
        source_up_axis: 'Y',
        scene_up_axis: 'Z',
        pivot: 'bottom_center',
        glb_basis_correction: 'gltf_y_up_to_scene_z_up',
        bounds: { min: [-1, -3, -2], max: [1, 3, 2], size: [2, 6, 4] },
      },
    }),
  })
  assert.equal(compiled.length, 1)
  assert.equal(compiled[0].key, 'north-gate')
  assert.equal(compiled[0].group, 'architecture')
  assert.deepEqual(compiled[0].transform.position, [0, 12, 2])
  // Y-up -> Z-up makes the source Y extent the Scene height: 6 * 5 = 30.
  assert.deepEqual(compiled[0].transform.scale, [5, 5, 5])

  const proxySpec = parseSceneSpecV1(JSON.stringify({
    schema_version: 1,
    scene_id: 'scene_demo',
    expected_scene_version: 8,
    nodes: [{
      key: 'greybox-gate',
      label: '灰盒门环',
      group: 'greybox',
      role: 'object',
      proxy: {
        kind: 'arch',
        dimensions: [36, 8, 48],
        color: '#CDA56A',
        material: 'stone',
        opacity: 0.9,
      },
      transform: { position: [0, 18, 6], rotation_deg: [0, 0, 0] },
    }],
  }))
  let resolverCalls = 0
  const compiledProxy = await compileSceneSpecNodes({
    sceneId: proxySpec.scene_id,
    nodes: proxySpec.nodes,
    resolveObject: async () => {
      resolverCalls += 1
      throw new Error('proxy must not resolve an Object Job')
    },
  })
  assert.equal(resolverCalls, 0)
  assert.equal(compiledProxy[0].source_job_id, 'proxy:scene_demo:greybox-gate')
  assert.equal(compiledProxy[0].proxy?.kind, 'arch')
  assert.deepEqual(compiledProxy[0].proxy?.dimensions, [36, 8, 48])
  assert.equal(compiledProxy[0].glb_artifact.metadata.virtual, true)

  assert.throws(() => parseSceneSpecV1(JSON.stringify({
    schema_version: 1,
    scene_id: 'scene_demo',
    expected_scene_version: 1,
    nodes: [
      { key: 'duplicate', object_job_id: 'one' },
      { key: 'duplicate', object_job_id: 'two' },
    ],
  })), /不能重复/)
  assert.throws(() => parseSceneSpecV1(JSON.stringify({
    schema_version: 1,
    scene_id: 'scene_demo',
    expected_scene_version: 1,
    nodes: [{
      key: 'bad-scale', object_job_id: 'one',
      transform: { scale: [1, 1, 1] }, fit: { width: 20 },
    }],
  })), /不能同时提供/)
  assert.throws(() => parseSceneSpecV1(JSON.stringify({
    schema_version: 1,
    scene_id: 'scene_demo',
    expected_scene_version: 1,
    nodes: [{
      key: 'ambiguous', object_job_id: 'one',
      proxy: { kind: 'box', dimensions: [1, 1, 1], color: '#FFFFFF', material: 'matte' },
    }],
  })), /只能提供 object_job_id 或 proxy/)
  assert.throws(() => parseSceneSpecV1(JSON.stringify({
    schema_version: 1,
    scene_id: 'scene_demo',
    expected_scene_version: 1,
    nodes: [{
      key: 'bad-proxy-fit',
      proxy: { kind: 'box', dimensions: [1, 1, 1], color: '#FFFFFF', material: 'matte' },
      fit: { width: 10 },
    }],
  })), /proxy 不支持 fit/)

  const legacy = { ...compiled[0], key: undefined } as SceneObjectInstance
  assert.equal(summarizeSceneSpecChange([legacy], compiled), '应用声明式 Scene：新增 1，更新 0，移除 1')
  console.log('spatial scene spec verification passed')
}

void run()
