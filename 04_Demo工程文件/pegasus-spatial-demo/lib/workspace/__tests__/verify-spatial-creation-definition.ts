import assert from 'node:assert/strict'

import { spatialCreationWorkspace } from '../definitions/spatial-creation'
import { createWorkspaceInstance } from '../instance'

const SPATIAL_DECLARATIONS = [
  'output/spatial/images/<asset-id>.png',
  'output/spatial/objects/<build-id>/manifest.json',
  'output/spatial/worlds/<build-id>/manifest.json',
  'output/spatial/reviews/<artifact-id>.md',
]

function main(): void {
  assert.equal(spatialCreationWorkspace.name, 'spatial-creation')
  assert.deepEqual(
    spatialCreationWorkspace.policy.allowedRoots,
    ['output', 'analysis', 'notes', 'references', '.sci-pegasus'],
  )
  assert.equal(spatialCreationWorkspace.policy.maxFiles, 500)
  assert.equal(spatialCreationWorkspace.policy.maxDepth, 8)

  const declarations = new Map(
    spatialCreationWorkspace.policy.reservedPaths.map(item => [item.path, item]),
  )
  for (const declarationPath of SPATIAL_DECLARATIONS) {
    assert.ok(declarations.has(declarationPath), `missing spatial declaration: ${declarationPath}`)
  }

  const workspace = createWorkspaceInstance(spatialCreationWorkspace)
  assert.deepEqual(workspace.list(), [], 'reserved paths must not pre-create files')
  for (const declarationPath of SPATIAL_DECLARATIONS) {
    assert.equal(workspace.exists(declarationPath), false)
    assert.equal(workspace.getFileDeclaration(declarationPath)?.path, declarationPath)
  }

  console.log('spatial-creation-definition:verify passed')
}

main()
