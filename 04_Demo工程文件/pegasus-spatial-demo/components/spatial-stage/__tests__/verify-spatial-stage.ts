import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  chooseWorldRenderSource,
  parseWorldStageManifest,
  worldBinaryUrl,
  worldBuildLabel,
} from '../world-stage-model'
import { applyObjectLocalAlignment, computeGlbObjectAlignment, computeLuxPlyAlignment } from '../object-alignment'
import { readRenderPixelsWithRetry } from '../render-readback'

const root = process.cwd()
const source = (...segments: string[]) => readFileSync(join(root, ...segments), 'utf8')

const manifest = parseWorldStageManifest(JSON.stringify({
  schema_version: 1,
  title: '记忆温室',
  world_id: 'world_123',
  up_axis: 'z',
  assets: [
    {
      key: 'world-ply',
      kind: 'point_cloud',
      path: 'output/spatial/worlds/build_alpha/world.ply',
      size_bytes: 900,
      sha256: 'a'.repeat(64),
    },
    {
      key: 'world-spz',
      kind: 'point_cloud',
      path: 'output/spatial/worlds/build_alpha/world.spz',
      size_bytes: 500,
      sha256: 'b'.repeat(64),
    },
    { path: 'references/private.bin', kind: 'point_cloud' },
  ],
  relations: [{ kind: 'conditioned_by', artifact_id: 'spart_image' }],
}))

assert.ok(manifest)
assert.equal(manifest.up_axis, 'Z')
assert.equal(manifest.assets.length, 2, 'manifest parser must exclude paths outside the public world root')
assert.deepEqual(chooseWorldRenderSource(manifest), {
  path: 'output/spatial/worlds/build_alpha/world.spz',
  format: 'spz',
  sizeBytes: 500,
  sha256: 'b'.repeat(64),
}, 'the stage should prefer the compact mirrored SPZ over PLY')
assert.equal(worldBuildLabel('output/spatial/worlds/build_alpha/manifest.json'), 'build_alpha')
assert.equal(
  worldBinaryUrl('conv 1', 'output/spatial/worlds/build_alpha/world.spz', 'b'.repeat(64)),
  `/api/conversations/conv%201/files/binary?path=output%2Fspatial%2Fworlds%2Fbuild_alpha%2Fworld.spz&v=${'b'.repeat(64)}`,
)
assert.equal(parseWorldStageManifest('{broken'), null)

const plyAlignment = computeLuxPlyAlignment({
  basis_contract_version: 'lux3d_g1_paired_v1',
  source_up_axis: 'Y',
  scene_up_axis: 'Z',
  pivot: 'bottom_center',
  glb_basis_correction: 'gltf_y_up_to_scene_z_up',
  ply_source_up_axis: '-Y',
  ply_basis_correction: 'lux_ply_negative_y_up_to_scene_z_up',
  bounds: { min: [-0.4, -0.5, -0.3], max: [0.4, 0.5, 0.3], size: [0.8, 1, 0.6] },
}, { min: [-2, -3, -4], max: [2, 3, 4] })
assert.deepEqual(plyAlignment.pivot, [0, 0, 3])
assert.ok(plyAlignment.scale.every((value, axis) => Math.abs(value - [0.2, 0.075, 1 / 6][axis]) < 1e-12))
assert.deepEqual(plyAlignment.rotationRadians, [-Math.PI / 2, 0, 0])
const alignedPlyCorners = ([-2, 2] as const).flatMap(x => ([-3, 3] as const).flatMap(y => ([-4, 4] as const)
  .map(z => applyObjectLocalAlignment([x, y, z], plyAlignment))))
const alignedMinimum = [0, 1, 2].map(axis => Math.min(...alignedPlyCorners.map(point => point[axis])))
const alignedMaximum = [0, 1, 2].map(axis => Math.max(...alignedPlyCorners.map(point => point[axis])))
assert.deepEqual(alignedMinimum, [-0.4, -0.3, 0])
assert.deepEqual(alignedMaximum, [0.4, 0.3, 1])
const glbAlignment = computeGlbObjectAlignment({
  source_up_axis: 'Y', scene_up_axis: 'Z', pivot: 'bottom_center',
  glb_basis_correction: 'gltf_y_up_to_scene_z_up',
  bounds: { min: [-0.4, -0.5, -0.3], max: [0.4, 0.5, 0.3], size: [0.8, 1, 0.6] },
})
assert.deepEqual(glbAlignment.rotationRadians, [Math.PI / 2, 0, 0])

