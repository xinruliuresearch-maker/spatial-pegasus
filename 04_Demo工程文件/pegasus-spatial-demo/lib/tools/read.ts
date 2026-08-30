import { ToolResult, SkillDefinition } from '../types'
import { WorkspaceInstance } from '../workspace/types'

interface ReadInput {
  file_path: string
  offset?: number
  limit?: number
}

export async function executRead(
  input: ReadInput,
  workspace: WorkspaceInstance,
  skills: Map<string, SkillDefinition>
): Promise<ToolResult> {
  const { file_path, offset, limit } = input

  if (typeof file_path !== 'string' || !file_path.trim()) {
    return { content: 'file_path must be a non-empty string.', is_error: true }
  }
  if (offset !== undefined && (!Number.isInteger(offset) || offset < 1)) {
    return { content: 'offset must be a positive integer (1-based).', is_error: true }
  }
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    return { content: 'limit must be a positive integer.', is_error: true }
  }

  // Check if reading a skill reference file: /skills/<name>/references/<file>
  const skillRefMatch = file_path.match(/^\/skills\/([^/]+)\/references\/(.+)$/)
  if (skillRefMatch) {
    const [, skillName, refFile] = skillRefMatch
    const skill = skills.get(skillName)
    if (!skill) {
      return { content: `Skill not found: ${skillName}`, is_error: true }
    }

    // Read only from this skill's own references root. Decode URL-escaped
    // virtual paths before validation so `%2e%2e` and encoded absolute paths
    // cannot bypass the same containment check as their plain-text forms.
    const fs = await import('fs/promises')
    const path = await import('path')
    let decodedRefFile: string
    try {
      decodedRefFile = decodeURIComponent(refFile)
    } catch {
      return { content: `Invalid skill reference path: ${refFile}`, is_error: true }
    }

    if (!decodedRefFile || decodedRefFile.includes('\0')) {
      return { content: `Invalid skill reference path: ${refFile}`, is_error: true }
    }

    const referenceRoot = path.resolve(skill.dirPath, 'references')
    const refPath = path.resolve(referenceRoot, decodedRefFile)
    if (!isPathWithin(referenceRoot, refPath, path)) {
      return { content: `Skill reference path escapes references root: ${refFile}`, is_error: true }
    }

    try {
      // realpath closes the symlink escape that lexical path.resolve cannot.
      const [realSkillRoot, realRoot, realRefPath] = await Promise.all([
        fs.realpath(skill.dirPath),
        fs.realpath(referenceRoot),
        fs.realpath(refPath),
      ])
      if (
        !isPathWithin(realSkillRoot, realRoot, path)
        || !isPathWithin(realRoot, realRefPath, path)
      ) {
        return { content: `Skill reference path escapes references root: ${refFile}`, is_error: true }
      }
      const content = await fs.readFile(realRefPath, 'utf-8')
      return { content: formatWithLineNumbers(content, offset, limit) }
    } catch {
      return { content: `Reference file not found: ${refFile}`, is_error: true }
    }
  }

  const stat = await workspace.stat(file_path)
  if (stat?.kind === 'document') {
    const document = await workspace.readDocument(file_path)
    if (!document) return { content: `Document unavailable: ${file_path}`, is_error: true }
    const source = document.source.canonical_url
      ? `${document.source.provider} · ${document.source.canonical_url}`
      : document.source.provider
    return {
      content: [
        `[Document: ${document.path}]`,
        `filename: ${document.filename}`,
        `mime_type: ${document.mimeType}`,
        `size_bytes: ${document.sizeBytes}`,
        `sha256: ${document.sha256}`,
        `source: ${source}`,
        `retrieved_at: ${document.provenance.retrieved_at}`,
        document.provenance.license ? `license: ${document.provenance.license}` : undefined,
        document.provenance.provenance_path
          ? `provenance_path: ${document.provenance.provenance_path}`
          : undefined,
        'Binary document bytes are intentionally not returned. Read the parsed Markdown/JSON artifact for full-text analysis.',
      ].filter((line): line is string => Boolean(line)).join('\n'),
    }
  }
  if (stat?.kind === 'raster') {
    const media = await workspace.readRaster(file_path)
    if (!media) return { content: `Image unavailable: ${file_path}`, is_error: true }
    return {
      content: `[Raster image: ${file_path}, ${media.mimeType}, ${media.width}×${media.height}, ${Math.round(media.sizeBytes / 1024)}KB]`,
      media: [media],
    }
  }

  // SVG remains source code and is returned with line numbers.
  const content = await workspace.readText(file_path)
  if (content === null) return { content: `File not found: ${file_path}`, is_error: true }
  const ext = file_path.split('.').pop()?.toLowerCase()

  // For SVG/XML files with embedded base64 images (post-assembly), truncate the
  // base64 data to prevent blowing up the LLM context window.
  // A typical assembled SVG/XML can be 500KB-1MB+ due to embedded icon PNGs.
  if ((ext === 'svg' || ext === 'xml') && content.length > 50_000) {
    const truncated = stripEmbeddedBase64(content)
    if (truncated.length < content.length) {
      return { content: formatWithLineNumbers(truncated, offset, limit) }
    }
  }

  return { content: formatWithLineNumbers(content, offset, limit) }
}

function isPathWithin(
  root: string,
  candidate: string,
  path: typeof import('path'),
): boolean {
  const relative = path.relative(root, candidate)
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
}

/**
 * Strip embedded base64 data URIs from SVG/XML content to prevent context explosion.
 * Handles both standard and URL-encoded data URI separators.
 */
function stripEmbeddedBase64(content: string): string {
  return content
    // Standard data URI: data:image/png;base64,iVBOR...
    .replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]{200,}/g, (match) => {
      const kbSize = Math.round(match.length * 0.75 / 1024)
      return `data:image/...;base64,[${kbSize}KB embedded image data stripped]`
    })
    // URL-encoded separator: data:image/png%3Bbase64,iVBOR...
    .replace(/data:image\/[^%]+%3Bbase64,[A-Za-z0-9+/=]{200,}/g, (match) => {
      const kbSize = Math.round(match.length * 0.75 / 1024)
      return `data:image/...%3Bbase64,[${kbSize}KB embedded image data stripped]`
    })
}

function formatWithLineNumbers(content: string, offset?: number, limit?: number): string {
  const lines = content.split('\n')
  const start = (offset ?? 1) - 1
  const end = limit ? start + limit : lines.length

  return lines
    .slice(start, end)
    .map((line, i) => `${String(start + i + 1).padStart(6)}\t${line}`)
    .join('\n')
}
