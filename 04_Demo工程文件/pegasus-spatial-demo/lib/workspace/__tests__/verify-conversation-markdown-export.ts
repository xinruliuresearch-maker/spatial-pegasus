import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  buildConversationWorkspaceMarkdownExport,
  writeConversationWorkspaceMarkdownExport,
  type ConversationWorkspaceMarkdownExportInput,
  type ConversationWorkspaceMarkdownExportPlan,
} from '../export-markdown'
import type { FileEntry } from '../types'
import type {
  WorkspaceFileSnapshot,
  WorkspaceFileVisibility,
} from '../multi-agent/types'

function digest(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex')
}

function authoritativeFile(input: {
  path: string
  objectId: string
  content: Buffer | string
  visibility?: WorkspaceFileVisibility
  ownerAgentId?: string
  kind?: WorkspaceFileSnapshot['metadata']['kind']
  mimeType?: string
}): WorkspaceFileSnapshot {
  const content = Buffer.isBuffer(input.content) ? input.content : Buffer.from(input.content)
  return {
    workspace_id: 'workspace_export_test',
    path: input.path,
    revision: 3,
    version_id: `version_${input.objectId}`,
    visibility: input.visibility ?? 'public',
    owner_agent_id: input.ownerAgentId,
    storage_ref: { driver: 'gridfs', object_id: input.objectId },
    metadata: {
      kind: input.kind ?? 'text',
      mime_type: input.mimeType ?? 'text/markdown',
      size_bytes: content.byteLength,
      sha256: digest(content),
    },
    writer: {
      team_id: 'team_export_test',
      agent_id: input.ownerAgentId ?? 'agent_root',
      run_id: 'run_export_test',
      execution_fence_token: 'fence_export_test',
    },
    created_at: new Date('2026-08-10T00:00:00.000Z'),
    updated_at: new Date('2026-08-10T01:00:00.000Z'),
  }
}

function input(overrides: Partial<ConversationWorkspaceMarkdownExportInput> = {}): ConversationWorkspaceMarkdownExportInput {
  return {
    conversationId: 'conversation_export_test',
    userId: 'user_export_test',
    title: 'Export test',
    workspaceId: 'workspace_export_test',
    teamId: 'team_export_test',
    authoritativeFiles: [],
    legacyFiles: {},
    exportedAt: new Date('2026-08-11T00:00:00.000Z'),
    ...overrides,
  }
}

