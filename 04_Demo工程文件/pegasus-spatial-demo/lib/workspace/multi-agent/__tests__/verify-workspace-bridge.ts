import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { executeEdit } from '../../../tools/edit'
import { executeWrite } from '../../../tools/write'
import { materialsDiscoveryWorkspace } from '../../definitions/materials-discovery'
import {
  createWorkspaceInstance,
  type WorkspaceInstancePersistence,
} from '../../instance'
import { buildVersionArchivePath } from '../../path-policy'
import type { FileEntry, ManifestEntry, WorkspaceInstance } from '../../types'
import {
  createMultiAgentWorkspaceBridge,
  InMemoryMultiAgentWorkspaceStore,
  MultiAgentWorkspaceRepository,
  WorkspaceAclError,
  WorkspaceRevisionConflictError,
  type WorkspaceActor,
  type WorkspaceWriterProvenance,
} from '..'

const TEAM = 'team_bridge_test'
const ROOT = 'agent_root'
let objectSequence = 0
let versionSequence = 0

function actor(agentId = ROOT, managedReferenceTool = false): WorkspaceActor {
  return {
    teamId: TEAM,
    agentId,
    rootAgentId: ROOT,
    role: agentId === ROOT ? 'root' : 'member',
    managedReferenceTool,
  }
}

function writer(agentId = ROOT, runId = `run_${agentId}`): WorkspaceWriterProvenance {
  return {
    team_id: TEAM,
    agent_id: agentId,
    task_id: `task_${agentId}`,
    run_id: runId,
    execution_fence_token: `fence_${runId}`,
  }
}

function repository(): MultiAgentWorkspaceRepository {
  return new MultiAgentWorkspaceRepository({
    store: new InMemoryMultiAgentWorkspaceStore(),
    versionId: () => `bridge_version_${++versionSequence}`,
    fenceValidator: ({ writer: provenance }) => provenance.execution_fence_token.startsWith('fence_'),
  })
}

function legacyText(gridfsId: string, version = 1): FileEntry {
  return {
    storage: 'gridfs',
    kind: 'text',
    gridfs_id: gridfsId,
    mime_type: 'text/markdown',
    version,
    created_at: '2026-08-08T00:00:00.000Z',
  }
}

function persistence(bytes: Map<string, Buffer>): WorkspaceInstancePersistence {
  return {
    async writeTextFile(_conversationId, _path, content) {
      const id = `bridge_gridfs_${++objectSequence}`
      bytes.set(id, Buffer.from(content, 'utf8'))
      return id
    },
    async writeDocumentFile() {
      throw new Error('document persistence is not used by this test')
    },
    async readTextFile(id) {
      return bytes.get(id)?.toString('utf8') ?? null
    },
  }
}

function bytesReader(bytes: Map<string, Buffer>) {
  return async (_path: string, entry: FileEntry): Promise<Buffer | null> => {
    if ('gridfs_id' in entry) return bytes.get(entry.gridfs_id) ?? null
    return null
  }
}

async function verifyLazyImportArchiveAndExactTextMetadata(): Promise<void> {
  const repo = repository()
  const workspaceId = 'workspace_bridge_lazy_import'
  const path = 'analysis/finding.md'
  const oldContent = 'legacy'
  const newContent = '新材料 insight'
  const bytes = new Map<string, Buffer>([['legacy_gridfs', Buffer.from(oldContent)]])
  const legacyFiles = { [path]: legacyText('legacy_gridfs') }
  const bridge = await createMultiAgentWorkspaceBridge({
    repository: repo,
    workspaceId,
    actor: actor(ROOT, true),
    writer: writer(ROOT, 'run_lazy_import'),
    legacyFiles,
    readEntryBytes: bytesReader(bytes),
  })

  assert.equal(await repo.store.getFile(workspaceId, path), null, 'legacy content is imported lazily')
  let projected: Record<string, FileEntry> = {}
  const workspace = createWorkspaceInstance(
    materialsDiscoveryWorkspace,
    bridge.projectedFiles,
    {},
    {
      conversationId: workspaceId,
      onFileMutations: bridge.onFileMutations,
      onFilesUpdate: async files => { projected = { ...files } },
    },
    persistence(bytes),
  )
  await workspace.writeText(path, newContent, 'revised finding')

  const head = await repo.getFile(workspaceId, path, actor())
  assert.equal(head?.revision, 2, 'legacy head becomes revision 1 before the replacement CAS')
  assert.equal(head?.metadata.size_bytes, Buffer.byteLength(newContent))
  assert.equal(
    head?.metadata.sha256,
    createHash('sha256').update(newContent).digest('hex'),
  )
  const archivePath = buildVersionArchivePath(path, 1)
  assert.equal((await repo.getFile(workspaceId, archivePath, actor()))?.metadata.sha256,
    createHash('sha256').update(oldContent).digest('hex'))
  assert.ok(projected[path])
  assert.ok(projected[archivePath], 'legacy Conversation state remains an updated projection')
}

