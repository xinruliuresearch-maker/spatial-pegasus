import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  latestSpatialPreview,
  spatialPreviewRevision,
  type SpatialPreviewArtifact,
} from '../latest-spatial-preview'

function source(...segments: string[]): string {
  return readFileSync(join(process.cwd(), ...segments), 'utf8')
}

const artifacts = source('hooks', 'useWorkspaceArtifacts.ts')
const panel = source('components', 'workspace', 'WorkspacePanel.tsx')
const viewers = source('components', 'workspace', 'SpatialArtifactViewers.tsx')
const explorer = source('components', 'workspace', 'WorkspaceFileExplorer.tsx')
const card = source('components', 'chat', 'SpatialJobCard.tsx')
const messageBubble = source('components', 'chat', 'MessageBubble.tsx')
const sidebar = source('components', 'shell', 'AppSidebar.tsx')
const workbench = source('components', 'workspace', 'TaskWorkbench.tsx')
const shellPage = source('app', '(shell)', 'page.tsx')
const providers = source('components', 'providers', 'AppProviders.tsx')
const chatContext = source('contexts', 'ChatContext.tsx')
const sceneList = source('components', 'spatial-stage', 'SpatialSceneList.tsx')
const workspaceLayout = source('contexts', 'WorkspaceLayoutContext.tsx')
const flowingLight = source('components', 'effects', 'FlowingLightFrame.tsx')
const brandMark = source('components', 'shell', 'BrandMark.tsx')
const appBackground = source('components', 'shell', 'AppBackground.tsx')

assert.match(artifacts, /'image' \| 'model3d' \| 'world'/)
assert.match(artifacts, /entry\.storage === 'asset' && entry\.kind === 'raster'/)
assert.match(artifacts, /glb\|gltf/)
assert.match(artifacts, /output\\\/spatial\\\/worlds|output\/spatial\/worlds/)
assert.match(artifacts, /type === 'model3d' \|\| type === 'world'/, 'immutable World manifests must keep their semantic viewer type')
assert.match(artifacts, /gridfsPending: type === 'world'/, 'immutable World manifests must lazily load their JSON content')
assert.doesNotMatch(
  artifacts,
  /part\.tool[^\n]+(?:GenerateImage|CreateObject3D|CreateWorld3D)[\s\S]{0,240}artifacts\.set/,
  'durable job receipts must not shadow authoritative Workspace artifacts',
)

for (const component of ['SpatialImageViewer', 'SpatialModelViewer', 'SpatialWorldViewer']) {
  assert.match(panel, new RegExp(component))
  assert.match(viewers, new RegExp(`export function ${component}`))
}
assert.match(viewers, /camera-controls/)
assert.match(viewers, /下载 GLB/)
assert.match(viewers, /进入空间舞台/)
assert.match(viewers, /Aholo ↗/)
assert.match(viewers, /safeHttpUrl/)
assert.match(explorer, /label: '3D'/)

for (const tool of [
  'GenerateImage',
  'CreateObject3D',
  'CreateWorld3D',
  'GetSpatialJob',
  'WaitSpatialJob',
  'InspectSpatialArtifact',
]) {
  assert.match(card, new RegExp(`'${tool}'`))
}
assert.match(card, /\/spatial\/jobs\//)
assert.match(card, /ACTIVE\.has/)
assert.match(card, /next\.status === 'published'/)
assert.match(card, /refreshWorkspaceArtifacts/)
assert.match(card, /relationLabel/)
assert.match(card, /来源关系|Lineage/)
assert.match(messageBubble, /<SpatialJobCard/)
assert.match(messageBubble, /CreateWorld3D:\s*\{ pres: '创建中',\s*past: '已发起' \}/)
assert.match(messageBubble, /GenerateImage:\s*\{ pres: '生成中',\s*past: '已生成' \}/)
assert.doesNotMatch(messageBubble, /past: 'SUBMITTED'/)
assert.match(sidebar, /空间创作导航/)
assert.match(viewers, /个发布资产/)
assert.match(viewers, /来源关系/)
assert.match(viewers, /空间世界 · \{worldStatusLabel\(status\)\}/)
assert.match(viewers, /worldRelationLabel\(relation\.kind\)/)

assert.match(workbench, /Agent 会自己选择图像、Lux 造物、World 与场景编辑工具/)
assert.match(workbench, /你不需要先选择工作方式/)
assert.match(workbench, /pmo-spatial-composer/)
assert.match(workbench, /上传参考图片/)
assert.match(workbench, /ModelPickerModal/)
assert.match(workbench, /FlowingLightFrame/)
assert.match(flowingLight, /ResizeObserver/)
assert.match(flowingLight, /pmo-flowing-light__segment/)
assert.match(brandMark, /Marble-on-graphite Pegasus mark/)
assert.match(appBackground, /pmo-app-atmosphere__mass--clay/)
assert.doesNotMatch(workbench, /CREATION_CONTEXTS|pmo-spatial-context-switcher/)
assert.match(viewers, /inline=1/)
assert.match(viewers, /worldCoverPaths/)
assert.match(viewers, /fit="cover"/)
assert.match(viewers, /创作参考图封面/)
assert.doesNotMatch(viewers, /<iframe/)
assert.doesNotMatch(viewers, /embed=1/)
assert.doesNotMatch(viewers, /aspect-\[16\/10\]/)
assert.match(shellPage, /messages\.length === 0 && !isLoading && !showWorkspace/, 'projects with durable artifacts must open the workspace instead of the empty-project launcher')
assert.doesNotMatch(workbench, /物体模式|世界模式|固定流水线/)
assert.match(providers, /forcedTheme="light"/)
assert.match(providers, /enableSystem=\{false\}/)
assert.doesNotMatch(sidebar, /setTheme|跟随系统|深色模式/)
assert.match(sidebar, /label="场景"/)
assert.match(sidebar, /SpatialSceneList/)
assert.match(sidebar, /PanelResizeHandle/)
assert.match(panel, /<SpatialStage/)
assert.match(panel, /sceneId=\{activeSceneId\}/)
assert.match(sceneList, /在中央工作区直接观察和编辑当前 Scene/)
assert.match(chatContext, /ACTIVE_SCENE_KEY_PREFIX/)
assert.match(chatContext, /Boolean\(activeSceneId\)/)
assert.match(chatContext, /spatialPreviewRevision/)
assert.match(viewers, /artifact\.assetId/, 'binary viewer URLs are revisioned after same-path replacement')
assert.match(viewers, /createPortal/)
assert.match(viewers, /全屏展示图片/)
assert.match(viewers, /全屏展示3D模型/)
assert.match(viewers, /event\.key === 'Escape'/)
assert.match(workspaceLayout, /RIGHT_PANEL_STORAGE_KEY/)

const sameTimestamp = '2026-08-29T12:00:00.000Z'
const previews: SpatialPreviewArtifact[] = [
  { path: 'output/spatial/images/latest.png', type: 'image', updatedAt: sameTimestamp, assetId: 'asset_1' },
  { path: 'output/spatial/objects/demo/model.glb', type: 'model3d', updatedAt: sameTimestamp, sha256: 'model_1' },
  { path: 'output/spatial/worlds/demo/manifest.json', type: 'world', updatedAt: sameTimestamp, sha256: 'world_1' },
]
assert.equal(latestSpatialPreview(previews)?.type, 'world', 'a completed World wins over its same-batch cover image')
assert.notEqual(
  spatialPreviewRevision(previews[0]),
  spatialPreviewRevision({ ...previews[0], assetId: 'asset_2' }),
  'overwriting one image path produces a new preview revision',
)

console.log('spatial-product-ui:verify passed')