async function verifyPrecedencePartitionsAndInventory(): Promise<ConversationWorkspaceMarkdownExportPlan> {
  const authoritativeJson = '{"source":"authoritative","ticks":"```"}'
  const privateText = 'private working notes\n'
  const legacyMarkdown = '# Legacy note\n'
  const managedText = '# Must remain inventory only\n'
  const binaryPdf = Buffer.from('%PDF-not-read')
  const legacyFiles: Record<string, FileEntry> = {
    'analysis/result.json': {
      gridfs_id: 'legacy_shadowed',
      mime_type: 'application/json',
    },
    'notes/legacy.md': {
      gridfs_id: 'legacy_markdown',
      mime_type: 'text/markdown',
      version: 2,
    },
    'references/searches/search-audit.json': {
      gridfs_id: 'legacy_managed',
      mime_type: 'application/json',
    },
    'output/legacy-image.png': {
      storage: 'asset',
      kind: 'raster',
      asset_id: 'asset_legacy',
      mime_type: 'image/png',
      width: 20,
      height: 20,
      size_bytes: 80,
    },
  }
  const bytes = new Map<string, Buffer>([
    ['authoritative_json', Buffer.from(authoritativeJson)],
    ['private_text', Buffer.from(privateText)],
    ['legacy_markdown', Buffer.from(legacyMarkdown)],
    ['managed_text', Buffer.from(managedText)],
    ['binary_pdf', binaryPdf],
  ])
  const reads: string[] = []
  const plan = await buildConversationWorkspaceMarkdownExport(input({
    authoritativeFiles: [
      authoritativeFile({
        path: 'analysis/result.json',
        objectId: 'authoritative_json',
        content: authoritativeJson,
        mimeType: 'application/json',
      }),
      authoritativeFile({
        path: '.sci-pegasus/agents/agent_a/draft.txt',
        objectId: 'private_text',
        content: privateText,
        visibility: 'agent_private',
        ownerAgentId: 'agent_a',
        mimeType: 'text/plain',
      }),
      authoritativeFile({
        path: 'references/papers/paper_a/source-fulltext.md',
        objectId: 'managed_text',
        content: managedText,
        visibility: 'managed_reference',
        mimeType: 'text/markdown',
      }),
      authoritativeFile({
        path: 'output/report.pdf',
        objectId: 'binary_pdf',
        content: binaryPdf,
        kind: 'document',
        mimeType: 'application/pdf',
      }),
    ],
    legacyFiles,
  }), async request => {
    reads.push(request.objectId)
    return bytes.get(request.objectId) ?? null
  })

  assert.deepEqual(reads, ['private_text', 'authoritative_json', 'legacy_markdown'])
  assert.equal(plan.issue_count, 0)
  assert.deepEqual(plan.files.map(file => file.path), [
    'agent-private/agent_a/draft.txt.md',
    'public/analysis/result.json.md',
    'public/notes/legacy.md',
  ])
  assert.ok(plan.files.every(file => file.path.endsWith('.md')))
  assert.equal(plan.files.find(file => file.path.endsWith('result.json.md'))?.content,
    '````json\n{"source":"authoritative","ticks":"```"}\n````\n')
  assert.equal(plan.files.find(file => file.path.endsWith('draft.txt.md'))?.content, privateText)
  assert.equal(plan.files.find(file => file.path.endsWith('notes/legacy.md'))?.content, legacyMarkdown)

  const authoritativeRecord = plan.records.find(record => record.source_path === 'analysis/result.json')
  assert.equal(authoritativeRecord?.source, 'authoritative')
  assert.equal(authoritativeRecord?.revision, 3)
  assert.equal(authoritativeRecord?.declared_sha256, digest(authoritativeJson))
  assert.equal(authoritativeRecord?.observed_sha256, digest(authoritativeJson))
  assert.equal(plan.records.find(record => record.source_path.includes('source-fulltext'))?.status,
    'manifest_only_managed_reference')
  assert.equal(plan.records.find(record => record.source_path === 'output/report.pdf')?.status,
    'manifest_only_binary')
  assert.equal(plan.records.find(record => record.source_path.endsWith('legacy-image.png'))?.status,
    'manifest_only_unsupported_storage')
  assert.equal(plan.records.find(record => record.source_path.includes('search-audit'))?.status,
    'manifest_only_managed_reference')
  assert.match(plan.manifest, /authoritative WorkspaceFile heads replace same-path legacy/)
  assert.match(plan.manifest, /agent_private/)
  assert.match(plan.manifest, /manifest_only_managed_reference/)
  return plan
}

async function verifyIntegrityAndMissingContentAreExplicit(): Promise<void> {
  const expected = 'expected content'
  const mismatched = authoritativeFile({
    path: 'analysis/mismatch.md',
    objectId: 'mismatch',
    content: expected,
  })
  const missing = authoritativeFile({
    path: 'analysis/missing.md',
    objectId: 'missing',
    content: 'missing',
  })
  const plan = await buildConversationWorkspaceMarkdownExport(input({
    authoritativeFiles: [mismatched, missing],
  }), async request => {
    if (request.objectId === 'mismatch') return Buffer.from('different content')
    return null
  })
  assert.equal(plan.files.length, 0)
  assert.equal(plan.issue_count, 2)
  assert.equal(plan.records.find(record => record.source_path.endsWith('mismatch.md'))?.status,
    'integrity_mismatch')
  assert.equal(plan.records.find(record => record.source_path.endsWith('missing.md'))?.status,
    'missing_content')
  assert.match(plan.manifest, /Read\/integrity issues: 2/)
}

