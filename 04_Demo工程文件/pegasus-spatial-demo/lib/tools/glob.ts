import { ToolResult } from '../types'
import { WorkspaceInstance } from '../workspace/types'

interface GlobInput {
  pattern: string
  root?: 'output' | 'analysis' | 'notes' | 'references' | '.sci-pegasus'
  kind?: 'text' | 'raster' | 'document' | 'all'
  max_results?: number
}

export async function executeGlob(
  input: GlobInput,
  workspace: WorkspaceInstance
): Promise<ToolResult> {
  if (!input.pattern?.trim()) {
    return { content: 'pattern cannot be empty', is_error: true }
  }
  if (input.max_results !== undefined && (!Number.isInteger(input.max_results) || input.max_results < 1 || input.max_results > 500)) {
    return { content: 'max_results must be an integer between 1 and 500', is_error: true }
  }
  if (input.kind !== undefined && !['text', 'raster', 'document', 'all'].includes(input.kind)) {
    return { content: 'kind must be one of text, raster, document, or all', is_error: true }
  }
  if (input.root !== undefined && !['output', 'analysis', 'notes', 'references', '.sci-pegasus'].includes(input.root)) {
    return { content: 'root must be an allowed workspace namespace', is_error: true }
  }
  const limit = Math.min(500, Math.max(1, Math.floor(input.max_results ?? 100)))
  const kind = input.kind ?? 'all'
  const pattern = input.root
    ? `${input.root}/${input.pattern.replace(new RegExp(`^${escapeRegex(input.root)}/`), '')}`
    : input.pattern

  const matchedPaths = workspace.list(pattern)
  const matches: Array<{
    path: string
    kind: 'text' | 'raster' | 'document'
    mimeType: string
    sizeBytes?: number
  }> = []
  for (const path of matchedPaths) {
    const stat = await workspace.stat(path)
    if (!stat || (kind !== 'all' && stat.kind !== kind)) continue
    matches.push({ path: stat.path, kind: stat.kind, mimeType: stat.mimeType, sizeBytes: stat.sizeBytes })
  }

  if (matches.length === 0) {
    return { content: `No files matched pattern: ${input.pattern}` }
  }
  const visible = matches.slice(0, limit)
  const lines = visible.map(match => {
    const size = match.sizeBytes === undefined ? '' : ` · ${match.sizeBytes} bytes`
    return `${match.path} · ${match.kind} · ${match.mimeType}${size}`
  })
  return {
    content: [
      `Matched ${matches.length} real file(s); returned ${visible.length}; truncated=${matches.length > visible.length}.`,
      ...lines,
    ].join('\n'),
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
