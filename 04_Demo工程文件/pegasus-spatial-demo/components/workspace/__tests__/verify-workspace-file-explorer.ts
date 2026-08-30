import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const componentPath = fileURLToPath(new URL('../WorkspaceFileExplorer.tsx', import.meta.url))
const source = readFileSync(componentPath, 'utf8')
const panelSource = readFileSync(fileURLToPath(new URL('../WorkspacePanel.tsx', import.meta.url)), 'utf8')
const sidebarSource = readFileSync(fileURLToPath(new URL('../../shell/AppSidebar.tsx', import.meta.url)), 'utf8')
const contextSource = readFileSync(fileURLToPath(new URL('../../../contexts/ChatContext.tsx', import.meta.url)), 'utf8')

assert.match(source, /role="tree"/, 'Explorer exposes the ARIA tree container')
assert.match(source, /role="treeitem"/, 'Explorer exposes keyboard-addressable tree items')
assert.match(source, /aria-expanded=/, 'folder expansion is announced')
assert.match(source, /aria-selected=/, 'the active file is announced')
assert.match(source, /data-testid="workspace-file-explorer"/, 'the Explorer has a stable browser-test target')
assert.match(source, /overflow-x-hidden overflow-y-auto/, 'long paths cannot create a horizontal Explorer scroller')
assert.match(source, /role="tree"[^>]+className="w-full min-w-0"/, 'the tree is constrained to the sidebar width')
assert.match(source, /w-full min-w-0 max-w-full items-center overflow-hidden/, 'tree rows clip within the available sidebar width')
assert.doesNotMatch(source, /title=\{tooltip\}/, 'tree rows do not open path-sized native browser tooltips')
assert.match(source, /sci_pegasus_workspace_expanded:/, 'expanded folders are scoped by project')

for (const key of ['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End', 'Enter']) {
  assert.match(source, new RegExp(`event\\.key === '${key}'`), `${key} keyboard behavior is wired`)
}
assert.match(
  source,
  /nodeRefs\.current\.get\(path\)\?\.focus\(\)/,
  'keyboard navigation focuses an already-visible target in the key event boundary',
)

assert.match(source, /pathFingerprint/, 'tree rebuilding is keyed to the path set, not every streamed token')
assert.match(source, /normalizedInFlight/, 'Agent writes are reflected in the file tree')
assert.match(source, /筛选项目文件/, 'large workspaces have a path filter')
assert.match(source, /研究文件尚未生成/, 'empty projects have a useful Explorer state')
assert.match(source, /paperDirectoryLabel/, 'managed literature folders use a readable provider and short identity')
assert.match(source, /paperSummaries\.get\(node\.path\)\?\.title/, 'paper folders prefer the authoritative summary title')
assert.match(source, /parsePaperSummaryFile/, 'file filtering can match a containing paper title')
assert.match(source, /node\.artifact\.label/, 'managed literature files use semantic labels instead of raw filenames')
assert.match(panelSource, /WorkspaceBreadcrumb/, 'the viewer uses a single-file breadcrumb')
assert.doesNotMatch(panelSource, /artifacts\.map\(/, 'the old horizontal file-tab strip is gone')
assert.match(sidebarSource, /WorkspaceFileExplorer/, 'file navigation lives in the application sidebar')
assert.match(sidebarSource, /useLiteraturePaperSummaries/, 'paper titles are loaded with one conversation-scoped projection')
assert.match(sidebarSource, /role="tablist"/, 'project and file navigation are explicit modes')
assert.match(sidebarSource, /aria-label="文件" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"/, 'the sidebar file panel forms a hard width boundary')
assert.match(contextSource, /sci_pegasus_workspace_active_file:/, 'the active file is persisted per project')

console.log('workspace-file-explorer:verify passed')