async function verifyStaleWholeMapCannotOverwriteAuthoritativeHead(): Promise<void> {
  const repo = repository()
  const workspaceId = 'workspace_bridge_conflict'
  const path = 'analysis/shared.md'
  const bytes = new Map<string, Buffer>([['shared_legacy', Buffer.from('base')]])
  const legacyFiles = { [path]: legacyText('shared_legacy') }
  const [leftBridge, rightBridge] = await Promise.all([
    createMultiAgentWorkspaceBridge({
      repository: repo,
      workspaceId,
      actor: actor(),
      writer: writer(ROOT, 'run_left'),
      legacyFiles,
      readEntryBytes: bytesReader(bytes),
    }),
    createMultiAgentWorkspaceBridge({
      repository: repo,
      workspaceId,
      actor: actor(),
      writer: writer(ROOT, 'run_right'),
      legacyFiles,
      readEntryBytes: bytesReader(bytes),
    }),
  ])
  const left = createWorkspaceInstance(
    materialsDiscoveryWorkspace,
    leftBridge.projectedFiles,
    {},
    { conversationId: workspaceId, onFileMutations: leftBridge.onFileMutations },
    persistence(bytes),
  )
  const right = createWorkspaceInstance(
    materialsDiscoveryWorkspace,
    rightBridge.projectedFiles,
    {},
    { conversationId: workspaceId, onFileMutations: rightBridge.onFileMutations },
    persistence(bytes),
  )

  await left.writeText(path, 'left wins', undefined, { archive: false })
  await assert.rejects(
    right.writeText(path, 'stale overwrite', undefined, { archive: false }),
    WorkspaceRevisionConflictError,
  )
  const head = await repo.getFile(workspaceId, path, actor())
  assert.equal(bytes.get(
    head?.storage_ref.driver === 'gridfs' ? head.storage_ref.object_id : '',
  )?.toString('utf8'), 'left wins')
}

async function verifyMemberAclPrivateVersionsAndManagedReferences(): Promise<void> {
  const repo = repository()
  const workspaceId = 'workspace_bridge_member_acl'
  const bytes = new Map<string, Buffer>()
  const memberId = 'agent_materials'
  const memberActor = actor(memberId, true)
  const bridge = await createMultiAgentWorkspaceBridge({
    repository: repo,
    workspaceId,
    actor: memberActor,
    writer: writer(memberId),
    readEntryBytes: bytesReader(bytes),
  })
  const workspace = createWorkspaceInstance(
    materialsDiscoveryWorkspace,
    bridge.projectedFiles,
    {},
    { conversationId: workspaceId, onFileMutations: bridge.onFileMutations },
    persistence(bytes),
  )

  const privatePath = `.sci-pegasus/agents/${memberId}/notes.md`
  await workspace.writeText(privatePath, 'draft one')
  await workspace.writeText(privatePath, 'draft two')
  const privateArchive = buildVersionArchivePath(privatePath, 1)
  assert.ok(privateArchive.startsWith(`.sci-pegasus/agents/${memberId}/`))
  assert.equal((await repo.getFile(workspaceId, privateArchive, memberActor))?.visibility, 'agent_private')

  const managedPath = 'references/papers/arxiv-2608.00001/parsed/fulltext.md'
  await workspace.writeText(managedPath, 'managed full text', undefined, { archive: false })
  assert.equal((await repo.getFile(workspaceId, managedPath, memberActor))?.visibility, 'managed_reference')

  await assert.rejects(
    workspace.writeText('analysis/member-public.md', 'forbidden', undefined, { archive: false }),
    WorkspaceAclError,
  )

  const untrustedRepo = repository()
  const untrustedBridge = await createMultiAgentWorkspaceBridge({
    repository: untrustedRepo,
    workspaceId: 'workspace_bridge_untrusted',
    actor: actor('agent_untrusted'),
    writer: writer('agent_untrusted'),
    readEntryBytes: bytesReader(bytes),
  })
  const untrusted = createWorkspaceInstance(
    materialsDiscoveryWorkspace,
    untrustedBridge.projectedFiles,
    {},
    { conversationId: 'workspace_bridge_untrusted', onFileMutations: untrustedBridge.onFileMutations },
    persistence(bytes),
  )
  await assert.rejects(
    untrusted.writeText(
      'references/papers/arxiv-2608.00002/parsed/fulltext.md',
      'forbidden managed write',
      undefined,
      { archive: false },
    ),
    WorkspaceAclError,
  )
}

