import { createHash } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { resolveLocalOwner } from '@/lib/local-owner'
import { canonicalSpatialJson, getCurrentSpatialSceneRevision, listSpatialSceneHistory, mutateSpatialScene, normalizeTransform, requireSpatialScene, SpatialSceneCommandRejectedError } from '@/lib/spatial'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string; sceneId: string }> }) {
  const userId = await resolveLocalOwner(); if (userId instanceof Response) return userId
  const { id, sceneId } = await params
  try {
    const scene = await requireSpatialScene(sceneId, { projectId: id, userId })
    const search = new URL(request.url).searchParams
    const includeHistory = search.get('history') === '1'
    const requestedVersion = Number(search.get('version'))
    const needsHistory = includeHistory || (Number.isInteger(requestedVersion) && requestedVersion > 0)
    const history = needsHistory ? await listSpatialSceneHistory(scene.scene_id, { projectId: id, userId }) : undefined
    const revision = Number.isInteger(requestedVersion) && requestedVersion > 0
      ? history?.find(candidate => candidate.version === requestedVersion)
      : await getCurrentSpatialSceneRevision(scene)
    if (!revision) return NextResponse.json({ error: 'Scene revision not found' }, { status: 404 })
    return NextResponse.json({ scene, revision, ...(history ? { history } : {}) })
  } catch (error) {
    return NextResponse.json({ error: error instanceof SpatialSceneCommandRejectedError ? 'Scene not found' : 'Unable to read Scene' }, { status: error instanceof SpatialSceneCommandRejectedError ? 404 : 500 })
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string; sceneId: string }> }) {
  const userId = await resolveLocalOwner(); if (userId instanceof Response) return userId
  const { id, sceneId } = await params
  try {
    const body = await request.json() as {
      edit_id?: unknown
      expected_version?: unknown
      instance_id?: unknown
      position?: unknown
      rotation_deg?: unknown
      scale?: unknown
    }
    if (typeof body.edit_id !== 'string' || !body.edit_id.trim() || body.edit_id.length > 160) throw new TypeError('edit_id 无效。')
    if (typeof body.instance_id !== 'string' || !body.instance_id.trim() || body.instance_id.length > 160) throw new TypeError('instance_id 无效。')
    if (!Number.isInteger(body.expected_version) || Number(body.expected_version) < 1) throw new TypeError('expected_version 无效。')
    const scene = await requireSpatialScene(sceneId, { projectId: id, userId })
    const current = await getCurrentSpatialSceneRevision(scene)
    const target = current.instances.find(instance => instance.instance_id === body.instance_id)
    if (!target) throw new TypeError('Scene 中不存在该物体。')
    const transformInput = { position: body.position, rotation_deg: body.rotation_deg, scale: body.scale }
    const commandHash = createHash('sha256').update(canonicalSpatialJson({ instance_id: body.instance_id, ...transformInput })).digest('hex')
    const result = await mutateSpatialScene({
      identity: {
        projectId: id,
        userId,
        conversationId: id,
        runId: `user-stage-edit:${scene.scene_id}`,
        toolUseId: body.edit_id.trim(),
        actorId: `user:${userId}`,
      },
      sceneId: scene.scene_id,
      expectedVersion: Number(body.expected_version),
      commandHash,
      summary: `用户调整“${target.label}”的位置与姿态`,
      mutate: snapshot => {
        let found = false
        const instances = snapshot.instances.map(instance => {
          if (instance.instance_id !== body.instance_id) return instance
          found = true
          return { ...instance, transform: normalizeTransform(transformInput, instance.transform) }
        })
        if (!found) throw new TypeError('Scene 中不存在该物体。')
        return { ...snapshot, instances }
      },
    })
    if (result.status === 'scene_changed') {
      return NextResponse.json({ error: 'scene_changed', latest_version: result.latestRevision.version }, { status: 409 })
    }
    return NextResponse.json({ scene: result.scene, revision: result.revision, replayed: result.replayed })
  } catch (error) {
    const status = error instanceof SpatialSceneCommandRejectedError ? 404 : error instanceof TypeError ? 400 : 500
    return NextResponse.json({ error: error instanceof Error ? error.message : '无法保存物体变换。' }, { status })
  }
}
