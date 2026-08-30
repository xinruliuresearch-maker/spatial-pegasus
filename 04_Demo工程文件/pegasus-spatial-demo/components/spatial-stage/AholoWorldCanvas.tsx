'use client'

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import type { Object3D, PerspectiveCamera, Splat, Vector3, Viewer } from '@manycore/aholo-viewer'
import type { SceneViewpoint } from '@/lib/spatial/scene-types'
import type { WorldRenderFormat } from './world-stage-model'
import { computeGlbObjectAlignment, computeLuxPlyAlignment } from './object-alignment'
import {
  createSpatialProxyObject,
  spatialInstanceAssetKey,
  spatialInstanceLocalSize,
  type SpatialStageInstance,
} from './proxy-geometry'
import { readRenderPixelsWithRetry } from './render-readback'
import styles from './SpatialStage.module.css'

type AholoViewerSdk = typeof import('@manycore/aholo-viewer')
type QualityStageInstance = SpatialStageInstance & {
  glb_artifact: NonNullable<SpatialStageInstance['glb_artifact']>
  optional_ply_artifact: NonNullable<SpatialStageInstance['optional_ply_artifact']>
  normalization: NonNullable<SpatialStageInstance['normalization']>
}

let aholoViewerSdkPromise: Promise<AholoViewerSdk> | null = null
const QUALITY_ALIGNMENT_VERSION = 'lux-ply-x-minus-90-v3'

function loadAholoViewerSdk(): Promise<AholoViewerSdk> {
  if (aholoViewerSdkPromise) return aholoViewerSdkPromise
  aholoViewerSdkPromise = import('@manycore/aholo-viewer')
  return aholoViewerSdkPromise
}

/**
 * Some generated GLBs omit NORMAL even though their material uses lighting.
 * Aholo rejects that shader/geometry combination. Build smooth area-weighted
 * normals once after parsing so the mesh remains renderable and raycastable.
 */
function ensureMissingMeshNormals(root: Object3D): void {
  root.traverse(node => {
    const mesh = node as Object3D & {
      isMesh?: boolean
      geometry?: {
        getAttribute(name: string): { array: ArrayLike<number>; count: number; itemSize: number } | undefined
        getIndex(): { array: ArrayLike<number> } | null
        addOrSetAttribute(name: string, array: Float32Array, itemSize: number): void
      }
    }
    if (!mesh.isMesh || !mesh.geometry || mesh.geometry.getAttribute('normal')) return
    const position = mesh.geometry.getAttribute('position')
    if (!position || position.itemSize < 3 || position.count < 3) return
    const normals = new Float32Array(position.count * 3)
    const index = mesh.geometry.getIndex()?.array
    const triangleCount = index ? Math.floor(index.length / 3) : Math.floor(position.count / 3)
    for (let triangle = 0; triangle < triangleCount; triangle += 1) {
      const a = Number(index ? index[triangle * 3] : triangle * 3)
      const b = Number(index ? index[triangle * 3 + 1] : triangle * 3 + 1)
      const c = Number(index ? index[triangle * 3 + 2] : triangle * 3 + 2)
      const ax = Number(position.array[a * position.itemSize]); const ay = Number(position.array[a * position.itemSize + 1]); const az = Number(position.array[a * position.itemSize + 2])
      const abx = Number(position.array[b * position.itemSize]) - ax; const aby = Number(position.array[b * position.itemSize + 1]) - ay; const abz = Number(position.array[b * position.itemSize + 2]) - az
      const acx = Number(position.array[c * position.itemSize]) - ax; const acy = Number(position.array[c * position.itemSize + 1]) - ay; const acz = Number(position.array[c * position.itemSize + 2]) - az
      const nx = aby * acz - abz * acy; const ny = abz * acx - abx * acz; const nz = abx * acy - aby * acx
      for (const vertex of [a, b, c]) {
        normals[vertex * 3] += nx; normals[vertex * 3 + 1] += ny; normals[vertex * 3 + 2] += nz
      }
    }
    for (let vertex = 0; vertex < position.count; vertex += 1) {
      const offset = vertex * 3
      const length = Math.hypot(normals[offset], normals[offset + 1], normals[offset + 2]) || 1
      normals[offset] /= length; normals[offset + 1] /= length; normals[offset + 2] /= length
    }
    mesh.geometry.addOrSetAttribute('normal', normals, 3)
  })
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error(message)), timeoutMs) }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

export interface StageCameraPose extends SceneViewpoint { distance: number }
export interface SpatialCanvasHandle {
  isReady(): boolean
  capture(viewpoint?: SceneViewpoint): Promise<Blob>
  querySurface(terrainInstanceId: string, horizontal: [number, number], castHeight: number, upAxis: 'Y' | 'Z'): Promise<[number, number, number]>
  currentViewpoint(): SceneViewpoint | null
  visibleInstanceIds(): string[]
  resetUserView(): void
}
export interface SpatialQualityRenderState {
  status: 'glb' | 'loading' | 'ply' | 'error'
  instanceId: string | null
  error?: string
  loadedCount?: number
  totalCount?: number
}

export interface SpatialAgentMarker {
  id: string
  label: string
  color: string
  viewpoint: SceneViewpoint
}