async function verifyUnsafeAndCollidingPathsFailClosed(): Promise<void> {
  await assert.rejects(
    buildConversationWorkspaceMarkdownExport(input({
      legacyFiles: {
        '../escape.md': { gridfs_id: 'escape', mime_type: 'text/markdown' },
      },
    }), async () => Buffer.from('escape')),
    /unsafe segment/,
  )
  await assert.rejects(
    buildConversationWorkspaceMarkdownExport(input({
      authoritativeFiles: [authoritativeFile({
        path: '.sci-pegasus/agents/agent_a/private.md',
        objectId: 'owner_mismatch',
        content: 'private',
        visibility: 'agent_private',
        ownerAgentId: 'agent_b',
      })],
    }), async () => Buffer.from('private')),
    /inconsistent ownership/,
  )
  await assert.rejects(
    buildConversationWorkspaceMarkdownExport(input({
      authoritativeFiles: [
        authoritativeFile({ path: 'notes/A.md', objectId: 'upper', content: 'A' }),
        authoritativeFile({ path: 'notes/a.md', objectId: 'lower', content: 'a' }),
      ],
    }), async request => Buffer.from(request.objectId === 'upper' ? 'A' : 'a')),
    /output path collision/,
  )
  const invalidMetadata = authoritativeFile({
    path: 'analysis/invalid-metadata.md',
    objectId: 'invalid_metadata',
    content: 'invalid',
  })
  invalidMetadata.metadata.sha256 = 'not-a-sha256'
  await assert.rejects(
    buildConversationWorkspaceMarkdownExport(input({
      authoritativeFiles: [invalidMetadata],
    }), async () => Buffer.from('invalid')),
    /invalid immutable metadata/,
  )
}

async function verifyAtomicFreshDirectoryWrite(plan: ConversationWorkspaceMarkdownExportPlan): Promise<void> {
  const parent = await mkdtemp(join(tmpdir(), 'sci-pegasus-export-test-'))
  try {
    const destination = join(parent, 'conversation-export')
    assert.equal(await writeConversationWorkspaceMarkdownExport(plan, destination), resolve(destination))
    assert.equal(
      await readFile(join(destination, 'public/analysis/result.json.md'), 'utf8'),
      plan.files.find(file => file.path === 'public/analysis/result.json.md')?.content,
    )
    assert.equal(await readFile(join(destination, 'MANIFEST.md'), 'utf8'), plan.manifest)
    await writeFile(join(destination, 'sentinel'), 'preserve me')
    await assert.rejects(
      writeConversationWorkspaceMarkdownExport(plan, destination),
      /already exists/,
    )
    assert.equal(await readFile(join(destination, 'sentinel'), 'utf8'), 'preserve me')
    assert.deepEqual((await readdir(parent)).sort(), ['conversation-export'])

    const maliciousPlan: ConversationWorkspaceMarkdownExportPlan = {
      ...plan,
      files: [{ path: '../escape.md', content: 'escape' }],
    }
    await assert.rejects(
      writeConversationWorkspaceMarkdownExport(maliciousPlan, join(parent, 'malicious')),
      /unsafe segment/,
    )
    assert.deepEqual((await readdir(parent)).sort(), ['conversation-export'])
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
}

async function verifyCliContainsNoMongoMutationCalls(): Promise<void> {
  const script = await readFile(
    resolve(process.cwd(), 'scripts/export-conversation-workspace-markdown.ts'),
    'utf8',
  )
  assert.doesNotMatch(script, /(?:Conversation|AgentTeamModel|WorkspaceFile|WorkspaceFileRevision)\.(?:create|insert|update|delete|replace|findOneAndUpdate|bulkWrite)\s*\(/)
  assert.doesNotMatch(script, /ensureTeam\s*\(/)
  assert.doesNotMatch(script, /writeFileToGridFS|writeDocumentToGridFS|deleteConversationFiles/)
  assert.match(script, /\.findOne\(/)
  assert.match(script, /\.find\(/)
}

async function main(): Promise<void> {
  const plan = await verifyPrecedencePartitionsAndInventory()
  await verifyIntegrityAndMissingContentAreExplicit()
  await verifyUnsafeAndCollidingPathsFailClosed()
  await verifyAtomicFreshDirectoryWrite(plan)
  await verifyCliContainsNoMongoMutationCalls()
  console.log('Conversation Workspace Markdown export verification passed.')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
