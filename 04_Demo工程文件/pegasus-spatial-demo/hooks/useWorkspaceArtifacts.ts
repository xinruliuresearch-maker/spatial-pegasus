'use client'

import { useMemo } from 'react'
import type { DisplayPart } from '@/lib/types'
import { isInternalWorkspacePath } from '@/lib/workspace/path-policy'
import type {
  FileEntry,
  WorkspaceDocumentProvenance,
  WorkspaceDocumentSource,
} from '@/lib/workspace/types'

export interface WorkspaceArtifact {
  path: string
  label: string
  type: 'markdown' | 'text' | 'document' | 'image' | 'model3d' | 'world'
  content: string
  mimeType?: string
  gridfsPending?: boolean
  filename?: string
  sizeBytes?: number
  sha256?: string
  assetId?: string
  width?: number
  height?: number
  revision?: number
  createdAt?: string
  updatedAt?: string
  source?: WorkspaceDocumentSource
  provenance?: WorkspaceDocumentProvenance
}

export interface ConversationArtifactFields {
  output?: {
    files?: Record<string, FileEntry>
    manifest?: Record<string, { current_version: number; versions: { v: number; path: string; note: string; created_at: string }[] }>
  }
}

const PATH_LABELS: Record<string, string> = {
  'analysis/research-scope.md': '研究范围',
  'analysis/literature-map.md': '文献地图',
  'analysis/research-gaps.md': 'Research Gaps',
  'references/evidence-ledger.md': '证据台账',
  'output/research-report.md': '研究报告',
  'output/hypotheses.md': '可验证假设',
}

function normalizePath(path: string): string {
  return path.replace(/^\/workspace\//, '').replace(/^workspace\//, '').replace(/^\//, '')
}

function inferType(path: string): WorkspaceArtifact['type'] {
  const lower = path.toLowerCase()
  if (/\.(?:png|jpe?g|webp|gif|avif)$/.test(lower)) return 'image'
  if (/\.(?:glb|gltf)$/.test(lower)) return 'model3d'
  if (/^output\/spatial\/worlds\/[^/]+\/manifest\.json$/.test(lower)) return 'world'
  return lower.endsWith('.md') ? 'markdown' : 'text'
}

const LITERATURE_FILE_LABELS: Readonly<Record<string, string>> = {
  'source-fulltext.md': '结构化全文',
  'original.pdf': '原始 PDF',
  'metadata.json': '论文信息',
  'provenance.json': '来源与溯源',
  'parsed/fulltext.md': '可检索全文',
  'parsed/blocks.jsonl': '页级文本块',
  'parsed/parser-provenance.json': '解析记录',
}

function labelFor(path: string): string {
  if (path.startsWith('references/papers/')) {
    const directoryRelative = path.split('/').slice(3).join('/')
    const literatureLabel = LITERATURE_FILE_LABELS[directoryRelative]
    if (literatureLabel) return literatureLabel
  }
  return PATH_LABELS[path] ?? path.split('/').pop() ?? path
}

function artifactRank(type: WorkspaceArtifact['type']): number {
  if (type === 'image' || type === 'model3d' || type === 'world') return 0
  if (type === 'markdown') return 0
  if (type === 'document') return 1
  return 2
}

export const MUTATOR_TOOLS: ReadonlySet<string> = new Set([
  'Write',
  'Edit',
  'GenerateImage',
  'CreateObject3D',
  'CreateWorld3D',
  'ArxivSearchPapers',
  'ArxivFetchPaper',
  'SciverseSearchPapers',
  'SciverseSearchEvidence',
  'SciverseFetchPaper',
  'SciverseListRelations',
])

// Spatial tools return durable Job/asset receipts, not the bytes of the file at
// their target path. Their real artifacts arrive through the authoritative
// Workspace projection, so never let a persisted receipt shadow that file.
const TIMELINE_ARTIFACT_TOOLS: ReadonlySet<string> = new Set([
  'Write',
  'Edit',
  'ArxivSearchPapers',
  'ArxivFetchPaper',
  'SciverseSearchPapers',
  'SciverseSearchEvidence',
  'SciverseFetchPaper',
  'SciverseListRelations',
])

export function useWorkspaceArtifacts(parts: DisplayPart[]): WorkspaceArtifact[] {
  return useMemo(() => {
    const artifacts = new Map<string, WorkspaceArtifact>()
    for (const part of parts) {
      if (
        part.type !== 'tool_call'
        || part.pending
        || part.is_error
        || !TIMELINE_ARTIFACT_TOOLS.has(part.tool)
        || !part.file_path
        || part.content === undefined
      ) continue
      const path = normalizePath(part.file_path)
      if (isInternalWorkspacePath(path)) continue
      artifacts.set(path, {
        path,
        label: labelFor(path),
        type: inferType(path),
        content: part.content,
      })
    }
    return Array.from(artifacts.values()).sort((a, b) => artifactRank(a.type) - artifactRank(b.type))
  }, [parts])
}

export function buildArtifactsFromDB(doc: ConversationArtifactFields): WorkspaceArtifact[] {
  const files = doc.output?.files
  if (!files) return []
  const archived = new Set<string>()
  for (const manifest of Object.values(doc.output?.manifest ?? {})) {
    for (const version of manifest.versions ?? []) archived.add(version.path)
  }

  return Object.entries(files)
    .flatMap(([rawPath, entry]): WorkspaceArtifact[] => {
      const path = normalizePath(rawPath)
      if (!entry || isInternalWorkspacePath(path) || archived.has(path)) return []
      if (entry.storage === 'asset' && entry.kind === 'raster') {
        return [{
          path,
          label: labelFor(path),
          type: 'image',
          content: '',
          mimeType: entry.mime_type,
          sizeBytes: entry.size_bytes,
          assetId: entry.asset_id,
          width: entry.width,
          height: entry.height,
          revision: entry.version,
          createdAt: entry.created_at,
          updatedAt: entry.updated_at,
        }]
      }
      if (entry.kind === 'document') {
        const type = inferType(path)
        return [{
          path,
          label: entry.filename || labelFor(path),
          type: type === 'model3d' || type === 'world' ? type : 'document',
          content: '',
          mimeType: entry.mime_type,
          gridfsPending: type === 'world' ? true : undefined,
          filename: entry.filename,
          sizeBytes: entry.size_bytes,
          sha256: entry.sha256,
          revision: entry.version,
          createdAt: entry.created_at,
          updatedAt: entry.updated_at,
          source: entry.source,
          provenance: entry.provenance,
        }]
      }
      return [{
        path,
        label: labelFor(path),
        type: inferType(path),
        content: '',
        mimeType: entry.mime_type,
        gridfsPending: true,
        revision: entry.version,
        createdAt: entry.created_at,
        updatedAt: entry.updated_at,
      }]
    })
    .sort((a, b) => artifactRank(a.type) - artifactRank(b.type))
}