async function pixelsToPng(pixels: Uint8Array, width: number, height: number): Promise<Blob> {
  // A newly mounted/stale SDK session can expose an allocated Composite
  // target before it contains a rendered frame. Never publish that uniform
  // black buffer as a successful Agent observation; leave the durable command
  // claim to expire so another healthy Stage can retry it.
  let minimum = 255
  let maximum = 0
  for (let index = 0; index < pixels.length; index += 4) {
    minimum = Math.min(minimum, pixels[index], pixels[index + 1], pixels[index + 2])
    maximum = Math.max(maximum, pixels[index], pixels[index + 1], pixels[index + 2])
  }
  if (maximum <= 2 || maximum - minimum <= 1) {
    throw new Error('空间舞台尚未产生有效截图帧，请稍后重试。')
  }
  const source = document.createElement('canvas'); source.width = width; source.height = height
  const context = source.getContext('2d'); if (!context) throw new Error('浏览器无法创建截图画布。')
  const flipped = new Uint8ClampedArray(pixels.length)
  for (let y = 0; y < height; y += 1) flipped.set(pixels.subarray((height - 1 - y) * width * 4, (height - y) * width * 4), y * width * 4)
  context.putImageData(new ImageData(flipped, width, height), 0, 0)
  const scale = Math.min(1, 1280 / Math.max(width, 1), 720 / Math.max(height, 1))
  const outputWidth = Math.max(1, Math.round(width * scale))
  const outputHeight = Math.max(1, Math.round(height * scale))
  const output = scale < 1 ? document.createElement('canvas') : source
  if (scale < 1) {
    output.width = outputWidth; output.height = outputHeight
    const outputContext = output.getContext('2d')
    if (!outputContext) throw new Error('浏览器无法创建截图缩放画布。')
    outputContext.drawImage(source, 0, 0, outputWidth, outputHeight)
  }
  return new Promise((resolve, reject) => output.toBlob(blob => blob ? resolve(blob) : reject(new Error('PNG 编码失败。')), 'image/png'))
}

