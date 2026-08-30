'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ImageAttachment } from '@/lib/types'
import type { ScenePanoramaEnvironment, SceneViewpoint } from '@/lib/spatial/scene-types'
import { eulerDegreesToQuaternion, quaternionToEulerDegrees } from '@/lib/spatial/scene-math'
import type { WorkspaceArtifact } from '@/hooks/useWorkspaceArtifacts'
import { useChatContext } from '@/contexts/ChatContext'
import { useGridFSContent } from '@/hooks/useGridFSContent'
import { AholoWorldCanvas, type SpatialCanvasHandle, type SpatialQualityRenderState, type StageCameraPose } from './AholoWorldCanvas'
import { normalizeSpatialProxy, type SpatialStageInstance } from './proxy-geometry'
import { chooseWorldRenderSource, listWorldManifests, parseWorldStageManifest, worldBinaryUrl } from './world-stage-model'
import styles from './SpatialStage.module.css'

interface SceneSummary { scene_id: string; title: string; current_version: number; current_revision_id: string; agent_viewpoint: SceneViewpoint | null }
interface SceneRevision { revision_id: string; version: number; change_summary: string; environment: ScenePanoramaEnvironment | null; world: { up_axis: 'Y' | 'Z'; artifacts: Array<{ workspace_path: string; sha256: string }> } | null; instances: SpatialStageInstance[] }
interface SceneResponse { scene: SceneSummary; revision: SceneRevision; history?: Array<{ revision_id: string; version: number; change_summary: string }> }
interface RenderSession { session_id: string; lease_token: string }
interface RenderCommand {
  command_id: string
  observation_id: string
  viewpoint: SceneViewpoint
  lease: { token: string }
  kind?: 'capture' | 'surface_query'
  surface_query?: { terrain_instance_id: string; horizontal: [number, number]; cast_height: number; up_axis: 'Y' | 'Z' } | null
}

interface EditableTransform {
  position: [number, number, number]
  rotation_deg: [number, number, number]
  scale: [number, number, number]
}

const RENDER_COMMAND_IDLE_POLL_MS = 2_500
const RENDER_COMMAND_ACTIVE_POLL_MS = 250
const RENDER_SESSION_HEARTBEAT_MS = 15_000

function shortId(value: string | null | undefined): string {
  if (!value) return '—'
  return value.length > 18 ? `${value.slice(0, 9)}…${value.slice(-6)}` : value
}

function vectorText(value: readonly number[] | null | undefined): string {
  return value?.map(item => Number(item).toFixed(2)).join(' · ') ?? '— · — · —'
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } })
  if (!response.ok) throw new Error((await response.json().catch(() => null) as { error?: string } | null)?.error ?? `HTTP ${response.status}`)
  return response.json() as Promise<T>
}

async function uploadPng(conversationId: string, blob: Blob): Promise<{ assetId: string; mimeType: string }> {
  const form = new FormData(); form.set('file', new File([blob], 'view.png', { type: 'image/png' })); form.set('conversationId', conversationId)
  const response = await fetch('/api/media/upload', { method: 'POST', body: form })
  if (!response.ok) throw new Error('观察截图上传失败。')
  const body = await response.json() as { image: { assetId: string; mimeType: string } }
  return body.image
}

