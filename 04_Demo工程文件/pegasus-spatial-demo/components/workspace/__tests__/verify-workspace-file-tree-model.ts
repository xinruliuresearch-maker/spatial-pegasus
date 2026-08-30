import assert from 'node:assert/strict'
import type { WorkspaceArtifact } from '@/hooks/useWorkspaceArtifacts'
import {
  buildWorkspaceTree,
  findTreeNode,
  flattenVisibleTree,
  getAncestorPaths,
  getDefaultExpandedPaths,
  getFirstChildPath,
  getTreeParentPath,
  getVisibleNavigationTarget,
} from '../workspace-file-tree-model'

function artifact(path: string, label = path.split('/').at(-1) ?? path): WorkspaceArtifact {
  return { path, label, type: 'markdown', content: '' }
}

const roots = buildWorkspaceTree([
  artifact('references/source-fulltext.md'),
  artifact('output/report10.md'),
  artifact('datasets/set1.csv'),
  artifact('notes/lab.md'),
  artifact('analysis/gap.md'),
  artifact('output/report2.md'),
  artifact('references/papers/source-fulltext.md'),
  artifact('README.md'),
])

assert.deepEqual(
  roots.map(node => node.path),
  ['output', 'analysis', 'references', 'notes', 'datasets', 'README.md'],
  'top-level folders use semantic order, followed by other naturally sorted folders and files',
)

const output = findTreeNode(roots, 'output')
assert.equal(output?.kind, 'folder')
assert.equal(output?.kind === 'folder' ? output.descendantFileCount : 0, 2)
assert.deepEqual(
  output?.kind === 'folder' ? output.children.map(node => node.name) : [],
  ['report2.md', 'report10.md'],
  'file names use natural ordering',
)

const references = findTreeNode(roots, 'references')
assert.equal(references?.kind, 'folder')
assert.deepEqual(
  references?.kind === 'folder' ? references.children.map(node => node.path) : [],
  ['references/papers', 'references/source-fulltext.md'],
  'folders sort before files',
)
assert.equal(references?.kind === 'folder' ? references.descendantFileCount : 0, 2)

const directSource = findTreeNode(roots, 'references/source-fulltext.md')
const nestedSource = findTreeNode(roots, 'references/papers/source-fulltext.md')
assert.equal(directSource?.id, 'references/source-fulltext.md')
assert.equal(nestedSource?.id, 'references/papers/source-fulltext.md')
assert.notEqual(directSource?.id, nestedSource?.id, 'same file names in different folders remain distinct')

assert.deepEqual(
  getAncestorPaths('references/papers/2026/source.pdf'),
  ['references', 'references/papers', 'references/papers/2026'],
)
assert.equal(getTreeParentPath('references/papers/source-fulltext.md'), 'references/papers')
assert.equal(getTreeParentPath('references'), null)

const defaults = getDefaultExpandedPaths(roots)
assert.deepEqual(
  [...defaults],
  ['output', 'analysis', 'references', 'notes', 'datasets'],
  'all top-level folders open by default',
)
assert.equal(defaults.has('references/papers'), false, 'deep paper collections stay closed')

const visibleByDefault = flattenVisibleTree(roots, defaults)
assert.equal(
  visibleByDefault.some(item => item.node.path === 'references/papers'),
  true,
)
assert.equal(
  visibleByDefault.some(item => item.node.path === 'references/papers/source-fulltext.md'),
  false,
)
assert.deepEqual(
  visibleByDefault.find(item => item.node.path === 'references/papers'),
  {
    node: references?.kind === 'folder' ? references.children[0] : undefined,
    depth: 1,
    parentPath: 'references',
    indexInParent: 0,
    siblingCount: 2,
  },
)

const expandedPapers = new Set([...defaults, 'references/papers'])
assert.equal(
  flattenVisibleTree(roots, expandedPapers)
    .some(item => item.node.path === 'references/papers/source-fulltext.md'),
  true,
)

assert.equal(getFirstChildPath(roots, 'output'), 'output/report2.md')
assert.equal(getVisibleNavigationTarget(roots, defaults, 'output', 'first-child'), 'output/report2.md')
assert.equal(getVisibleNavigationTarget(roots, defaults, 'output', 'next'), 'output/report2.md')
assert.equal(getVisibleNavigationTarget(roots, defaults, 'analysis/gap.md', 'parent'), 'analysis')
assert.equal(getVisibleNavigationTarget(roots, defaults, 'output', 'previous'), null)

const canonicalized = buildWorkspaceTree([artifact('/workspace/analysis//scope.md')])
assert.equal(canonicalized[0]?.id, 'analysis')
assert.equal(findTreeNode(canonicalized, 'analysis/scope.md')?.id, 'analysis/scope.md')

assert.throws(
  () => buildWorkspaceTree([artifact('analysis'), artifact('analysis/scope.md')]),
  /both a file and a folder/,
)

const deepArtifacts = Array.from({ length: 500 }, (_, index) => artifact(
  `deep/l2/l3/l4/l5/l6/l7/l8/file${index + 1}.md`,
))
const deepTree = buildWorkspaceTree(deepArtifacts)
const deepRoot = findTreeNode(deepTree, 'deep')
assert.equal(deepRoot?.kind === 'folder' ? deepRoot.descendantFileCount : 0, 500)
assert.equal(
  findTreeNode(deepTree, 'deep/l2/l3/l4/l5/l6/l7/l8/file500.md')?.id,
  'deep/l2/l3/l4/l5/l6/l7/l8/file500.md',
)
assert.deepEqual(
  getAncestorPaths('deep/l2/l3/l4/l5/l6/l7/l8/file500.md'),
  ['deep', 'deep/l2', 'deep/l2/l3', 'deep/l2/l3/l4', 'deep/l2/l3/l4/l5', 'deep/l2/l3/l4/l5/l6', 'deep/l2/l3/l4/l5/l6/l7', 'deep/l2/l3/l4/l5/l6/l7/l8'],
)

console.log('workspace-file-tree-model:verify passed')
