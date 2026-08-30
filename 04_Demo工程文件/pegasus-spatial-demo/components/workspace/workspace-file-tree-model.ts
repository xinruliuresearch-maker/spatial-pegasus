import type { WorkspaceArtifact } from '@/hooks/useWorkspaceArtifacts'

export interface WorkspaceTreeFileNode {
  kind: 'file'
  /** Stable workspace-relative identity. */
  id: string
  path: string
  name: string
  parentPath: string | null
  artifact: WorkspaceArtifact
}

export interface WorkspaceTreeFolderNode {
  kind: 'folder'
  /** Stable workspace-relative identity. */
  id: string
  path: string
  name: string
  parentPath: string | null
  children: WorkspaceTreeNode[]
  descendantFileCount: number
}

export type WorkspaceTreeNode = WorkspaceTreeFileNode | WorkspaceTreeFolderNode

export interface FlattenedWorkspaceTreeNode {
  node: WorkspaceTreeNode
  depth: number
  parentPath: string | null
  indexInParent: number
  siblingCount: number
}

export type WorkspaceTreeNavigationDirection =
  | 'previous'
  | 'next'
  | 'parent'
  | 'first-child'

interface MutableFolderNode {
  kind: 'folder'
  id: string
  path: string
  name: string
  parentPath: string | null
  folders: Map<string, MutableFolderNode>
  files: Map<string, WorkspaceTreeFileNode>
}

const ROOT_FOLDER_ORDER = new Map<string, number>([
  ['output', 0],
  ['analysis', 1],
  ['references', 2],
  ['notes', 3],
])

const NATURAL_COLLATOR = new Intl.Collator('en-US', {
  numeric: true,
  sensitivity: 'base',
})

function normalizeWorkspacePath(rawPath: string): string {
  const normalized = rawPath
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/?workspace\//, '')
    .replace(/^\/+|\/+$/g, '')

  const segments = normalized.split('/').filter(segment => segment.length > 0 && segment !== '.')
  if (segments.length === 0 || segments.some(segment => segment === '..')) {
    throw new Error(`Invalid workspace artifact path: ${rawPath}`)
  }
  return segments.join('/')
}

function compareNames(left: string, right: string): number {
  const natural = NATURAL_COLLATOR.compare(left, right)
  return natural === 0 ? (left < right ? -1 : left > right ? 1 : 0) : natural
}

function compareNodes(
  left: WorkspaceTreeNode,
  right: WorkspaceTreeNode,
  isRoot: boolean,
): number {
  if (left.kind !== right.kind) return left.kind === 'folder' ? -1 : 1

  if (isRoot && left.kind === 'folder' && right.kind === 'folder') {
    const leftRank = ROOT_FOLDER_ORDER.get(left.name) ?? Number.MAX_SAFE_INTEGER
    const rightRank = ROOT_FOLDER_ORDER.get(right.name) ?? Number.MAX_SAFE_INTEGER
    if (leftRank !== rightRank) return leftRank - rightRank
  }

  return compareNames(left.name, right.name)
}

function createMutableFolder(
  path: string,
  name: string,
  parentPath: string | null,
): MutableFolderNode {
  return {
    kind: 'folder',
    id: path,
    path,
    name,
    parentPath,
    folders: new Map(),
    files: new Map(),
  }
}

function finalizeFolder(folder: MutableFolderNode): WorkspaceTreeFolderNode {
  const folders = Array.from(folder.folders.values(), child => finalizeFolder(child))
  const files = Array.from(folder.files.values())
  const children: WorkspaceTreeNode[] = [...folders, ...files]
    .sort((left, right) => compareNodes(left, right, false))

  return {
    kind: 'folder',
    id: folder.id,
    path: folder.path,
    name: folder.name,
    parentPath: folder.parentPath,
    children,
    descendantFileCount: children.reduce(
      (count, child) => count + (child.kind === 'file' ? 1 : child.descendantFileCount),
      0,
    ),
  }
}

/**
 * Builds a deterministic workspace tree. Artifact paths are canonicalized to
 * workspace-relative slash-separated paths and become the stable node IDs.
 */