let asynchronousReads = 0
let synchronousReads = 0
const waitDurations: number[] = []
await readRenderPixelsWithRetry({
  render() {},
  async waitForRenderOver(duration) { waitDurations.push(duration) },
  async readRenderResultAsync() {
    asynchronousReads += 1
    throw new Error('GL client sync failed')
  },
  readRenderResult() { synchronousReads += 1 },
}, new Uint8Array(4), { x: 0, y: 0, width: 1, height: 1 })
assert.equal(asynchronousReads, 3)
assert.equal(synchronousReads, 1)
assert.deepEqual(waitDurations, [48, 80, 112, 96])

const canvas = source('components', 'spatial-stage', 'AholoWorldCanvas.tsx')
assert.match(canvas, /import\('@manycore\/aholo-viewer'\)/)
assert.match(canvas, /sdk\.createViewer\(/)
assert.match(canvas, /SplatLoader\.parseSplatData/)
assert.match(canvas, /SplatUtils\.createSplat/)
assert.match(canvas, /container\.addEventListener/)
assert.match(canvas, /viewer\.destroy\(\)/)
assert.match(canvas, /controller\.abort\(\)/)
assert.match(canvas, /GLTFLoader\.loadGLTF/)
assert.match(canvas, /readRenderPixelsWithRetry/)
assert.match(canvas, /ensureMissingMeshNormals/)
assert.match(canvas, /addOrSetAttribute\('normal'/)
assert.match(canvas, /outputContext\.drawImage\(source/)
assert.doesNotMatch(canvas, /runtime\.viewer\.resize\(\{ width, height \}\)/, 'capture must never resize the visible Stage framebuffer')
assert.match(canvas, /isExtraCopyBeforeScreenEnabled\.set\(true\)/)
assert.match(canvas, /空间舞台尚未产生有效截图帧/)
assert.match(canvas, /createPicker\(\)/)
assert.match(canvas, /EnvMapBackground/)
assert.match(canvas, /downloadTexture\(environmentUrl/)
assert.match(canvas, /querySurface/)
assert.match(canvas, /picker\.raycaster\.set\(origin, down\)/)
assert.match(canvas, /qualityMode/)
assert.match(canvas, /qualityAssetKey/)
assert.match(canvas, /QUALITY_ALIGNMENT_VERSION/)
assert.match(canvas, /qualityCacheRef/)
assert.match(canvas, /qualityCandidates/)
assert.match(canvas, /setHighlightObjects/)
assert.match(canvas, /agent-observer\.gltf/)
assert.match(canvas, /status: 'loading'/)
assert.match(canvas, /containsCaptureOrigin/)
assert.match(canvas, /orbit\.target = axis === 'Z' \? \[0, -1, 0\] : \[0, 0, -1\]/)
assert.match(canvas, /3DGS 解码超时/)
assert.match(canvas, /Lux 可编辑物体仍可继续使用/)
assert.match(canvas, /fitEditableObjects/)
assert.doesNotMatch(canvas, /!container \|\| !assetUrl \|\| !format/)
assert.match(canvas, /resetUserView/)
assert.match(canvas, /WASD 水平移动/)
assert.match(canvas, /movementKeys = new Set\(\['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE'\]\)/)
assert.match(canvas, /requestAnimationFrame\(navigate\)/)
assert.match(canvas, /pressedKeys\.has\('KeyE'\)/)
assert.match(canvas, /pressedKeys\.has\('KeyQ'\)/)
assert.match(canvas, /orbit\.mode = event\.shiftKey/)
assert.match(canvas, /if \(orbit\.moved\)/)

const readback = source('components', 'spatial-stage', 'render-readback.ts')
assert.match(readback, /WebGL clientWaitSync/)
assert.match(readback, /readRenderResultAsync/)
assert.match(readback, /waitForRenderOver\(48 \+ attempt \* 32\)/)
assert.match(readback, /viewer\.readRenderResult\(pixels, range\)/)

const viewerPatch = source('scripts', 'patch-aholo-viewer-workers.mjs')
assert.match(viewerPatch, /EXPECTED_DIRECT_WORKER_COUNT = 3/)
assert.match(viewerPatch, /new Worker\(workerUrl, \{ type: "module" \}\)/)
assert.match(viewerPatch, /Math\.max\(1, \(navigator\.hardwareConcurrency \|\| 2\) - 1\)/)

const sceneRepository = source('lib', 'spatial', 'scene-repository.ts')
assert.match(sceneRepository, /ply && job\.provider !== 'lux3d'/)
assert.match(sceneRepository, /没有已知的本地坐标基契约，拒绝猜测姿态/)
assert.match(sceneRepository, /glb_basis_correction: 'gltf_y_up_to_scene_z_up'/)
assert.match(sceneRepository, /ply_basis_correction: 'lux_ply_negative_y_up_to_scene_z_up'/)

const stage = source('components', 'spatial-stage', 'SpatialStage.tsx')
assert.match(stage, /AholoWorldCanvas/)
assert.match(stage, /AUTO REVISION/)
assert.match(stage, /从这里提出修改/)
assert.match(stage, /不声称可以局部语义修改 3DGS/)
assert.match(stage, /把你看到的问题交给 Agent/)
assert.match(stage, /重置视角/)
assert.match(stage, /用户视角/)
assert.match(stage, /Agent 视角/)
assert.match(stage, /高质量 PLY/)
assert.match(stage, /GLB 实时模式/)
assert.match(stage, /场景资产库/)
assert.match(stage, /主 Agent 观察机位/)
assert.match(stage, /贴合地形/)
assert.match(stage, /ArrowLeft: \[0, -step\]/)
assert.match(stage, /PageUp: \[2, step\]/)
assert.match(stage, /rotation_deg/)
assert.match(stage, /expected_version/)
assert.match(stage, /RENDER_COMMAND_IDLE_POLL_MS = 2_500/)
assert.match(stage, /RENDER_COMMAND_ACTIVE_POLL_MS = 250/)
assert.match(stage, /RENDER_SESSION_HEARTBEAT_MS = 15_000/)
assert.match(stage, /const clientId = crypto\.randomUUID\(\)/)
assert.match(stage, /await register\(\)\.catch/)
assert.match(stage, /method: 'DELETE'/)
assert.doesNotMatch(stage, /sessionStorage/, 'copied Stage tabs must not share one render lease identity')
assert.match(stage, /const manifestPreviewPath = initialManifestPath \|\| null/)
assert.match(stage, /sceneId\?: string \| null/)
assert.match(stage, /全屏编辑/)
assert.match(stage, /sceneId && list\.scenes\.some/)

const sceneRoute = source('app', 'api', 'conversations', '[id]', 'spatial', 'scenes', '[sceneId]', 'route.ts')
assert.match(sceneRoute, /export async function PATCH/)
assert.match(sceneRoute, /mutateSpatialScene/)
assert.match(sceneRoute, /用户调整“\$\{target\.label\}”的位置与姿态/)
assert.match(sceneRoute, /expectedVersion: Number\(body\.expected_version\)/)
assert.match(sceneRoute, /status: 409/)
assert.match(stage, /const effectiveLegacyPath = manifestPreviewPath \?\? legacyPath/)
assert.match(stage, /isManifestPreview \? null : manifests\[0\] \?\? null/)
assert.match(stage, /const displayedSceneData = isManifestPreview \? null : sceneData/)
assert.match(stage, /if \(!selectedSceneId \|\| isManifestPreview\) return/)
assert.match(stage, /World 预览仅供查看/)

const renderCompletionRoute = source(
  'app', 'api', 'conversations', '[id]', 'spatial', 'scenes', '[sceneId]',
  'render-command', '[commandId]', 'complete', 'route.ts',
)
const observationRoute = source(
  'app', 'api', 'conversations', '[id]', 'spatial', 'scenes', '[sceneId]',
  'observations', 'route.ts',
)
assert.match(renderCompletionRoute, /getOwnedImageAsset\(body\.asset_id, userId, id\)/)
assert.match(renderCompletionRoute, /completeSpatialSurfaceQueryCommand/)
assert.match(observationRoute, /getOwnedImageAsset\(body\.asset_id, userId, id\)/)

const route = source('app', '(stage)', 'spatial', '[id]', 'page.tsx')
assert.match(route, /loadRef\.current\(id\)/)
assert.match(route, /<SpatialStage/)
assert.match(route, /useSearchParams\(\)/)
assert.match(route, /safeManifestPath\(searchParams\.get\('manifest'\)\)/)
assert.match(route, /safeSceneId\(searchParams\.get\('scene'\)\)/)
assert.match(route, /normalizeWorkspacePath\(value\)/)
assert.match(route, /!isInternalWorkspacePath\(normalized\)/)

const stageLayout = source('app', '(stage)', 'layout.tsx')
assert.doesNotMatch(stageLayout, /TopNavBar/, 'the immersive stage must not render the application navigation above its own controls')
assert.doesNotMatch(stageLayout, /pt-16/, 'the stage canvas must own the complete viewport')

const workspaceViewer = source('components', 'workspace', 'SpatialArtifactViewers.tsx')
assert.match(workspaceViewer, /进入空间舞台/)
assert.match(workspaceViewer, /\/spatial\/\$\{encodeURIComponent\(conversationId\)\}/)
assert.match(workspaceViewer, /target="_blank"/)
assert.doesNotMatch(workspaceViewer, /\?manifest=\$\{encodeURIComponent\(artifact\.path\)\}/, 'the primary Stage action must open an active Scene, not a viewer-only manifest')
assert.doesNotMatch(workspaceViewer, /<iframe/, 'Workspace world covers must never embed a second application')

console.log('spatial-stage verification passed')