async function verifyDistinctStaleProjectionsDoNotLosePaths(): Promise<void> {
  const repo = repository()
  const workspaceId = 'workspace_bridge_distinct_paths'
  const bytes = new Map<string, Buffer>()
  const makeBridge = (runId: string) => createMultiAgentWorkspaceBridge({
    repository: repo,
    workspaceId,
    actor: actor(),
    writer: writer(ROOT, runId),
    legacyFiles: {},
    readEntryBytes: bytesReader(bytes),
  })
  const [left, right] = await Promise.all([makeBridge('run_path_left'), makeBridge('run_path_right')])
  const [leftWorkspace, rightWorkspace] = [left, right].map(bridge => createWorkspaceInstance(
    materialsDiscoveryWorkspace,
    bridge.projectedFiles,
    {},
    { conversationId: workspaceId, onFileMutations: bridge.onFileMutations },
    persistence(bytes),
  ))
  await Promise.all([
    leftWorkspace.writeText('analysis/left.md', 'left'),
    rightWorkspace.writeText('analysis/right.md', 'right'),
  ])
  assert.deepEqual(
    (await repo.listFiles(workspaceId, actor())).map(file => file.path),
    ['analysis/left.md', 'analysis/right.md'],
  )
}

async function freshWorkspace(
  repo: MultiAgentWorkspaceRepository,
  bytes: Map<string, Buffer>,
  workspaceId: string,
  agentId: string,
  runId: string,
  manifest: Record<string, ManifestEntry> = {},
): Promise<WorkspaceInstance> {
  const bridge = await createMultiAgentWorkspaceBridge({
    repository: repo,
    workspaceId,
    actor: actor(agentId),
    writer: writer(agentId, runId),
    legacyFiles: {},
    readEntryBytes: bytesReader(bytes),
  })
  return createWorkspaceInstance(
    materialsDiscoveryWorkspace,
    bridge.projectedFiles,
    manifest,
    { conversationId: workspaceId, onFileMutations: bridge.onFileMutations },
    persistence(bytes),
  )
}

async function verifyFreshRunsUseAuthoritativeRevisionForArchives(): Promise<void> {
  const repo = repository()
  const bytes = new Map<string, Buffer>()
  const workspaceId = 'workspace_bridge_fresh_run_archive_revision'
  const publicPath = 'output/research-report.md'

  const first = await freshWorkspace(repo, bytes, workspaceId, ROOT, 'run_public_v1')
  assert.equal((await executeWrite({ file_path: publicPath, content: 'public v1' }, first)).is_error, undefined)

  const second = await freshWorkspace(repo, bytes, workspaceId, ROOT, 'run_public_v2')
  assert.equal((await executeEdit({
    file_path: publicPath,
    old_string: 'public v1',
    new_string: 'public v2',
  }, second)).is_error, undefined)

  // A new Run intentionally starts with an empty legacy manifest, matching the
  // production multi-Agent projection. The authoritative head is revision 2,
  // so this overwrite must archive v2 rather than collide with the existing v1.
  const third = await freshWorkspace(repo, bytes, workspaceId, ROOT, 'run_public_v3')
  assert.equal((await executeWrite({ file_path: publicPath, content: 'public v3' }, third)).is_error, undefined)

  assert.equal((await repo.getFile(workspaceId, publicPath, actor()))?.revision, 3)
  assert.equal(
    (await repo.getFile(workspaceId, buildVersionArchivePath(publicPath, 1), actor()))?.metadata.sha256,
    createHash('sha256').update('public v1').digest('hex'),
  )
  assert.equal(
    (await repo.getFile(workspaceId, buildVersionArchivePath(publicPath, 2), actor()))?.metadata.sha256,
    createHash('sha256').update('public v2').digest('hex'),
  )

  const memberId = 'agent_translator'
  const privatePath = `.sci-pegasus/agents/${memberId}/translation.md`
  const staleManifest: Record<string, ManifestEntry> = {
    [privatePath]: { current_version: 1, versions: [] },
  }
  const privateFirst = await freshWorkspace(
    repo,
    bytes,
    workspaceId,
    memberId,
    'run_private_v1',
    staleManifest,
  )
  assert.equal((await executeWrite({ file_path: privatePath, content: 'private v1' }, privateFirst)).is_error, undefined)
  const privateSecond = await freshWorkspace(
    repo,
    bytes,
    workspaceId,
    memberId,
    'run_private_v2',
    staleManifest,
  )
  assert.equal((await executeEdit({
    file_path: privatePath,
    old_string: 'private v1',
    new_string: 'private v2',
  }, privateSecond)).is_error, undefined)
  const privateThird = await freshWorkspace(
    repo,
    bytes,
    workspaceId,
    memberId,
    'run_private_v3',
    staleManifest,
  )
  assert.equal((await executeWrite({ file_path: privatePath, content: 'private v3' }, privateThird)).is_error, undefined)
  assert.equal((await repo.getFile(workspaceId, privatePath, actor(memberId)))?.revision, 3)
  assert.ok(await repo.getFile(
    workspaceId,
    buildVersionArchivePath(privatePath, 2),
    actor(memberId),
  ))
}

