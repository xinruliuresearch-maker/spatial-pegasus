import assert from 'node:assert/strict'
import { materialsDiscoveryWorkspace } from '../definitions/materials-discovery'
import { createWorkspaceInstance } from '../instance'

const REQUIRED_RESEARCH_DOCUMENTS = [
  'analysis/research-scope.md',
  'references/evidence-ledger.md',
  'output/research-report.md',
]

const OPTIONAL_RESEARCH_DOCUMENTS = [
  'analysis/anchor-reviews.md',
  'analysis/search-frontier.md',
  'analysis/literature-map.md',
  'analysis/research-gaps.md',
  'analysis/conflict-matrix.md',
  'analysis/adjacent-literature-map.md',
  'output/hypotheses.md',
]

function main(): void {
  const declarations = new Map(
    materialsDiscoveryWorkspace.policy.reservedPaths.map(item => [item.path, item]),
  )

  for (const path of REQUIRED_RESEARCH_DOCUMENTS) {
    const declaration = declarations.get(path)
    assert.ok(declaration, `missing minimum research document declaration: ${path}`)
    assert.match(declaration.description, /最低研究契约/)
  }

  for (const path of OPTIONAL_RESEARCH_DOCUMENTS) {
    const declaration = declarations.get(path)
    assert.ok(declaration, `missing optional research document declaration: ${path}`)
    assert.match(declaration.description, /可选/)
  }

  const workspace = createWorkspaceInstance(materialsDiscoveryWorkspace)
  assert.deepEqual(workspace.list(), [], 'reserved paths must be declarations, not pre-created files')
  for (const path of [...REQUIRED_RESEARCH_DOCUMENTS, ...OPTIONAL_RESEARCH_DOCUMENTS]) {
    assert.equal(workspace.exists(path), false, `declaration unexpectedly created ${path}`)
    assert.equal(workspace.getFileDeclaration(path)?.path, path)
  }

  console.log('materials-discovery-definition:verify passed')
}

main()
