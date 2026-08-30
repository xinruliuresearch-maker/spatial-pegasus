import { NextRequest, NextResponse } from 'next/server'
import { createHash } from 'node:crypto'
import { resolveLocalOwner } from '@/lib/local-owner'
import { getOwnedImageAsset } from '@/lib/media/storage'
import { toRasterAssetRef } from '@/lib/media/reference'
import { createSpatialObservation, normalizeViewpoint, requireSpatialScene } from '@/lib/spatial'
import { createScenePublicationWorkspace } from '@/lib/spatial/scene-workspace'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; sceneId: string }> }) {
  const userId = await resolveLocalOwner(); if (userId instanceof Response) return userId
  const { id, sceneId } = await params
  try {
    const body = await request.json() as Record<string, unknown>
    if (typeof body.asset_id !== 'string' || typeof body.comment !== 'string' || !body.comment.trim()) return NextResponse.json({ error: 'asset_id and comment required' }, { status: 400 })
    const scene = await requireSpatialScene(sceneId, { projectId: id, userId })
    const viewpoint = normalizeViewpoint(body.viewpoint as Parameters<typeof normalizeViewpoint>[0])
    const selected = typeof body.selected_instance_id === 'string' ? body.selected_instance_id : null
    const visible = Array.isArray(body.visible_instance_ids) ? body.visible_instance_ids.filter((value): value is string => typeof value === 'string').slice(0, 500) : []
    const observationId = `observation_${createHash('sha256').update(`${scene.scene_id}\0${scene.current_revision_id}\0${body.asset_id}\0${body.comment}`).digest('hex').slice(0, 32)}`
    const asset = await getOwnedImageAsset(body.asset_id, userId, id)
    if (!asset) return NextResponse.json({ error: 'screenshot asset not found' }, { status: 404 })
    const workspacePath = `output/spatial/reviews/${observationId}/view.png`
    const workspace = await createScenePublicationWorkspace({ conversationId: id, userId })
    await workspace.writeRaster(workspacePath, toRasterAssetRef(asset), 'User spatial observation', { archive: false })
    const observation = await createSpatialObservation({
      observation_id: observationId, scene_id: scene.scene_id, project_id: scene.project_id, user_id: scene.user_id,
      revision_id: scene.current_revision_id, source: 'user', viewpoint,
      screenshot_asset_id: asset.assetId, screenshot_workspace_path: workspacePath,
      selected_instance_id: selected, visible_instance_ids: visible, comment: body.comment.trim().slice(0, 4000),
    })
    return NextResponse.json({ observation, image: toRasterAssetRef(asset) })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unable to create observation' }, { status: 409 })
  }
}
