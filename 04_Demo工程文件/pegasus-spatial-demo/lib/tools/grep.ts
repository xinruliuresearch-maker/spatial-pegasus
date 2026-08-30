import { ToolResult } from '../types'
import { WorkspaceInstance } from '../workspace/types'

interface GrepInput {
  pattern: string
  path?: string
  literal?: boolean
  case_sensitive?: boolean
  context_lines?: number
  max_results?: number
}

const MAX_LINE_LENGTH = 500
const MAX_OUTPUT_LENGTH = 20_000

export async function executeGrep(
  input: GrepInput,
  workspace: WorkspaceInstance
): Promise<ToolResult> {
  const { pattern, path } = input
  if (!pattern) return { content: 'pattern cannot be empty', is_error: true }
  if (input.context_lines !== undefined && (!Number.isInteger(input.context_lines) || input.context_lines < 0 || input.context_lines > 3)) {
    return { content: 'context_lines must be an integer between 0 and 3', is_error: true }
  }
  if (input.max_results !== undefined && (!Number.isInteger(input.max_results) || input.max_results < 1 || input.max_results > 200)) {
    return { content: 'max_results must be an integer between 1 and 200', is_error: true }
  }
  const source = input.literal ? escapeRegex(pattern) : pattern
  let regex: RegExp
  try {
    regex = new RegExp(source, input.case_sensitive ? '' : 'i')
  } catch (error) {
    return { content: `Invalid regular expression: ${(error as Error).message}`, is_error: true }
  }

  const contextLines = Math.min(3, Math.max(0, Math.floor(input.context_lines ?? 0)))
  const maxResults = Math.min(200, Math.max(1, Math.floor(input.max_results ?? 50)))

  const files = path
    ? hasGlob(path) ? workspace.list(path) : workspace.exists(path) ? [path] : []
    : workspace.list()
  const results: string[] = []
  let totalMatches = 0
  let outputLength = 0
  let outputTruncated = false

  for (const filePath of files) {
    const stat = await workspace.stat(filePath)
    if (!stat || stat.kind !== 'text') continue
    const content = await workspace.readText(filePath)
    if (content === null) continue

    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) {
        totalMatches++
        if (results.length >= maxResults || outputTruncated) continue
        const block: string[] = []
        for (let lineIndex = Math.max(0, i - contextLines); lineIndex <= Math.min(lines.length - 1, i + contextLines); lineIndex++) {
          const marker = lineIndex === i ? ':' : '-'
          block.push(`${filePath}:${lineIndex + 1}${marker} ${truncateLine(lines[lineIndex])}`)
        }
        if (contextLines > 0) block.push('--')
        const rendered = block.join('\n')
        if (outputLength + rendered.length + 1 > MAX_OUTPUT_LENGTH) {
          outputTruncated = true
          continue
        }
        results.push(rendered)
        outputLength += rendered.length + 1
      }
    }
  }

  if (results.length === 0) {
    return { content: `No matches found for: ${pattern}` }
  }
  const truncated = outputTruncated || totalMatches > results.length
  return {
    content: [
      `Matched ${totalMatches} line(s); returned ${results.length}; truncated=${truncated}.`,
      ...results,
    ].join('\n'),
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function hasGlob(path: string): boolean {
  return /[*?]/.test(path)
}

function truncateLine(line: string): string {
  return line.length <= MAX_LINE_LENGTH ? line : `${line.slice(0, MAX_LINE_LENGTH)}…`
}