export function buildWorkspaceTree(artifacts: readonly WorkspaceArtifact[]): WorkspaceTreeNode[] {
  const canonicalArtifacts = new Map<string, WorkspaceArtifact>()
  for (const artifact of artifacts) {
    const path = normalizeWorkspacePath(artifact.path)
    canonicalArtifacts.set(path, path === artifact.path ? artifact : { ...artifact, path })
  }

  const root = createMutableFolder('', '', null)
  const filePaths = new Set<string>()
  const folderPaths = new Set<string>()

  for (const [path, artifact] of canonicalArtifacts) {
    const segments = path.split('/')
    let parent = root

    for (let index = 0; index < segments.length - 1; index += 1) {
      const name = segments[index]
      const folderPath = segments.slice(0, index + 1).join('/')
      if (filePaths.has(folderPath)) {
        throw new Error(`Workspace path is both a file and a folder: ${folderPath}`)
      }

      let folder = parent.folders.get(name)
      if (!folder) {
        folder = createMutableFolder(folderPath, name, parent.path || null)
        parent.folders.set(name, folder)
        folderPaths.add(folderPath)
      }
      parent = folder
    }

    if (folderPaths.has(path)) {
      throw new Error(`Workspace path is both a file and a folder: ${path}`)
    }

    const name = segments.at(-1) as string
    parent.files.set(name, {
      kind: 'file',
      id: path,
      path,
      name,
      parentPath: parent.path || null,
      artifact,
    })
    filePaths.add(path)
  }

  const rootFolders = Array.from(root.folders.values(), folder => finalizeFolder(folder))
  const rootFiles = Array.from(root.files.values())
  return [...rootFolders, ...rootFiles].sort((left, right) => compareNodes(left, right, true))
}

/** Returns strict ancestors from the top-level directory to the direct parent. */
export function getAncestorPaths(path: string): string[] {
  const segments = normalizeWorkspacePath(path).split('/')
  return segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join('/'))
}

/**
 * Opens only top-level folders by default. This reveals the workspace shape
 * while leaving potentially large branches such as references/papers closed.
 */
export function getDefaultExpandedPaths(roots: readonly WorkspaceTreeNode[]): Set<string> {
  return new Set(
    roots
      .filter((node): node is WorkspaceTreeFolderNode => node.kind === 'folder')
      .map(node => node.path),
  )
}

export function findTreeNode(
  roots: readonly WorkspaceTreeNode[],
  path: string,
): WorkspaceTreeNode | undefined {
  const canonicalPath = normalizeWorkspacePath(path)
  const segments = canonicalPath.split('/')
  let siblings: readonly WorkspaceTreeNode[] = roots
  let current: WorkspaceTreeNode | undefined

  for (let index = 0; index < segments.length; index += 1) {
    const candidatePath = segments.slice(0, index + 1).join('/')
    current = siblings.find(node => node.path === candidatePath)
    if (!current) return undefined
    if (index < segments.length - 1) {
      if (current.kind !== 'folder') return undefined
      siblings = current.children
    }
  }

  return current
}

export function flattenVisibleTree(
  roots: readonly WorkspaceTreeNode[],
  expanded: ReadonlySet<string>,
): FlattenedWorkspaceTreeNode[] {
  const flattened: FlattenedWorkspaceTreeNode[] = []

  const visit = (
    nodes: readonly WorkspaceTreeNode[],
    depth: number,
    parentPath: string | null,
  ) => {
    nodes.forEach((node, index) => {
      flattened.push({
        node,
        depth,
        parentPath,
        indexInParent: index,
        siblingCount: nodes.length,
      })
      if (node.kind === 'folder' && expanded.has(node.path)) {
        visit(node.children, depth + 1, node.path)
      }
    })
  }

  visit(roots, 0, null)
  return flattened
}

export function getTreeParentPath(path: string): string | null {
  const ancestors = getAncestorPaths(path)
  return ancestors.at(-1) ?? null
}

export function getFirstChildPath(
  roots: readonly WorkspaceTreeNode[],
  path: string,
): string | null {
  const node = findTreeNode(roots, path)
  return node?.kind === 'folder' ? node.children[0]?.path ?? null : null
}

/**
 * Resolves focus movement without coupling the tree model to DOM events.
 * `first-child` is limited to an expanded branch because it represents a
 * visible keyboard target; use getFirstChildPath when visibility is irrelevant.
 */
export function getVisibleNavigationTarget(
  roots: readonly WorkspaceTreeNode[],
  expanded: ReadonlySet<string>,
  currentPath: string,
  direction: WorkspaceTreeNavigationDirection,
): string | null {
  if (direction === 'parent') return getTreeParentPath(currentPath)
  if (direction === 'first-child') {
    return expanded.has(currentPath) ? getFirstChildPath(roots, currentPath) : null
  }

  const visible = flattenVisibleTree(roots, expanded)
  const currentIndex = visible.findIndex(item => item.node.path === currentPath)
  if (currentIndex < 0) return null
  const targetIndex = direction === 'previous' ? currentIndex - 1 : currentIndex + 1
  return visible[targetIndex]?.node.path ?? null
}