async function verifyArchiveFirstCrashCanResumeAcrossWriters(): Promise<void> {
  const repo = repository()
  const bytes = new Map<string, Buffer>()
  const workspaceId = 'workspace_bridge_archive_first_resume'
  const path = 'analysis/resumable.md'
  const first = await freshWorkspace(repo, bytes, workspaceId, ROOT, 'run_resume_seed')
  await first.writeText(path, 'before crash')

  const main = await repo.getFile(workspaceId, path, actor())
  assert.ok(main)
  const archivePath = buildVersionArchivePath(path, 1)
  const reservationId = 'reservation_archive_committed_before_crash'
  await repo.reserveFileSet(workspaceId, reservationId, [archivePath, path])
  const archived = await repo.commitFile(actor(), {
    workspaceId,
    path: archivePath,
    expectedRevision: null,
    visibility: 'public',
    storageRef: main.storage_ref,
    metadata: main.metadata,
    writer: writer(ROOT, 'run_archive_committed_before_crash'),
    reservationId,
  })
  assert.equal(
    await repo.getFile(workspaceId, archivePath, actor()),
    null,
    'a hard crash may leave the archive staged but unpublished',
  )

  const takeover = await freshWorkspace(repo, bytes, workspaceId, ROOT, 'run_archive_takeover')
  await takeover.writeText(path, 'after takeover')
  assert.equal((await repo.getFile(workspaceId, path, actor()))?.revision, 2)
  const preserved = await repo.getFile(workspaceId, archivePath, actor())
  assert.equal(preserved?.version_id, archived.version_id, 'takeover must reuse, not rewrite, the archive')
  assert.equal(preserved?.metadata.sha256, main.metadata.sha256)
  assert.equal((await repo.getFileSetReservation(workspaceId, reservationId))?.status, 'finalized')
}

async function verifyDivergentArchiveFailsClosed(): Promise<void> {
  const repo = repository()
  const bytes = new Map<string, Buffer>()
  const workspaceId = 'workspace_bridge_divergent_archive'
  const path = 'analysis/divergent.md'
  const first = await freshWorkspace(repo, bytes, workspaceId, ROOT, 'run_divergent_seed')
  await first.writeText(path, 'canonical revision one')

  await repo.commitFile(actor(), {
    workspaceId,
    path: buildVersionArchivePath(path, 1),
    expectedRevision: null,
    visibility: 'public',
    storageRef: { driver: 'gridfs', object_id: 'gridfs_divergent_archive' },
    metadata: {
      kind: 'text',
      mime_type: 'text/markdown',
      size_bytes: Buffer.byteLength('wrong archive'),
      sha256: createHash('sha256').update('wrong archive').digest('hex'),
    },
    writer: writer(ROOT, 'run_divergent_archive'),
  })

  const retry = await freshWorkspace(repo, bytes, workspaceId, ROOT, 'run_divergent_retry')
  await assert.rejects(
    retry.writeText(path, 'must not commit'),
    WorkspaceRevisionConflictError,
  )
  const main = await repo.getFile(workspaceId, path, actor())
  assert.equal(main?.revision, 1)
  assert.equal(main?.metadata.sha256, createHash('sha256').update('canonical revision one').digest('hex'))
}

async function main(): Promise<void> {
  await verifyLazyImportArchiveAndExactTextMetadata()
  await verifyStaleWholeMapCannotOverwriteAuthoritativeHead()
  await verifyMemberAclPrivateVersionsAndManagedReferences()
  await verifyDistinctStaleProjectionsDoNotLosePaths()
  await verifyFreshRunsUseAuthoritativeRevisionForArchives()
  await verifyArchiveFirstCrashCanResumeAcrossWriters()
  await verifyDivergentArchiveFailsClosed()
  console.log('multi-agent-workspace-bridge:verify passed')
}

void main()
