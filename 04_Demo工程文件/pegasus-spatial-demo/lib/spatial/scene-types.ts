export type Vec3 = [number, number, number]
export type Quaternion = [number, number, number, number]

export interface SceneViewpoint {
  position: Vec3
  target: Vec3
  up: Vec3
  fov_deg: number
}

export interface SceneTransform3D {
  position: Vec3
  rotation_quaternion: Quaternion
  scale: Vec3
}

export interface SceneSourceArtifact {
  artifact_id: string
  job_id: string
  kind: string
  workspace_path: string
  mime_type: string
  size_bytes: number
  sha256: string
  metadata: Record<string, unknown>
}

export interface SceneWorldSource {
  source_job_id: string
  up_axis: 'Y' | 'Z'
  artifacts: SceneSourceArtifact[]
}

export interface ScenePanoramaEnvironment {
  kind: 'equirectangular_panorama'
  workspace_path: string
  asset_id: string
  mime_type: string
  width: number
  height: number
  size_bytes: number
  sha256: string
  yaw_deg: number
  exposure: number
}

export interface SceneObjectNormalization {
  basis_contract_version?: 'lux3d_g1_paired_v1'
  source_up_axis: 'Y'
  scene_up_axis: 'Y' | 'Z'
  pivot: 'bottom_center'
  glb_basis_correction?: 'gltf_y_up_to_scene_z_up'
  ply_source_up_axis?: 'Z' | '-Y'
  ply_yaw_correction_deg?: number
  ply_basis_correction?: 'lux_ply_negative_y_up_to_scene_z_up'
  bounds?: { min: Vec3; max: Vec3; size: Vec3 }
}

/**
 * A lightweight procedural stand-in used while a Scene is being blocked out.
 * Dimensions are `[width, depth, height]` in Scene coordinates before the
 * instance transform is applied, with the same bottom-centre pivot as a GLB.
 */
export type SceneProxyPrimitive = 'box' | 'cylinder' | 'arch'
export type SceneProxyMaterial = 'matte' | 'metal' | 'stone' | 'sand' | 'glass' | 'emissive'

export interface SceneProxyGeometry {
  kind: SceneProxyPrimitive
  dimensions: Vec3
  color: string
  material: SceneProxyMaterial
  opacity: number
}

export interface SceneObjectInstance {
  instance_id: string
  /** Stable semantic key used by declarative Scene specs. Legacy revisions fall back to instance_id. */
  key?: string
  label: string
  group?: string
  visible?: boolean
  /** Legacy Scene revisions predate roles and are interpreted as ordinary objects. */
  role?: 'terrain' | 'object'
  /** Present when this instance is a procedural greybox proxy rather than a Lux asset. */
  proxy?: SceneProxyGeometry
  /** Proxy instances retain virtual source fields for reader compatibility. Check `proxy` before loading the placeholder artifact. */
  source_job_id: string
  glb_artifact: SceneSourceArtifact
  optional_ply_artifact?: SceneSourceArtifact
  normalization: SceneObjectNormalization
  transform: SceneTransform3D
}

export interface SpatialSceneRecord {
  scene_id: string
  project_id: string
  user_id: string
  conversation_id: string
  title: string
  current_revision_id: string
  current_version: number
  agent_viewpoint: SceneViewpoint | null
  created_at: Date
  updated_at: Date
}

export interface SpatialSceneRevisionRecord {
  revision_id: string
  scene_id: string
  project_id: string
  user_id: string
  version: number
  parent_revision_id: string | null
  mutation_key: string
  mutation_hash: string
  /** Absent on legacy revisions; readers normalize it to null. */
  environment?: ScenePanoramaEnvironment | null
  world: SceneWorldSource | null
  instances: SceneObjectInstance[]
  change_summary: string
  observation_id: string | null
  created_by: string
  committed: boolean
  created_at: Date
  updated_at: Date
}

export interface SpatialObservationRecord {
  observation_id: string
  scene_id: string
  project_id: string
  user_id: string
  revision_id: string
  source: 'user' | 'agent'
  viewpoint: SceneViewpoint
  screenshot_asset_id: string
  screenshot_workspace_path: string
  selected_instance_id: string | null
  visible_instance_ids: string[]
  comment: string
  created_at: Date
  updated_at: Date
}

export interface SpatialRenderSessionRecord {
  session_id: string
  scene_id: string
  project_id: string
  user_id: string
  client_id: string
  lease_token: string
  heartbeat_at: Date
  expires_at: Date
  created_at: Date
  updated_at: Date
}

export type SpatialRenderCommandStatus = 'queued' | 'claimed' | 'completed' | 'failed'

export interface SpatialRenderCommandRecord {
  command_id: string
  scene_id: string
  project_id: string
  user_id: string
  run_id: string
  tool_use_id: string
  /** Legacy render commands are capture commands. */
  kind?: 'capture' | 'surface_query'
  revision_id: string
  viewpoint: SceneViewpoint
  note: string | null
  status: SpatialRenderCommandStatus
  lease: { session_id: string; token: string; expires_at: Date } | null
  observation_id: string
  surface_query?: {
    terrain_instance_id: string
    horizontal: [number, number]
    cast_height: number
    up_axis: 'Y' | 'Z'
  } | null
  surface_result?: {
    point: Vec3
    terrain_instance_id: string
  } | null
  screenshot_asset_id: string | null
  screenshot_workspace_path: string | null
  last_error: string | null
  created_at: Date
  updated_at: Date
  completed_at: Date | null
}

export interface SceneCommandScope {
  projectId: string
  userId: string
  conversationId?: string
}

export interface SceneMutationIdentity extends SceneCommandScope {
  runId: string
  toolUseId: string
  actorId: string
}

export type SceneMutationResult =
  | { status: 'applied'; scene: SpatialSceneRecord; revision: SpatialSceneRevisionRecord; replayed: boolean }
  | { status: 'scene_changed'; scene: SpatialSceneRecord; latestRevision: SpatialSceneRevisionRecord }