export function SpatialStage({ conversationId, projectTitle, artifacts, isProjectLoading, initialManifestPath = null, sceneId = null, embedded = false }: {
  conversationId: string; projectTitle: string | null; artifacts: WorkspaceArtifact[]; isProjectLoading: boolean; initialManifestPath?: string | null; sceneId?: string | null; embedded?: boolean
}) {
  const { sendMessage } = useChatContext()
  const canvasRef = useRef<SpatialCanvasHandle>(null)
  const manifests = useMemo(() => listWorldManifests(artifacts), [artifacts])
  const [scenes, setScenes] = useState<SceneSummary[]>([])
  const [selectedSceneId, setSelectedSceneId] = useState<string | null>(null)
  const [sceneData, setSceneData] = useState<SceneResponse | null>(null)
  const [previewVersion, setPreviewVersion] = useState<number | null>(null)
  const [legacyPath, setLegacyPath] = useState<string>('')
  const [cameraPose, setCameraPose] = useState<StageCameraPose | null>(null)
  const [cameraMode, setCameraMode] = useState<'user' | 'agent'>('user')
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null)
  const [qualityMode, setQualityMode] = useState<'glb' | 'ply'>('glb')
  const [qualityReloadToken, setQualityReloadToken] = useState(0)
  const [qualityRenderState, setQualityRenderState] = useState<SpatialQualityRenderState>({ status: 'glb', instanceId: null, loadedCount: 0, totalCount: 0 })
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [activeDrawer, setActiveDrawer] = useState<'library' | 'inspector' | null>(null)
  const [libraryTab, setLibraryTab] = useState<'assets' | 'scenes' | 'history'>('assets')
  const [editTransform, setEditTransform] = useState<EditableTransform | null>(null)
  const [editDirty, setEditDirty] = useState(false)
  const [editStatus, setEditStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [moveStep, setMoveStep] = useState(1)
  const manifestPreviewPath = initialManifestPath || null
  const isManifestPreview = manifestPreviewPath !== null

  const refreshScenes = useCallback(async () => {
    const list = await json<{ scenes: SceneSummary[] }>(`/api/conversations/${encodeURIComponent(conversationId)}/spatial/scenes`)
    setScenes(list.scenes)
    setSelectedSceneId(current => {
      if (sceneId && list.scenes.some(scene => scene.scene_id === sceneId)) return sceneId
      return current && list.scenes.some(scene => scene.scene_id === current) ? current : list.scenes[0]?.scene_id ?? null
    })
  }, [conversationId, sceneId])
  const refreshScene = useCallback(async () => {
    if (!selectedSceneId) { setSceneData(null); return }
    const query = new URLSearchParams({ history: '1' }); if (previewVersion) query.set('version', String(previewVersion))
    setSceneData(await json<SceneResponse>(`/api/conversations/${encodeURIComponent(conversationId)}/spatial/scenes/${encodeURIComponent(selectedSceneId)}?${query}`))
  }, [conversationId, previewVersion, selectedSceneId])
  useEffect(() => { void refreshScenes().catch(() => undefined); const timer = setInterval(() => void refreshScenes().catch(() => undefined), 2500); return () => clearInterval(timer) }, [refreshScenes])
  useEffect(() => { if (sceneId) setSelectedSceneId(sceneId) }, [sceneId])
  useEffect(() => { void refreshScene().catch(errorValue => setError(String(errorValue))); const timer = setInterval(() => void refreshScene().catch(() => undefined), 1800); return () => clearInterval(timer) }, [refreshScene])
  useEffect(() => {
    if (manifestPreviewPath) return
    setLegacyPath(current => current && manifests.some(item => item.path === current) ? current : manifests[0]?.path ?? '')
  }, [manifestPreviewPath, manifests])
  useEffect(() => { setPreviewVersion(null) }, [selectedSceneId])
  useEffect(() => {
    if (!activeDrawer) return
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setActiveDrawer(null) }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [activeDrawer])

  // An explicit Workspace manifest link is a World preview, not a request to open the
  // project's current Scene. Keep the query path authoritative (including query changes)
  // and never silently substitute another manifest when that exact artifact is unavailable.
  const effectiveLegacyPath = manifestPreviewPath ?? legacyPath
  const legacyArtifact = manifests.find(item => item.path === effectiveLegacyPath)
    ?? (isManifestPreview ? null : manifests[0] ?? null)
  const legacyFile = useGridFSContent(conversationId, legacyArtifact?.path ?? '', Boolean(legacyArtifact?.gridfsPending))
  const legacyManifest = useMemo(() => parseWorldStageManifest(legacyArtifact?.content || legacyFile.content), [legacyArtifact?.content, legacyFile.content])
  const legacyRender = chooseWorldRenderSource(legacyManifest)
  const displayedSceneData = isManifestPreview ? null : sceneData
  const worldAsset = displayedSceneData?.revision.world?.artifacts.find(asset => asset.workspace_path.endsWith('.spz'))
    ?? displayedSceneData?.revision.world?.artifacts.find(asset => asset.workspace_path.endsWith('.ply'))
  const renderFormat = worldAsset?.workspace_path.endsWith('.spz') ? 'spz' : worldAsset ? 'ply' : legacyRender?.format ?? null
  const assetUrl = worldAsset
    ? worldBinaryUrl(conversationId, worldAsset.workspace_path, worldAsset.sha256)
    : legacyRender ? worldBinaryUrl(conversationId, legacyRender.path, legacyRender.sha256) : null
  const environment = displayedSceneData?.revision.environment ?? null
  const environmentUrl = environment
    ? worldBinaryUrl(conversationId, environment.workspace_path, environment.sha256)
    : null
  const upAxis = displayedSceneData?.revision.world?.up_axis ?? legacyManifest?.up_axis
  const objectUrl = useCallback((instance: SpatialStageInstance, quality: 'glb' | 'ply') => {
    const artifact = quality === 'ply' ? instance.optional_ply_artifact : instance.glb_artifact
    return artifact ? worldBinaryUrl(conversationId, artifact.workspace_path, artifact.sha256) : null
  }, [conversationId])
  const sourceSelectedInstance = displayedSceneData?.revision.instances.find(instance => instance.instance_id === selectedInstanceId) ?? null
  const selectedInstance = sourceSelectedInstance && editTransform
    ? { ...sourceSelectedInstance, transform: { position: editTransform.position, rotation_quaternion: eulerDegreesToQuaternion(editTransform.rotation_deg), scale: editTransform.scale } }
    : sourceSelectedInstance
  const effectiveInstances = useMemo(() => displayedSceneData?.revision.instances.map(instance => instance.instance_id === selectedInstanceId && editTransform
    ? { ...instance, transform: { ...instance.transform, position: editTransform.position, rotation_quaternion: eulerDegreesToQuaternion(editTransform.rotation_deg), scale: editTransform.scale } }
    : instance) ?? [], [displayedSceneData?.revision.instances, editTransform, selectedInstanceId])
  const agentMarkers = useMemo(() => displayedSceneData?.scene.agent_viewpoint
    ? [{ id: 'root-agent', label: '主 Agent', color: '#91dfc2', viewpoint: displayedSceneData.scene.agent_viewpoint }]
    : [], [displayedSceneData?.scene.agent_viewpoint])
  useEffect(() => {
    if (selectedInstanceId && displayedSceneData && !displayedSceneData.revision.instances.some(instance => instance.instance_id === selectedInstanceId)) {
      setSelectedInstanceId(null)
    }
  }, [displayedSceneData, selectedInstanceId])

  useEffect(() => {
    if (!sourceSelectedInstance) { setEditTransform(null); setEditDirty(false); setEditStatus('idle'); return }
    if (editDirty || editStatus === 'saving') return
    setEditTransform({
      position: [...sourceSelectedInstance.transform.position],
      rotation_deg: quaternionToEulerDegrees(sourceSelectedInstance.transform.rotation_quaternion),
      scale: [...sourceSelectedInstance.transform.scale],
    })
  }, [editDirty, editStatus, sourceSelectedInstance])

  const updateEditTransform = useCallback((mutate: (current: EditableTransform) => EditableTransform) => {
    setEditTransform(current => current ? mutate(current) : current)
    setEditDirty(true)
    setEditStatus('idle')
  }, [])

  const nudgeSelected = useCallback((axis: 0 | 1 | 2, amount: number) => {
    updateEditTransform(current => ({ ...current, position: current.position.map((value, index) => index === axis ? value + amount : value) as [number, number, number] }))
  }, [updateEditTransform])

  const handleCanvasSelect = useCallback((instanceId: string | null) => {
    setSelectedInstanceId(instanceId)
    if (instanceId) setActiveDrawer('inspector')
  }, [])

  useEffect(() => {
    if (!selectedInstanceId || !editTransform || previewVersion || cameraMode !== 'user') return
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, button')) return
      const multiplier = event.shiftKey ? 5 : event.altKey ? 0.1 : 1
      const step = moveStep * multiplier
      const mapping: Partial<Record<string, [0 | 1 | 2, number]>> = {
        ArrowLeft: [0, -step], ArrowRight: [0, step], ArrowDown: [1, -step], ArrowUp: [1, step], PageDown: [2, -step], PageUp: [2, step],
      }
      const movement = mapping[event.key]
      if (!movement) return
      event.preventDefault()
      nudgeSelected(...movement)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [cameraMode, editTransform, moveStep, nudgeSelected, previewVersion, selectedInstanceId])

  useEffect(() => {
    if (!editDirty || !editTransform || !sourceSelectedInstance || !displayedSceneData || previewVersion) return
    const timer = setTimeout(() => {
      const endpoint = `/api/conversations/${encodeURIComponent(conversationId)}/spatial/scenes/${encodeURIComponent(displayedSceneData.scene.scene_id)}`
      setEditStatus('saving')
      void json<{ scene: SceneSummary; revision: SceneRevision }>(endpoint, {
        method: 'PATCH',
        body: JSON.stringify({
          edit_id: crypto.randomUUID(),
          expected_version: displayedSceneData.scene.current_version,
          instance_id: sourceSelectedInstance.instance_id,
          ...editTransform,
        }),
      }).then(result => {
        setSceneData(current => current ? { ...current, scene: result.scene, revision: result.revision } : current)
        setEditDirty(false)
        setEditStatus('saved')
        void refreshScenes()
      }).catch(cause => {
        setEditStatus('error')
        setEditDirty(false)
        setError(cause instanceof Error && cause.message === 'scene_changed' ? '场景已被其他操作更新，请重新选择物体后再调整。' : cause instanceof Error ? cause.message : '物体变换保存失败。')
        void refreshScene()
      })
    }, 520)
    return () => clearTimeout(timer)
  }, [conversationId, displayedSceneData, editDirty, editTransform, previewVersion, refreshScene, refreshScenes, sourceSelectedInstance])

  const groundSelected = async () => {
    if (!editTransform || !sourceSelectedInstance || !canvasRef.current) return
    const terrain = displayedSceneData?.revision.instances.find(instance => instance.role === 'terrain' && instance.instance_id !== sourceSelectedInstance.instance_id)
    if (!terrain) { setError('当前 Scene 没有可用于贴合的 Lux 地形。'); return }
    setEditStatus('saving'); setError(null)
    try {
      const point = await canvasRef.current.querySurface(terrain.instance_id, [editTransform.position[0], editTransform.position[1]], Math.max(editTransform.position[2] + 1000, 1000), 'Z')
      updateEditTransform(current => ({ ...current, position: [current.position[0], current.position[1], point[2] + 0.02] }))
    } catch (cause) {
      setEditStatus('error')
      setError(cause instanceof Error ? cause.message : '无法查询当前位置的地形高度。')
    }
  }

  const selectedAssetLabel = selectedInstance && normalizeSpatialProxy(selectedInstance)
    ? '灰盒代理体'
    : qualityMode === 'ply' && selectedInstance?.optional_ply_artifact
      ? 'PLY 高质量替身'
      : 'GLB 可编辑真值'
  const plyCapableCount = displayedSceneData?.revision.instances.filter(instance => !normalizeSpatialProxy(instance) && instance.optional_ply_artifact).length ?? 0
  const toggleQualityMode = () => {
    if (qualityMode === 'ply' && qualityRenderState.status === 'error') setQualityReloadToken(current => current + 1)
    setQualityMode(current => current === 'glb' ? 'ply' : 'glb')
  }

  useEffect(() => {
    if (!selectedSceneId || isManifestPreview) return
    let cancelled = false; let session: RenderSession | null = null; let registration: Promise<void> | null = null; let pollTimer: ReturnType<typeof setTimeout> | null = null; let heartbeat: ReturnType<typeof setInterval> | null = null
    // A mounted Stage is one render client. Persisted browser IDs can be shared
    // by copied tabs, which lets one tab invalidate the other's lease forever.
    const clientId = crypto.randomUUID()
    const endpoint = `/api/conversations/${encodeURIComponent(conversationId)}/spatial/scenes/${encodeURIComponent(selectedSceneId)}`
    const register = () => {
      if (cancelled) return Promise.resolve()
      if (registration) return registration
      registration = json<{ session: RenderSession }>(endpoint + '/render-session', { method: 'POST', body: JSON.stringify({ client_id: clientId }) })
        .then(body => { if (!cancelled) session = body.session })
        .finally(() => { registration = null })
      return registration
    }
    const invalidate = (candidate: RenderSession) => {
      if (session?.session_id === candidate.session_id && session.lease_token === candidate.lease_token) session = null
    }
    const keepAlive = async () => {
      if (cancelled) return
      if (!session) { await register().catch(() => undefined); return }
      const active = session
      try {
        await json(endpoint + '/render-session', { method: 'PATCH', body: JSON.stringify({ session_id: active.session_id, lease_token: active.lease_token }) })
      } catch {
        invalidate(active)
        await register().catch(() => undefined)
      }
    }
    const poll = async () => {
      if (cancelled) return
      let nextPollMs = RENDER_COMMAND_IDLE_POLL_MS
      try {
        if (!session) await register()
        const active = session
        const canvas = canvasRef.current
        if (active && canvas?.isReady()) {
          let body: { command: RenderCommand | null }
          try {
            body = await json<{ command: RenderCommand | null }>(endpoint + '/render-command', { method: 'POST', body: JSON.stringify({ session_id: active.session_id, lease_token: active.lease_token }) })
          } catch (cause) {
            invalidate(active)
            throw cause
          }
          if (!body.command) {
            if (!cancelled) pollTimer = setTimeout(poll, nextPollMs)
            return
          }
          if (body.command.kind === 'surface_query' && body.command.surface_query) {
            const query = body.command.surface_query
            try {
              const point = await canvas.querySurface(query.terrain_instance_id, query.horizontal, query.cast_height, query.up_axis)
              await json(endpoint + '/render-command/' + encodeURIComponent(body.command.command_id) + '/complete', { method: 'POST', body: JSON.stringify({ session_id: active.session_id, command_lease_token: body.command.lease.token, terrain_instance_id: query.terrain_instance_id, point }) })
            } catch (cause) {
              const message = cause instanceof Error ? cause.message : 'Lux 地形表面查询失败。'
              await json(endpoint + '/render-command/' + encodeURIComponent(body.command.command_id) + '/complete', { method: 'POST', body: JSON.stringify({ session_id: active.session_id, command_lease_token: body.command.lease.token, error: message }) })
            }
          } else {
            try {
              const blob = await canvas.capture(body.command.viewpoint); const image = await uploadPng(conversationId, blob)
              await json(endpoint + '/render-command/' + encodeURIComponent(body.command.command_id) + '/complete', { method: 'POST', body: JSON.stringify({ session_id: active.session_id, command_lease_token: body.command.lease.token, asset_id: image.assetId, observation_id: body.command.observation_id, visible_instance_ids: canvas.visibleInstanceIds() }) })
            } catch (cause) {
              const message = cause instanceof Error ? cause.message : '空间舞台截图失败。'
              await json(endpoint + '/render-command/' + encodeURIComponent(body.command.command_id) + '/complete', { method: 'POST', body: JSON.stringify({ session_id: active.session_id, command_lease_token: body.command.lease.token, error: message }) })
            }
          }
          nextPollMs = RENDER_COMMAND_ACTIVE_POLL_MS
        }
      } catch { /* session refresh and command lease recovery are durable */ }
      if (!cancelled) pollTimer = setTimeout(poll, nextPollMs)
    }
    heartbeat = setInterval(() => void keepAlive(), RENDER_SESSION_HEARTBEAT_MS)
    void register().catch(() => undefined).finally(() => void poll())
    return () => {
      cancelled = true
      if (pollTimer) clearTimeout(pollTimer)
      if (heartbeat) clearInterval(heartbeat)
      const closing = session
      if (closing) void fetch(endpoint + '/render-session', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: closing.session_id, lease_token: closing.lease_token }),
        keepalive: true,
      }).catch(() => undefined)
    }
  }, [conversationId, isManifestPreview, selectedSceneId])

  const submitObservation = async () => {
    if (!displayedSceneData || !canvasRef.current || !comment.trim()) return
    setBusy('正在冻结观察点'); setError(null)
    try {
      const viewpoint = canvasRef.current.currentViewpoint(); if (!viewpoint) throw new Error('相机尚未就绪。')
      const image = await uploadPng(conversationId, await canvasRef.current.capture())
      const response = await json<{ observation: { observation_id: string; revision_id: string; screenshot_workspace_path: string }; image: { assetId: string; mimeType: string } }>(`/api/conversations/${encodeURIComponent(conversationId)}/spatial/scenes/${encodeURIComponent(displayedSceneData.scene.scene_id)}/observations`, {
        method: 'POST', body: JSON.stringify({ asset_id: image.assetId, comment: comment.trim(), viewpoint, selected_instance_id: selectedInstanceId, visible_instance_ids: canvasRef.current.visibleInstanceIds() }),
      })
      const structured = `<spatial-observation observation_id="${response.observation.observation_id}" scene_id="${displayedSceneData.scene.scene_id}" scene_version="${displayedSceneData.revision.version}" selected_instance_id="${selectedInstanceId ?? ''}">\n${comment.trim()}\n相机：${JSON.stringify(viewpoint)}\n截图：${response.observation.screenshot_workspace_path}\n</spatial-observation>`
      const attachment: ImageAttachment = { assetId: response.image.assetId, mimeType: response.image.mimeType }
      sendMessage(structured, [attachment]); setComment(''); setBusy(null)
    } catch (cause) { setError(cause instanceof Error ? cause.message : '观察提交失败。'); setBusy(null) }
  }

  return <main className={`${styles.stageShell} ${embedded ? styles.stageEmbedded : ''}`}>
    <section className={styles.viewportColumn} aria-label="空间舞台画布">
      <AholoWorldCanvas
        ref={canvasRef}
        assetUrl={assetUrl}
        format={renderFormat}
        environmentUrl={environmentUrl}
        environmentYawDeg={environment?.yaw_deg}
        environmentExposure={environment?.exposure}
        upAxis={upAxis}
        instances={effectiveInstances}
        objectUrl={objectUrl}
        agentViewpoint={displayedSceneData?.scene.agent_viewpoint}
        agentMarkers={agentMarkers}
        cameraMode={cameraMode}
        qualityMode={qualityMode}
        qualityReloadToken={qualityReloadToken}
        selectedInstanceId={selectedInstanceId}
        onQualityStateChange={setQualityRenderState}
        onSelectInstance={handleCanvasSelect}
        onCameraChange={setCameraPose}
      />

      {embedded ? <div className={styles.embeddedStageBar}>
        <div><span className={styles.liveMark} /><p><strong>{displayedSceneData?.scene.title ?? projectTitle ?? '空间 Scene'}</strong><small>v{displayedSceneData?.revision.version ?? '—'} · {displayedSceneData?.revision.instances.length ?? 0} 个物体</small></p></div>
        <Link className={styles.embeddedFullscreenButton} href={`/spatial/${encodeURIComponent(conversationId)}?scene=${encodeURIComponent(selectedSceneId ?? '')}`}>全屏编辑 <span>↗</span></Link>
      </div> : <header className={styles.stageHeader}>
        <div className={styles.stageIdentity}>
          <Link href="/" className={styles.backButton} aria-label="返回对话">←</Link>
          <span className={styles.liveMark} />
          <div>
            <p>空间舞台</p>
            <h1>{displayedSceneData?.scene.title ?? legacyManifest?.title ?? projectTitle ?? '未命名空间'}</h1>
          </div>
          <span className={previewVersion && !isManifestPreview ? styles.historyPill : styles.statusPill}>
            {isManifestPreview ? 'World 预览' : previewVersion ? `历史 v${displayedSceneData?.revision.version}` : `v${displayedSceneData?.revision.version ?? '—'}`}
          </span>
        </div>

        <div className={styles.headerMeta} aria-label="空间状态">
          <span>{environment ? '全景环境' : renderFormat?.toUpperCase() ?? '无环境'}</span>
          <span>{displayedSceneData?.revision.instances.length ?? 0} 个物体</span>
          <span>{environmentUrl || assetUrl ? '渲染就绪' : isProjectLoading ? '读取中' : '等待环境'}</span>
        </div>

        <div className={styles.headerActions}>
          <button
            type="button"
            className={styles.globalQualityToggle}
            data-active={qualityMode === 'ply'}
            disabled={plyCapableCount === 0}
            onClick={toggleQualityMode}
            title="整个 Scene 统一切换 GLB 与 PLY"
          >
            {qualityMode === 'ply' ? `高质量 PLY ${qualityRenderState.loadedCount ?? 0}/${plyCapableCount}` : 'GLB 实时模式'}
          </button>
          <div className={styles.cameraSwitch} aria-label="相机视角">
            <button type="button" className={cameraMode === 'user' ? styles.cameraActive : ''} onClick={() => setCameraMode('user')}>用户视角</button>
            <button type="button" className={cameraMode === 'agent' ? styles.cameraActive : ''} disabled={!displayedSceneData?.scene.agent_viewpoint} title={displayedSceneData?.scene.agent_viewpoint ? '查看 Agent 保存的观察相机' : 'Agent 尚未设置观察相机'} onClick={() => setCameraMode('agent')}>Agent 视角</button>
          </div>
          <button type="button" className={activeDrawer === 'library' ? styles.actionActive : ''} aria-controls="spatial-library-drawer" aria-expanded={activeDrawer === 'library'} onClick={() => setActiveDrawer(current => current === 'library' ? null : 'library')}>资产</button>
          <button type="button" className={activeDrawer === 'inspector' ? styles.actionActive : ''} aria-controls="spatial-inspector-drawer" aria-expanded={activeDrawer === 'inspector'} onClick={() => setActiveDrawer(current => current === 'inspector' ? null : 'inspector')}>观察</button>
        </div>
      </header>}

      <div className={styles.viewportToolbar}>
        <div><span className={styles.toolBadge}>{cameraMode === 'agent' ? 'AGENT CAMERA' : 'FREE CAMERA'}</span><strong>{cameraMode === 'agent' ? '正在查看 Agent 的观察点' : 'WASD / Q E 自由移动 · 左键环视'}</strong></div>
        <button type="button" disabled={cameraMode !== 'user'} onClick={() => canvasRef.current?.resetUserView()}>重置视角</button>
      </div>

      <div className={styles.selectionToast} data-visible={Boolean(selectedInstance)}>
        <span>已选择</span>
        <strong>{selectedInstance?.label ?? '点击场景物体进行选择'}</strong>
        {selectedInstance && <button type="button" onClick={() => setActiveDrawer('inspector')}>编辑位置</button>}
        {selectedInstance && <button type="button" onClick={() => setSelectedInstanceId(null)}>取消</button>}
      </div>

      <div className={styles.viewportFooter}>
        <div className={styles.cameraReadout}><span className={styles.coordinateLabel}>相机</span><code>{vectorText(cameraPose?.position)}</code></div>
        <div className={styles.cameraReadout}><span className={styles.coordinateLabel}>看向</span><code>{vectorText(cameraPose?.target)}</code></div>
        <p>相对坐标</p>
      </div>

      <div className={styles.agentPresence}>
        <span className={styles.agentOrb} />
        <p><strong>主 Agent 观察机位</strong><small>{displayedSceneData?.scene.agent_viewpoint ? '已显示位置与朝向' : '尚未设置'}</small></p>
        <em>{displayedSceneData?.scene.agent_viewpoint ? 'LIVE' : 'OFFLINE'}</em>
      </div>
    </section>

    {activeDrawer === 'library' && <aside id="spatial-library-drawer" className={styles.buildRail} aria-label="场景资产库">
      <div className={styles.panelHeading}>
        <div><strong>场景资产库</strong><small>选择内容后在画布中高亮</small></div>
        <button type="button" onClick={() => setActiveDrawer(null)} aria-label="关闭资产库">×</button>
      </div>
      <div className={styles.drawerTabs} role="tablist" aria-label="资产库分类">
        <button id="spatial-assets-tab" type="button" role="tab" aria-controls="spatial-assets-panel" aria-selected={libraryTab === 'assets'} onClick={() => setLibraryTab('assets')}>物体 <span>{displayedSceneData?.revision.instances.length ?? 0}</span></button>
        <button id="spatial-scenes-tab" type="button" role="tab" aria-controls="spatial-scenes-panel" aria-selected={libraryTab === 'scenes'} onClick={() => setLibraryTab('scenes')}>场景 <span>{scenes.length}</span></button>
        <button id="spatial-history-tab" type="button" role="tab" aria-controls="spatial-history-panel" aria-selected={libraryTab === 'history'} onClick={() => setLibraryTab('history')}>版本 <span>{displayedSceneData?.history?.length ?? 0}</span></button>
      </div>

      {libraryTab === 'assets' && <section id="spatial-assets-panel" role="tabpanel" aria-labelledby="spatial-assets-tab" className={styles.assetLibrarySection}>
        <div className={styles.sectionLabel}><span>已放置物品</span><em>{displayedSceneData?.revision.instances.length ?? 0}</em></div>
        <div className={styles.assetLibraryList}>{displayedSceneData?.revision.instances.map((instance, index) => <button
          key={instance.instance_id}
          type="button"
          aria-pressed={selectedInstanceId === instance.instance_id}
          onClick={() => setSelectedInstanceId(instance.instance_id)}
        >
          <span className={styles.assetOrdinal}>{String(index + 1).padStart(2, '0')}</span>
          <span className={styles.assetLibraryCopy}><strong>{instance.label}</strong><small>{instance.role === 'terrain' ? '地形 · ' : ''}{normalizeSpatialProxy(instance) ? '灰盒代理体' : instance.optional_ply_artifact ? 'GLB + PLY' : 'GLB'}</small></span>
          <i aria-hidden="true" />
        </button>)}</div>
        {!displayedSceneData?.revision.instances.length && <p className={styles.emptyCopy}>{isManifestPreview ? '当前正在预览独立 World manifest；Scene 物体未叠加。' : 'Agent 放入 Scene 的 Lux 资产会显示在这里。'}</p>}
      </section>}

      {libraryTab === 'scenes' && <section id="spatial-scenes-panel" role="tabpanel" aria-labelledby="spatial-scenes-tab" className={styles.railSection}>
        <div className={styles.sectionLabel}><span>项目场景</span><em>{scenes.length}</em></div>
        <div className={styles.buildList}>{scenes.map(scene => <button key={scene.scene_id} type="button" disabled={Boolean(sceneId)} className={`${styles.buildItem} ${scene.scene_id === selectedSceneId ? styles.buildItemActive : ''}`} onClick={() => setSelectedSceneId(scene.scene_id)}><span className={styles.buildIndex}>v{scene.current_version}</span><span className={styles.buildCopy}><strong>{scene.title}</strong><small>{shortId(scene.scene_id)}</small></span><i /></button>)}</div>
      </section>}

      {libraryTab === 'history' && <section id="spatial-history-panel" role="tabpanel" aria-labelledby="spatial-history-tab" className={styles.historySection}>
        <div className={styles.sectionLabel}><span>自动版本</span><em>{displayedSceneData?.history?.length ?? 0}</em></div>
        <div className={styles.historyList}>{displayedSceneData?.history?.slice(0, 24).map(item => {
          const isCurrent = item.version === displayedSceneData.scene.current_version
          const isPreview = previewVersion === item.version
          return <button key={item.revision_id} type="button" className={`${styles.historyItem} ${isPreview || (!previewVersion && isCurrent) ? styles.historyItemActive : ''}`} onClick={() => setPreviewVersion(isCurrent ? null : item.version)} aria-label={`v${item.version} ${item.change_summary}`}>
            <span>v{item.version}</span><strong>{item.change_summary}</strong>{isCurrent && <small>当前</small>}
          </button>
        })}</div>
        {previewVersion && <button type="button" className={styles.returnCurrent} onClick={() => setPreviewVersion(null)}>返回当前版本</button>}
      </section>}
      <div className={styles.railFooter}><span>AUTO REVISION</span><p>版本由系统自动保存；Agent 无需管理 revision ID。</p></div>
    </aside>}

    {activeDrawer === 'inspector' && <aside id="spatial-inspector-drawer" className={styles.inspector} aria-label="对象与观察">
      <div className={styles.panelHeading}>
        <div><strong>{selectedInstance ? '对象详情' : '空间观察'}</strong><small>{selectedInstance ? '当前选中的可编辑物体' : '把当前视角交给 Agent'}</small></div>
        <button type="button" onClick={() => setActiveDrawer(null)} aria-label="关闭观察面板">×</button>
      </div>

      {selectedInstance && <section className={styles.objectDetail}>
        <div className={styles.detailTitle}><div><span>当前选择</span><h2>{selectedInstance.label}</h2></div><button type="button" onClick={() => setSelectedInstanceId(null)}>×</button></div>
        <div className={styles.editState} data-state={editStatus}><span>{editStatus === 'saving' ? '正在自动保存' : editStatus === 'saved' ? '已保存为新版本' : editStatus === 'error' ? '保存失败' : editDirty ? '等待保存' : '直接编辑 Scene'}</span><em>v{displayedSceneData?.revision.version ?? '—'}</em></div>
        <div className={styles.positionPad}>
          <div className={styles.padGrid} aria-label="平面移动">
            <button type="button" aria-label="向前移动" onClick={() => nudgeSelected(1, moveStep)}>↑</button>
            <button type="button" aria-label="向左移动" onClick={() => nudgeSelected(0, -moveStep)}>←</button>
            <button type="button" aria-label="向后移动" onClick={() => nudgeSelected(1, -moveStep)}>↓</button>
            <button type="button" aria-label="向右移动" onClick={() => nudgeSelected(0, moveStep)}>→</button>
          </div>
          <div className={styles.heightControls}><button type="button" onClick={() => nudgeSelected(2, moveStep)}>升高</button><button type="button" onClick={() => nudgeSelected(2, -moveStep)}>降低</button><button type="button" onClick={() => void groundSelected()}>贴合地形</button></div>
          <label className={styles.stepControl}>移动步长<select value={moveStep} onChange={event => setMoveStep(Number(event.target.value))}><option value="0.1">0.1</option><option value="0.5">0.5</option><option value="1">1</option><option value="5">5</option></select></label>
        </div>
        {editTransform && <div className={styles.transformEditor}>
          {(['position', 'rotation_deg', 'scale'] as const).map(field => <fieldset key={field}><legend>{field === 'position' ? '位置' : field === 'rotation_deg' ? '旋转 °' : '缩放'}</legend><div>{(['X', 'Y', 'Z'] as const).map((axisLabel, index) => <label key={axisLabel}><span>{axisLabel}</span><input type="number" step={field === 'rotation_deg' ? 1 : field === 'scale' ? 0.05 : 0.1} min={field === 'scale' ? 0.001 : undefined} value={Number(editTransform[field][index].toFixed(3))} onChange={event => {
            const value = Number(event.target.value); if (!Number.isFinite(value) || (field === 'scale' && value <= 0)) return
            updateEditTransform(current => ({ ...current, [field]: current[field].map((item, itemIndex) => itemIndex === index ? value : item) as [number, number, number] }))
          }} /></label>)}</div></fieldset>)}
        </div>}
        <dl className={styles.transformGrid}>
          <div><dt>来源 Job</dt><dd title={selectedInstance.source_job_id ?? undefined}>{shortId(selectedInstance.source_job_id)}</dd></div>
          <div><dt>显示资产</dt><dd>{selectedAssetLabel}</dd></div>
        </dl>
        <p className={styles.qualityNotice}>{normalizeSpatialProxy(selectedInstance) ? '这是用于构图、比例与占位验证的低成本代理体。' : selectedInstance.optional_ply_artifact ? '支持舞台全局高质量 PLY 模式。' : '当前物体只提供 GLB。'}</p>
      </section>}

      <section className={styles.observationComposer}>
        <div className={styles.composerHeading}><div><span>从这里提出修改</span><h2>把你看到的问题交给 Agent</h2></div><b>真实截图</b></div>
        <p>{isManifestPreview ? '当前是独立 World 预览；请从无 manifest 参数的 Scene 舞台提交观察。' : `自动附上当前画面、相机位置、所选物体与 Scene v${displayedSceneData?.revision.version ?? '—'}。`}</p>
        <label htmlFor="spatial-observation">修改意见</label>
        <textarea id="spatial-observation" value={comment} onChange={event => setComment(event.target.value)} placeholder="例如：从这个角度看，椅子挡住了入口。把它移到右侧墙边，再加一盏落地灯。" rows={6} />
        <button type="button" className={styles.submitObservation} disabled={!comment.trim() || Boolean(busy) || !displayedSceneData || Boolean(previewVersion)} onClick={() => void submitObservation()}>{isManifestPreview ? 'World 预览仅供查看' : previewVersion ? '历史版本仅供观察' : busy ?? '截图并发送给 Agent'}<span>→</span></button>
        {error && <p className={styles.errorMessage} role="alert">{error}</p>}
      </section>

      <details className={styles.boundaryNote}>
        <summary>能力边界</summary>
        <p>截图来自当前真实渲染像素；不声称可以局部语义修改 3DGS，也不验证碰撞或物理正确性。</p>
      </details>
    </aside>}
  </main>
}