export const AholoWorldCanvas = forwardRef<SpatialCanvasHandle, {
  assetUrl: string | null
  format: WorldRenderFormat | null
  environmentUrl?: string | null
  environmentYawDeg?: number
  environmentExposure?: number
  upAxis: string | undefined
  instances?: SpatialStageInstance[]
  objectUrl?: (instance: SpatialStageInstance, quality: 'glb' | 'ply') => string | null
  agentViewpoint?: SceneViewpoint | null
  agentMarkers?: SpatialAgentMarker[]
  cameraMode?: 'user' | 'agent'
  qualityMode?: 'glb' | 'ply'
  qualityReloadToken?: number
  selectedInstanceId?: string | null
  onQualityStateChange?: (state: SpatialQualityRenderState) => void
  onSelectInstance?: (instanceId: string | null) => void
  onCameraChange?: (pose: StageCameraPose) => void
}>(function AholoWorldCanvas({
  assetUrl, format, environmentUrl = null, environmentYawDeg = 0, environmentExposure = 1, upAxis, instances = [], objectUrl, agentViewpoint, agentMarkers = [], cameraMode = 'user', qualityMode = 'glb', selectedInstanceId,
  qualityReloadToken = 0,
  onQualityStateChange, onSelectInstance, onCameraChange,
}, ref) {
  const containerRef = useRef<HTMLDivElement>(null)
  const captureQueueRef = useRef<Promise<void>>(Promise.resolve())
  const cameraModeRef = useRef(cameraMode)
  const agentViewpointRef = useRef(agentViewpoint)
  const qualityStateCallbackRef = useRef(onQualityStateChange)
  const instancesRef = useRef(instances)
  cameraModeRef.current = cameraMode
  agentViewpointRef.current = agentViewpoint
  qualityStateCallbackRef.current = onQualityStateChange
  instancesRef.current = instances
  const runtimeRef = useRef<{
    viewer: Viewer; camera: PerspectiveCamera; target: Vector3; objects: Map<string, Object3D>
    applyUser(): void; resetUser(): void; ensureInitialFit(): void; applyViewpoint(value: SceneViewpoint): void; viewpoint(): SceneViewpoint
  } | null>(null)
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>(assetUrl ? 'loading' : 'idle')
  const [error, setError] = useState<string | null>(null)
  const [keyboardActive, setKeyboardActive] = useState(false)
  const visibleInstances = useMemo(
    () => instances.filter(candidate => candidate.visible !== false),
    [instances],
  )
  const qualityCandidates = useMemo(
    () => visibleInstances.filter((candidate): candidate is QualityStageInstance => Boolean(
      !candidate.proxy && candidate.glb_artifact && candidate.optional_ply_artifact && candidate.normalization,
    )),
    [visibleInstances],
  )
  const qualityCandidatesRef = useRef(qualityCandidates)
  qualityCandidatesRef.current = qualityCandidates
  const qualityAssetKey = qualityCandidates.map(candidate => `${candidate.instance_id}:${candidate.optional_ply_artifact?.sha256}:${candidate.optional_ply_artifact?.workspace_path}:${QUALITY_ALIGNMENT_VERSION}`).join('|')
  const qualityTransformKey = JSON.stringify(qualityCandidates.map(candidate => [candidate.instance_id, candidate.transform.position, candidate.transform.rotation_quaternion, candidate.transform.scale]))
  const agentMarkersRef = useRef(agentMarkers)
  agentMarkersRef.current = agentMarkers
  const agentMarkersKey = JSON.stringify(agentMarkers.map(marker => [marker.id, marker.label, marker.color, marker.viewpoint]))
  const qualityCacheRef = useRef(new Map<string, {
    assetKey: string
    instanceId: string
    root: Object3D
    splat: Splat
    editable: Object3D
    viewer: Viewer
  }>())
  const qualityRequestRef = useRef<AbortController | null>(null)
  const agentObjectsRef = useRef(new Map<string, Object3D>())
  const disposeQualityCaches = useCallback(() => {
    for (const cache of qualityCacheRef.current.values()) {
      cache.editable.visible = true
      if (!cache.viewer.isDestroyed) cache.viewer.getScene().remove(cache.root)
      cache.splat.freeGPU()
    }
    qualityCacheRef.current.clear()
  }, [])

  useImperativeHandle(ref, () => ({
    isReady: () => Boolean(runtimeRef.current && !runtimeRef.current.viewer.isDestroyed),
    currentViewpoint: () => runtimeRef.current?.viewpoint() ?? null,
    visibleInstanceIds: () => [...(runtimeRef.current?.objects.keys() ?? [])],
    resetUserView: () => runtimeRef.current?.resetUser(),
    async querySurface(terrainInstanceId, horizontal, castHeight, surfaceUpAxis) {
      const runtime = runtimeRef.current
      if (!runtime) throw new Error('空间舞台尚未就绪。')
      const loadDeadline = Date.now() + 10_000
      let terrain = runtime.objects.get(terrainInstanceId)
      while (!terrain && Date.now() < loadDeadline) {
        await new Promise(resolve => setTimeout(resolve, 100))
        terrain = runtime.objects.get(terrainInstanceId)
      }
      if (!terrain) throw new Error('Lux 地形尚未加载到空间舞台。')
      const sdk = await loadAholoViewerSdk()
      const candidates: Object3D[] = []
      terrain.traverse(node => {
        if ((node as Object3D & { isMesh?: boolean }).isMesh) candidates.push(node)
      })
      if (!candidates.length) throw new Error('Lux 地形没有可求交的网格。')
      const picker = runtime.viewer.createPicker()
      const origin = surfaceUpAxis === 'Y'
        ? new sdk.Vector3(horizontal[0], castHeight, horizontal[1])
        : new sdk.Vector3(horizontal[0], horizontal[1], castHeight)
      const down = surfaceUpAxis === 'Y' ? new sdk.Vector3(0, -1, 0) : new sdk.Vector3(0, 0, -1)
      picker.raycaster.set(origin, down)
      const raw = picker.pickFirst(runtime.camera, candidates as never) as unknown
      const hit = Array.isArray(raw) ? raw[0] : raw
      if (!hit || typeof hit !== 'object' || !('point' in hit)) throw new Error('指定水平坐标没有命中 Lux 地形。')
      const point = (hit as { point: { x: number; y: number; z: number } }).point
      return [point.x, point.y, point.z]
    },
    capture(value) {
      const operation = async () => {
        const runtime = runtimeRef.current; const container = containerRef.current
        if (!runtime || !container) throw new Error('空间舞台尚未就绪。')
        const prior = runtime.viewpoint(); const originalSize = runtime.viewer.getSize()
        const width = Math.max(1, Math.round(originalSize.width)); const height = Math.max(1, Math.round(originalSize.height))
        try {
          if (value) runtime.applyViewpoint(value)
          const pixels = new Uint8Array(width * height * 4)
          await readRenderPixelsWithRetry(runtime.viewer, pixels, { x: 0, y: 0, width, height })
          return await pixelsToPng(pixels, width, height)
        } finally {
          if (value) runtime.applyViewpoint(prior); else runtime.viewer.render()
        }
      }
      const result = captureQueueRef.current.then(operation, operation)
      captureQueueRef.current = result.then(() => undefined, () => undefined)
      return result
    },
  }), [])

  useEffect(() => {
    const runtime = runtimeRef.current; if (!runtime) return
    if (cameraMode === 'agent' && agentViewpoint) runtime.applyViewpoint(agentViewpoint); else runtime.applyUser()
  }, [agentViewpoint, cameraMode])

  useEffect(() => {
    const runtime = runtimeRef.current
    if (!runtime || status !== 'ready') return
    let cancelled = false
    void (async () => {
      const sdk = await loadAholoViewerSdk()
      const desired = new Set(visibleInstances.map(instance => instance.instance_id))
      for (const [instanceId, object] of runtime.objects) {
        if (!desired.has(instanceId)) { runtime.viewer.getScene().remove(object); object.destroy(); runtime.objects.delete(instanceId) }
      }
      for (const instance of visibleInstances) {
        let outer = runtime.objects.get(instance.instance_id)
        const assetKey = spatialInstanceAssetKey(instance)
        if (outer && outer.userData.stageAssetKey !== assetKey) {
          runtime.viewer.getScene().remove(outer)
          outer.destroy()
          runtime.objects.delete(instance.instance_id)
          outer = undefined
        }
        if (!outer) {
          if (!assetKey) continue
          if (instance.proxy) {
            outer = createSpatialProxyObject(sdk, instance) ?? undefined
          } else if (instance.glb_artifact && instance.normalization && objectUrl) {
            const url = objectUrl(instance, 'glb')
            if (!url) continue
            const response = await fetch(url, { redirect: 'error' }); if (!response.ok || cancelled) continue
            const parsed = await sdk.GLTFLoader.loadGLTF(await response.arrayBuffer(), { textureLoader: url => sdk.downloadTexture(url, { context: runtime.viewer }) })
            if (cancelled) { parsed.scene.destroy(); continue }
            ensureMissingMeshNormals(parsed.scene)
            outer = new sdk.Object3D(); outer.name = instance.label; outer.userData.instanceId = instance.instance_id
            const glbAlignment = computeGlbObjectAlignment(instance.normalization)
            const basis = new sdk.Object3D()
            basis.rotation = new sdk.Euler(...glbAlignment.rotationRadians)
            basis.position.set(...glbAlignment.pivot)
            basis.add(parsed.scene); outer.add(basis)
          } else if (!instance.glb_artifact) {
            outer = createSpatialProxyObject(sdk, instance) ?? undefined
          }
          if (!outer) continue
          ensureMissingMeshNormals(outer)
          outer.userData.stageAssetKey = assetKey
          runtime.viewer.getScene().add(outer)
          runtime.objects.set(instance.instance_id, outer)
        }
        outer.position.set(...instance.transform.position); outer.quaternion = new sdk.Quaternion(...instance.transform.rotation_quaternion); outer.scale.set(...instance.transform.scale); outer.updateMatrixWorld(true)
      }
      const sceneExtent = visibleInstances.reduce((maximum, instance) => {
        const centerDistance = Math.hypot(...instance.transform.position)
        const localSize = Math.hypot(...spatialInstanceLocalSize(instance).map((value, axis) => value * instance.transform.scale[axis]))
        return Math.max(maximum, centerDistance + localSize)
      }, 1)
      runtime.camera.near = Math.max(Math.min(sceneExtent / 10_000, 0.05), 0.005)
      runtime.camera.far = Math.max(runtime.camera.far, sceneExtent * 20, 500)
      runtime.camera.updateProjectionMatrix()
      runtime.ensureInitialFit()
      runtime.viewer.render()
    })().catch(() => undefined)
    return () => { cancelled = true }
  }, [visibleInstances, objectUrl, status])

  useEffect(() => {
    const runtime = runtimeRef.current
    if (!runtime || status !== 'ready') return
    const highlighted: Parameters<Viewer['setHighlightObjects']>[0] = []
    const selected = selectedInstanceId ? runtime.objects.get(selectedInstanceId) : null
    selected?.traverse(node => {
      if ((node as Object3D & { isMesh?: boolean }).isMesh) highlighted.push({ object: node as Parameters<Viewer['setHighlightObjects']>[0][number]['object'] })
    })
    runtime.viewer.setHighlightObjects(highlighted)
    runtime.viewer.render()
  }, [selectedInstanceId, status])

  useEffect(() => {
    const runtime = runtimeRef.current
    if (!runtime || status !== 'ready') return
    let cancelled = false
    void (async () => {
      const sdk = await loadAholoViewerSdk()
      const markers = agentMarkersRef.current
      const desired = new Set(markers.map(marker => marker.id))
      for (const [id, object] of agentObjectsRef.current) {
        if (!desired.has(id)) { runtime.viewer.getScene().remove(object); object.destroy(); agentObjectsRef.current.delete(id) }
      }
      for (const marker of markers) {
        let object = agentObjectsRef.current.get(marker.id)
        if (!object) {
          const response = await fetch('/spatial/agent-observer.gltf', { redirect: 'error' })
          if (!response.ok || cancelled) continue
          const parsed = await sdk.GLTFLoader.loadGLTF(await response.arrayBuffer(), { textureLoader: url => sdk.downloadTexture(url, { context: runtime.viewer }) })
          if (cancelled) { parsed.scene.destroy(); continue }
          ensureMissingMeshNormals(parsed.scene)
          object = new sdk.Object3D(); object.name = marker.label; object.userData.agentId = marker.id; object.add(parsed.scene)
          parsed.scene.traverse(node => {
            const tintable = node as Object3D & { isMesh?: boolean; material?: { setValues?(values: { color: string }): void } }
            if (tintable.isMesh) tintable.material?.setValues?.({ color: marker.color })
          })
          runtime.viewer.getScene().add(object); agentObjectsRef.current.set(marker.id, object)
        }
        // A saved Agent viewpoint is also the marker's world position. When the
        // stage switches into that Agent's own camera, leaving the avatar visible
        // puts the camera inside its mesh and fills the framebuffer with the
        // marker tint. Third-person user view keeps the marker visible.
        object.visible = cameraMode !== 'agent'
        object.position.set(...marker.viewpoint.position)
        object.lookAt(new sdk.Vector3(...marker.viewpoint.target))
        object.scale.set(0.7, 0.7, 0.7)
        object.updateMatrixWorld(true)
      }
      runtime.viewer.render()
    })().catch(() => undefined)
    return () => { cancelled = true }
  }, [agentMarkersKey, cameraMode, status])

  useEffect(() => {
    const runtime = runtimeRef.current
    if (!runtime || !objectUrl || status !== 'ready') return
    qualityRequestRef.current?.abort()
    const controller = new AbortController()
    qualityRequestRef.current = controller
    const candidates = qualityCandidatesRef.current
    const totalCount = candidates.length

    if (qualityMode === 'glb' || totalCount === 0) {
      for (const cache of qualityCacheRef.current.values()) { cache.root.visible = false; cache.editable.visible = true }
      runtime.viewer.render()
      qualityStateCallbackRef.current?.({ status: 'glb', instanceId: null, loadedCount: 0, totalCount })
      return () => controller.abort()
    }

    qualityStateCallbackRef.current?.({ status: 'loading', instanceId: null, loadedCount: 0, totalCount })
    void (async () => {
      const sdk = await loadAholoViewerSdk()
      let loadedCount = 0
      const failures: string[] = []
      for (const instance of candidates) {
        if (controller.signal.aborted) return
        const instanceKey = `${instance.instance_id}:${instance.optional_ply_artifact?.sha256}:${QUALITY_ALIGNMENT_VERSION}`
        let cache = qualityCacheRef.current.get(instance.instance_id)
        try {
          if (!cache || cache.assetKey !== instanceKey) {
            if (cache) {
              cache.editable.visible = true
              if (!cache.viewer.isDestroyed) cache.viewer.getScene().remove(cache.root)
              cache.splat.freeGPU()
              qualityCacheRef.current.delete(instance.instance_id)
            }
            const url = objectUrl(instance, 'ply')
            if (!url) throw new Error('PLY 资产地址不可用。')
            const response = await fetch(url, { redirect: 'error', signal: controller.signal })
            if (!response.ok) throw new Error(`PLY 下载失败（HTTP ${response.status}）`)
            const data = await sdk.SplatLoader.parseSplatData(sdk.SplatLoader.SplatFileType.PLY, new Uint8Array(await response.arrayBuffer()))
            const qualitySplat = await sdk.SplatUtils.createSplat(data)
            if (controller.signal.aborted) { qualitySplat.freeGPU(); return }
            const dense = sdk.SplatUtils.computeDenseBox(new sdk.SplatUtils.SplatOperator(qualitySplat, data), 0.995)
            const alignment = computeLuxPlyAlignment(instance.normalization, { min: dense.boxMin as [number, number, number], max: dense.boxMax as [number, number, number] })
            const root = new sdk.Object3D(); const fit = new sdk.Object3D(); const basis = new sdk.Object3D()
            root.userData.instanceId = instance.instance_id
            fit.scale.set(...alignment.scale); basis.rotation = new sdk.Euler(...alignment.rotationRadians); basis.position.set(...alignment.pivot)
            basis.add(qualitySplat); fit.add(basis); root.add(fit)
            const editable = runtime.objects.get(instance.instance_id)
            if (!editable || runtime.viewer.isDestroyed) { qualitySplat.freeGPU(); continue }
            runtime.viewer.getScene().add(root)
            cache = { assetKey: instanceKey, instanceId: instance.instance_id, root, splat: qualitySplat, editable, viewer: runtime.viewer }
            qualityCacheRef.current.set(instance.instance_id, cache)
          }
          cache.root.position.set(...instance.transform.position); cache.root.quaternion = new sdk.Quaternion(...instance.transform.rotation_quaternion); cache.root.scale.set(...instance.transform.scale); cache.root.visible = true; cache.root.updateMatrixWorld(true)
          cache.editable.visible = false
          loadedCount += 1
          runtime.viewer.render()
          qualityStateCallbackRef.current?.({ status: loadedCount === totalCount ? 'ply' : 'loading', instanceId: null, loadedCount, totalCount })
        } catch (cause) {
          if (controller.signal.aborted) return
          const editable = runtime.objects.get(instance.instance_id); if (editable) editable.visible = true
          failures.push(cause instanceof Error ? cause.message.replace(/https?:\/\/\S+/g, '[asset]') : 'PLY 加载失败。')
        }
      }
      if (failures.length) qualityStateCallbackRef.current?.({ status: 'error', instanceId: null, loadedCount, totalCount, error: `${failures.length} 个 PLY 加载失败，已自动保留 GLB。` })
    })()
    return () => controller.abort()
  }, [objectUrl, qualityAssetKey, qualityMode, qualityReloadToken, status])

  useEffect(() => {
    const caches = qualityCacheRef.current
    void loadAholoViewerSdk().then(sdk => {
      for (const instance of qualityCandidatesRef.current) {
        const cached = caches.get(instance.instance_id); if (!cached) continue
        cached.root.position.set(...instance.transform.position); cached.root.scale.set(...instance.transform.scale); cached.root.quaternion = new sdk.Quaternion(...instance.transform.rotation_quaternion); cached.root.updateMatrixWorld(true)
      }
      const viewer = caches.values().next().value?.viewer as Viewer | undefined
      if (viewer && !viewer.isDestroyed) viewer.render()
    })
  }, [qualityTransformKey])

  useEffect(() => () => {
    qualityRequestRef.current?.abort()
    disposeQualityCaches()
  }, [disposeQualityCaches])

  useEffect(() => {
    const container = containerRef.current
    if (!container) { setStatus('idle'); return }
    const agentObjects = agentObjectsRef.current
    let cancelled = false; let viewer: Viewer | null = null; let camera: PerspectiveCamera | null = null
    let target: Vector3 | null = null; let splat: Splat | null = null; let raf: number | null = null; let navigationRaf: number | null = null
    const controller = new AbortController(); const removers: Array<() => void> = []
    const pressedKeys = new Set<string>()
    const movementKeys = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE'])
    const axis: 'Y' | 'Z' = upAxis?.toUpperCase() === 'Y' ? 'Y' : 'Z'
    const orbit = {
      yaw: axis === 'Z' ? -0.82 : 0.72,
      pitch: 0.38,
      distance: 8,
      target: [0, 0, 0] as [number, number, number],
      home: null as null | { yaw: number; pitch: number; distance: number; target: [number, number, number] },
      dragging: false,
      pointerId: -1,
      mode: 'orbit' as 'orbit' | 'pan',
      moved: false,
      x: 0,
      y: 0,
    }
    let hasInitialFit = false
    const fitEditableObjects = () => {
      const visibleInstances = instancesRef.current.filter(instance => instance.visible !== false)
      // Terrain modules are deliberately oversized so they can hide the edge
      // of the playable set. Including them in camera fitting makes the actual
      // architecture appear as a tiny model in the middle of the viewport.
      // Prefer authored objects whenever the Scene contains any, and only fit
      // terrain for terrain-only Scenes.
      const authoredInstances = visibleInstances.filter(instance => instance.role !== 'terrain')
      const editableInstances = authoredInstances.length > 0 ? authoredInstances : visibleInstances
      if (editableInstances.length === 0) return
      const center = editableInstances.reduce<[number, number, number]>((sum, instance) => [
        sum[0] + instance.transform.position[0],
        sum[1] + instance.transform.position[1],
        sum[2] + instance.transform.position[2],
      ], [0, 0, 0]).map(value => value / editableInstances.length) as [number, number, number]
      const radius = editableInstances.reduce((maximum, instance) => {
        const size = spatialInstanceLocalSize(instance)
        const scaled = size.map((value, index) => Math.abs(value * instance.transform.scale[index]))
        const extent = Math.hypot(...scaled) / 2
        const offset = Math.hypot(...instance.transform.position.map((value, index) => value - center[index]))
        return Math.max(maximum, extent + offset)
      }, 0.5)
      orbit.target = center
      orbit.distance = Math.min(Math.max(radius * 2.25, 1.5), 2400)
    }
    const objects = new Map<string, Object3D>()
    const render = () => { if (!cancelled && viewer && raf === null) raf = requestAnimationFrame(() => { raf = null; if (viewer && !viewer.isDestroyed) viewer.render() }) }
    const viewpoint = (): SceneViewpoint => ({
      position: camera ? [camera.position.x, camera.position.y, camera.position.z] : [0, 0, 0],
      target: target ? [target.x, target.y, target.z] : [...orbit.target],
      up: camera ? [camera.up.x, camera.up.y, camera.up.z] : [0, 0, 1],
      fov_deg: camera?.fov ?? 56,
    })
    const applyViewpoint = (value: SceneViewpoint) => {
      if (!camera || !target) return
      camera.position.set(...value.position)
      camera.up.set(...value.up)
      camera.fov = value.fov_deg
      camera.updateProjectionMatrix()
      target.set(...value.target)
      camera.lookAt(target)
      camera.updateMatrixWorld(true)
      onCameraChange?.({
        ...viewpoint(),
        distance: Math.hypot(target.x - camera.position.x, target.y - camera.position.y, target.z - camera.position.z),
      })
      render()
    }
    const applyUser = () => {
      if (!camera || !target) return
      const horizontal = Math.cos(orbit.pitch) * orbit.distance
      if (axis === 'Z') camera.up.set(0, 0, 1); else camera.up.set(0, 1, 0)
      if (axis === 'Z') camera.position.set(orbit.target[0] + Math.cos(orbit.yaw) * horizontal, orbit.target[1] + Math.sin(orbit.yaw) * horizontal, orbit.target[2] + Math.sin(orbit.pitch) * orbit.distance)
      else camera.position.set(orbit.target[0] + Math.cos(orbit.yaw) * horizontal, orbit.target[1] + Math.sin(orbit.pitch) * orbit.distance, orbit.target[2] + Math.sin(orbit.yaw) * horizontal)
      target.set(...orbit.target); camera.lookAt(target); camera.updateMatrixWorld(true); onCameraChange?.({ ...viewpoint(), distance: orbit.distance }); render()
    }
    const resetUser = () => {
      if (!orbit.home) return
      orbit.yaw = orbit.home.yaw
      orbit.pitch = orbit.home.pitch
      orbit.distance = orbit.home.distance
      orbit.target = [...orbit.home.target]
      applyUser()
    }
    const ensureInitialFit = () => {
      if (hasInitialFit || instancesRef.current.every(instance => instance.visible === false)) return
      fitEditableObjects()
      orbit.home = { yaw: orbit.yaw, pitch: orbit.pitch, distance: orbit.distance, target: [...orbit.target] }
      hasInitialFit = true
      if (cameraModeRef.current === 'user') applyUser()
    }
    let lastNavigationTime = 0
    const navigate = (time: number) => {
      navigationRaf = null
      if (cancelled || !camera || !target || cameraModeRef.current !== 'user' || pressedKeys.size === 0) {
        lastNavigationTime = 0
        return
      }
      const deltaSeconds = lastNavigationTime ? Math.min((time - lastNavigationTime) / 1000, 0.05) : 0
      lastNavigationTime = time
      if (deltaSeconds > 0) {
        const forward: [number, number, number] = [
          target.x - camera.position.x,
          target.y - camera.position.y,
          target.z - camera.position.z,
        ]
        forward[axis === 'Z' ? 2 : 1] = 0
        const forwardLength = Math.hypot(...forward) || 1
        forward[0] /= forwardLength; forward[1] /= forwardLength; forward[2] /= forwardLength
        const right: [number, number, number] = axis === 'Z'
          ? [forward[1], -forward[0], 0]
          : [-forward[2], 0, forward[0]]
        const up: [number, number, number] = axis === 'Z' ? [0, 0, 1] : [0, 1, 0]
        const movement: [number, number, number] = [0, 0, 0]
        const add = (vector: [number, number, number], multiplier: number) => {
          movement[0] += vector[0] * multiplier
          movement[1] += vector[1] * multiplier
          movement[2] += vector[2] * multiplier
        }
        if (pressedKeys.has('KeyW')) add(forward, 1)
        if (pressedKeys.has('KeyS')) add(forward, -1)
        if (pressedKeys.has('KeyD')) add(right, 1)
        if (pressedKeys.has('KeyA')) add(right, -1)
        if (pressedKeys.has('KeyE')) add(up, 1)
        if (pressedKeys.has('KeyQ')) add(up, -1)
        const length = Math.hypot(...movement)
        if (length > 0) {
          const speed = Math.max(orbit.distance * 0.9, 0.75) * (pressedKeys.has('ShiftLeft') || pressedKeys.has('ShiftRight') ? 3.5 : 1)
          orbit.target = orbit.target.map((value, index) => value + movement[index] / length * speed * deltaSeconds) as [number, number, number]
          applyUser()
        }
      }
      navigationRaf = requestAnimationFrame(navigate)
    }
    const startNavigation = () => {
      if (navigationRaf === null) navigationRaf = requestAnimationFrame(navigate)
    }
    const listen = <K extends keyof HTMLElementEventMap>(type: K, handler: (event: HTMLElementEventMap[K]) => void, options?: AddEventListenerOptions) => { container.addEventListener(type, handler as EventListener, options); removers.push(() => container.removeEventListener(type, handler as EventListener, options)) }
    void (async () => {
      try {
        setStatus('loading'); setError(null); const sdk = await loadAholoViewerSdk(); if (cancelled) return
        viewer = sdk.createViewer(`spatial-stage-${Date.now()}`, container, { antialiasing: true, alpha: false })
        // Aholo's async pixel readback is intentionally opt-in because it adds
        // an extra framebuffer copy. Agent/User observations depend on real
        // rendered pixels, so enable it only for this interactive Stage.
        viewer.config.isExtraCopyBeforeScreenEnabled.set(true)
        camera = new sdk.PerspectiveCamera(56, Math.max(container.clientWidth / Math.max(container.clientHeight, 1), 0.1), 0.02, 5000); target = new sdk.Vector3(); viewer.setCamera(camera)
        sdk.setViewerConfig(viewer, { pipeline: { Background: { background: { active: sdk.BackgroundMode.BasicBackground, basic: { color: new sdk.Color(0.018, 0.025, 0.035) } }, ground: { enabled: false } }, Splatting: { enabled: true }, TAA: { enabled: false } } }); viewer.requestRenderHandler = render
        if (environmentUrl) {
          try {
            const texture = await sdk.downloadTexture(environmentUrl, { context: viewer })
            if (!cancelled) sdk.setViewerConfig(viewer, { pipeline: { Background: { background: {
              active: sdk.BackgroundMode.EnvMapBackground,
              envmap: { texture, luma: environmentExposure, horizonRotation: environmentYawDeg * Math.PI / 180 },
            }, ground: { enabled: false } } } })
          } catch (cause) {
            if (!cancelled) setError(cause instanceof Error ? `全景环境加载失败：${cause.message.replace(/https?:\/\/\S+/g, '[asset]')}` : '全景环境加载失败。')
          }
        }
        fitEditableObjects()
        hasInitialFit = instancesRef.current.some(instance => instance.visible !== false)
        camera.near = Math.max(orbit.distance / 5000, 0.01); camera.far = Math.max(orbit.distance * 30, 500)
        // Lux assets already carry baked tonal information. A restrained
        // three-point rig preserves material contrast instead of bleaching
        // pale stone and sand textures into a flat white silhouette.
        viewer.getScene().add(new sdk.AmbientLight(0xffffff, 0.32))
        const stageLights = [
          { position: [4, -3, 7] as [number, number, number], intensity: 0.5 },
          { position: [-5, 2, 4] as [number, number, number], intensity: 0.16 },
          { position: [1, 6, 3] as [number, number, number], intensity: 0.1 },
        ]
        for (const { position, intensity } of stageLights) {
          const light = new sdk.DirectionalLight(0xffffff, intensity)
          light.position.set(...position)
          viewer.getScene().add(light)
        }
        orbit.home = { yaw: orbit.yaw, pitch: orbit.pitch, distance: orbit.distance, target: [...orbit.target] }
        runtimeRef.current = { viewer, camera, target, objects, applyUser, resetUser, ensureInitialFit, applyViewpoint, viewpoint }
        if (cameraModeRef.current === 'agent' && agentViewpointRef.current) applyViewpoint(agentViewpointRef.current); else applyUser(); setStatus('ready')
        if (assetUrl && format) {
          try {
            const worldResponse = await fetch(assetUrl, { signal: controller.signal, redirect: 'error' })
            if (!worldResponse.ok) throw new Error(`世界资产加载失败（HTTP ${worldResponse.status}）`)
            const data = await withTimeout(
              sdk.SplatLoader.parseSplatData(
                format === 'spz' ? sdk.SplatLoader.SplatFileType.SPZ : sdk.SplatLoader.SplatFileType.PLY,
                new Uint8Array(await worldResponse.arrayBuffer()),
              ),
              60_000,
              '3DGS 解码超时。',
            )
            if (cancelled) return
            splat = await sdk.SplatUtils.createSplat(data); viewer.getScene().add(splat)
            const dense = sdk.SplatUtils.computeDenseBox(new sdk.SplatUtils.SplatOperator(splat, data), 0.995)
            const containsCaptureOrigin = dense.boxMin.every((minimum, index) => minimum <= 0 && dense.boxMax[index] >= 0)
            const diagonal = Math.hypot(...dense.boxMax.map((value, index) => value - dense.boxMin[index]))
            if (containsCaptureOrigin) {
              // Aholo AI World/360 reconstructions are authored around the capture
              // origin. Looking inward from outside their splat shell produces an
              // unreadable, overdrawn view even though the asset is valid.
              orbit.yaw = Math.PI / 2
              orbit.pitch = 0
              orbit.distance = 1
              orbit.target = axis === 'Z' ? [0, -1, 0] : [0, 0, -1]
            } else {
              orbit.target = dense.boxMin.map((value, index) => (value + dense.boxMax[index]) / 2) as [number, number, number]
              orbit.distance = Number.isFinite(diagonal) ? Math.min(Math.max(diagonal * 0.82, 1.5), 2400) : orbit.distance
            }
            orbit.home = { yaw: orbit.yaw, pitch: orbit.pitch, distance: orbit.distance, target: [...orbit.target] }
            camera.near = Math.max(orbit.distance / 5000, 0.01); camera.far = Math.max(orbit.distance * 30, 500)
            if (cameraModeRef.current === 'agent' && agentViewpointRef.current) applyViewpoint(agentViewpointRef.current)
            else applyUser()
            setError(null)
          } catch (cause) {
            if (!cancelled && !(cause instanceof DOMException && cause.name === 'AbortError')) {
              const message = cause instanceof Error ? cause.message.replace(/https?:\/\/\S+/g, '[asset]') : 'World 背景载入失败。'
              setError(`${message} Lux 可编辑物体仍可继续使用。`)
            }
          }
        }
      } catch (cause) { if (!cancelled && !(cause instanceof DOMException && cause.name === 'AbortError')) { setError(cause instanceof Error ? cause.message.replace(/https?:\/\/\S+/g, '[asset]') : '空间载入失败。'); setStatus('error') } }
    })()
    const resize = new ResizeObserver(() => {
      if (viewer && camera && !viewer.isDestroyed) {
        viewer.resize()
        camera.aspect = Math.max(container.clientWidth / Math.max(container.clientHeight, 1), 0.1)
        camera.updateProjectionMatrix()
        camera.updateMatrixWorld(true)
        render()
      }
    }); resize.observe(container)
    listen('focus', () => setKeyboardActive(true))
    listen('blur', () => { pressedKeys.clear(); lastNavigationTime = 0; setKeyboardActive(false) })
    listen('keydown', event => {
      if (cameraModeRef.current !== 'user' || (!movementKeys.has(event.code) && !event.code.startsWith('Shift'))) return
      event.preventDefault()
      pressedKeys.add(event.code)
      startNavigation()
    })
    listen('keyup', event => {
      if (!movementKeys.has(event.code) && !event.code.startsWith('Shift')) return
      event.preventDefault()
      pressedKeys.delete(event.code)
      if (![...pressedKeys].some(code => movementKeys.has(code))) lastNavigationTime = 0
    })
    listen('contextmenu', event => event.preventDefault())
    listen('pointerdown', event => {
      if (event.button !== 0 && event.button !== 1 && event.button !== 2) return
      container.focus({ preventScroll: true })
      orbit.dragging = true
      orbit.pointerId = event.pointerId
      orbit.mode = event.shiftKey || event.button === 1 || event.button === 2 ? 'pan' : 'orbit'
      orbit.moved = false
      orbit.x = event.clientX
      orbit.y = event.clientY
      container.setPointerCapture(event.pointerId)
    })
    listen('pointermove', event => {
      if (!orbit.dragging || event.pointerId !== orbit.pointerId || cameraModeRef.current !== 'user') return
      const deltaX = event.clientX - orbit.x
      const deltaY = event.clientY - orbit.y
      if (Math.hypot(deltaX, deltaY) > 2) orbit.moved = true
      if (orbit.mode === 'orbit') {
        orbit.yaw -= deltaX * 0.006
        orbit.pitch = Math.min(1.42, Math.max(-1.42, orbit.pitch + deltaY * 0.0045))
      } else {
        const speed = Math.max(orbit.distance, 0.35) * 0.0014
        const right: [number, number, number] = axis === 'Z'
          ? [-Math.sin(orbit.yaw), Math.cos(orbit.yaw), 0]
          : [-Math.sin(orbit.yaw), 0, Math.cos(orbit.yaw)]
        const vertical: [number, number, number] = axis === 'Z'
          ? [-Math.cos(orbit.yaw) * Math.sin(orbit.pitch), -Math.sin(orbit.yaw) * Math.sin(orbit.pitch), Math.cos(orbit.pitch)]
          : [-Math.cos(orbit.yaw) * Math.sin(orbit.pitch), Math.cos(orbit.pitch), -Math.sin(orbit.yaw) * Math.sin(orbit.pitch)]
        orbit.target = orbit.target.map((value, index) => value - right[index] * deltaX * speed + vertical[index] * deltaY * speed) as [number, number, number]
      }
      orbit.x = event.clientX
      orbit.y = event.clientY
      applyUser()
    })
    const stop = (event: PointerEvent) => { if (event.pointerId === orbit.pointerId) { orbit.dragging = false; orbit.pointerId = -1 } }; listen('pointerup', stop); listen('pointercancel', stop)
    listen('wheel', event => { event.preventDefault(); if (cameraModeRef.current === 'user') { orbit.distance = Math.min(5000, Math.max(0.35, orbit.distance * Math.exp(event.deltaY * 0.0012))); applyUser() } }, { passive: false })
    listen('click', async event => {
      if (!viewer || !camera) return
      if (orbit.moved) { orbit.moved = false; return }
      const sdk = await loadAholoViewerSdk(); const rect = container.getBoundingClientRect()
      const hits = viewer.createPicker().pick(new sdk.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -(((event.clientY - rect.top) / rect.height) * 2 - 1)), camera, true)
      let node: Object3D | null = hits[0]?.object ?? null; let instanceId: string | null = null
      while (node) { if (typeof node.userData.instanceId === 'string') { instanceId = node.userData.instanceId; break } node = node.parent }
      onSelectInstance?.(instanceId)
    })
    return () => { cancelled = true; controller.abort(); resize.disconnect(); removers.forEach(remove => remove()); if (raf !== null) cancelAnimationFrame(raf); if (navigationRaf !== null) cancelAnimationFrame(navigationRaf); pressedKeys.clear(); runtimeRef.current = null; disposeQualityCaches(); for (const object of agentObjects.values()) object.destroy(); agentObjects.clear(); if (viewer && !viewer.isDestroyed) { if (splat) { viewer.getScene().remove(splat); splat.freeGPU() } viewer.destroy() } }
  }, [assetUrl, disposeQualityCaches, environmentExposure, environmentUrl, environmentYawDeg, format, upAxis, onCameraChange, onSelectInstance])

  return <div className={styles.viewerRoot}>
    <div ref={containerRef} className={styles.viewerContainer} aria-label="Aholo 混合空间查看器" tabIndex={0} title="点击画面激活；WASD 水平移动；Q/E 下上移动；Shift 加速；左键环视" />
    {status !== 'ready' && <div className={styles.viewerState} role={status === 'error' ? 'alert' : 'status'}><strong>{status === 'error' ? '空间载入失败' : status === 'idle' ? '选择一个 Scene' : '正在构建混合空间'}</strong><p>{status === 'error' ? error : '正在读取全景环境与 Lux Scene 资产。'}</p></div>}
    {status === 'ready' && error && <div className={styles.viewerWarning} role="alert"><strong>环境背景未完整载入</strong><span>{error}</span></div>}
    {status === 'ready' && cameraMode === 'user' && <div className={styles.viewerHint} data-active={keyboardActive}>
      <span className={styles.controlState}>{keyboardActive ? '自由相机已激活' : '点击画面激活自由相机'}</span>
      <span className={styles.keyGroup}><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd><b>水平移动</b></span>
      <span className={styles.keyGroup}><kbd>Q</kbd><kbd>E</kbd><b>下降 / 上升</b></span>
      <span className={styles.mouseControl}>左键环视 · Shift 加速</span>
    </div>}
    {status === 'ready' && cameraMode === 'agent' && <div className={styles.viewerHint}><span className={styles.controlState}>Agent 视角只读 · 切回用户视角后可移动</span></div>}
    <div className={styles.scanline} aria-hidden="true" />
  </div>
})
