import { WorkspaceDefinition } from '../../types'

/**
 * Durable workspace for image, object and world creation.
 *
 * Reserved paths document product semantics only; they do not pre-create
 * files. Build IDs remain runtime values, so placeholder declarations are
 * examples rather than fixed output filenames.
 */
export const spatialCreationWorkspace: WorkspaceDefinition = {
  name: 'spatial-creation',
  description: '图像、3D 物体、Aholo World、修订血缘与可观察评审工作区',
  policy: {
    allowedRoots: ['output', 'analysis', 'notes', 'references', '.sci-pegasus'],
    internalRoot: '.sci-pegasus',
    allowedRootFiles: ['MAP.md'],
    maxFiles: 500,
    maxDepth: 8,
    maxPathLength: 512,
    maxSegmentLength: 128,
    reservedPaths: [
      {
        path: 'MAP.md',
        description: '用户可见空间创作产物的可选语义索引',
        resolver: { type: 'field', field: 'output.map' },
      },
      {
        path: 'output/spatial/images/<asset-id>.png',
        description: '生成或修订的场景参考图与物体参考图；文件名由资产 ID 决定',
        resolver: { type: 'field', field: 'output.spatial.images' },
      },
      {
        path: 'output/spatial/objects/<build-id>/manifest.json',
        description: 'Lux3D GLB 物体、供应商任务、哈希、输入与血缘 manifest',
        resolver: { type: 'field', field: 'output.spatial.objects' },
      },
      {
        path: 'output/spatial/worlds/<build-id>/manifest.json',
        description: 'Aholo World 资产、世界入口、供应商任务、输入与血缘 manifest',
        resolver: { type: 'field', field: 'output.spatial.worlds' },
      },
      {
        path: 'output/spatial/scenes/<scene-id>/scene.json',
        description: '可由 Agent 使用 Write/Edit 维护并通过 ApplySceneSpec 原子应用的声明式 Scene 源文件',
        resolver: { type: 'field', field: 'output.spatial.scenes' },
      },
      {
        path: 'output/spatial/reviews/<artifact-id>.md',
        description: '基于可观察产物的 verified / inferred / unknown 评审与修订建议',
        resolver: { type: 'field', field: 'output.spatial.reviews' },
      },
      {
        path: '.sci-pegasus/settings/project.md',
        description: '项目内部的空间创作偏好与供应商决策记录',
        resolver: { type: 'field', field: 'settings.spatial_creation' },
      },
    ],
  },
}
