import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

const TEST_DATABASE_SUFFIX = '_test'
const mongoUri = process.env.WORKSPACE_MULTI_AGENT_TEST_MONGODB_URI?.trim()
  || 'mongodb://127.0.0.1:27018/sci_pegasus_workspace_multi_agent_test'
const databaseName = mongoUri.match(/\/([^/?]+)(?:\?|$)/)?.[1]

if (!databaseName?.endsWith(TEST_DATABASE_SUFFIX)) {
  throw new Error(
    `Refusing to run Multi-Agent Workspace integration tests outside an isolated *${TEST_DATABASE_SUFFIX} database.`,
  )
}

// Set this before importing any production model or repository. connectDB()
// intentionally reads the environment only when the first operation begins.
process.env.MONGODB_URI = mongoUri

const TEAM_ID = 'team_workspace_mongo'
const ROOT_AGENT_ID = 'agent_workspace_root'

function digest(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

async function main(): Promise<void> {
  const mongoose = (await import('mongoose')).default
  const { connectDB } = await import('../../../db/mongodb')
  const {
    createMultiAgentWorkspaceBridge,
    MongooseMultiAgentWorkspaceStore,
    MultiAgentWorkspaceRepository,
    WorkspaceCanonicalArtifact,
    WorkspaceCapacity,
    WorkspaceCapacityError,
    WorkspaceFile,
    WorkspaceFileRevision,
    WorkspaceRevisionConflictError,
    reclaimUnreferencedWorkspaceGridFS,
  } = await import('..')
  const { writeDocumentToGridFS } = await import('../../../db/gridfs')
  const { createWorkspaceInstance } = await import('../../instance')
  const { materialsDiscoveryWorkspace } = await import('../../definitions/materials-discovery')
  const { buildVersionArchivePath } = await import('../../path-policy')
  type WorkspaceActor = import('../types').WorkspaceActor
  type FileEntry = import('../../types').FileEntry
  type ManifestEntry = import('../../types').ManifestEntry
  type WorkspaceFileMetadata = import('../types').WorkspaceFileMetadata
  type WorkspaceFileWrite = import('../types').WorkspaceFileWrite
  type WorkspaceWriterProvenance = import('../types').WorkspaceWriterProvenance

  const root: WorkspaceActor = {
    teamId: TEAM_ID,
    agentId: ROOT_AGENT_ID,
    rootAgentId: ROOT_AGENT_ID,
    role: 'root',
  }

  const member = (agentId: string, managedReferenceTool = false): WorkspaceActor => ({
    teamId: TEAM_ID,
    agentId,
    rootAgentId: ROOT_AGENT_ID,
    role: 'member',
    managedReferenceTool,
  })

  const writer = (
    agentId: string,
    runId: string,
    fenceToken = `fence_${runId}`,
  ): WorkspaceWriterProvenance => ({
    team_id: TEAM_ID,
    agent_id: agentId,
    task_id: `task_${agentId}`,
    run_id: runId,
    execution_fence_token: fenceToken,
  })

  const metadata = (content: string): WorkspaceFileMetadata => ({
    kind: 'text',
    mime_type: 'text/markdown',
    size_bytes: Buffer.byteLength(content),
    sha256: digest(content),
  })

  const publicWrite = (
    workspaceId: string,
    path: string,
    content: string,
    runId: string,
    expectedRevision: number | null = null,
    reservationId?: string,
  ): WorkspaceFileWrite => ({
    workspaceId,
    path,
    expectedRevision,
    visibility: 'public',
    storageRef: { driver: 'gridfs', object_id: `gridfs_${runId}` },
    metadata: metadata(content),
    writer: writer(ROOT_AGENT_ID, runId),
    reservationId,
  })

  await connectDB()
  const database = mongoose.connection.db
  assert.ok(database, 'MongoDB test connection must expose a database')

  await database.dropDatabase()
  await Promise.all([
    WorkspaceFile.syncIndexes(),
    WorkspaceFileRevision.syncIndexes(),
    WorkspaceCapacity.syncIndexes(),
    WorkspaceCanonicalArtifact.syncIndexes(),
  ])

  try {
    // The durable claim primitive must distinguish the first owner from a
    // replay. Higher layers currently converge either way, but this state is
    // part of the store contract used by crash-safe materialization.
    {
      const store = new MongooseMultiAgentWorkspaceStore()
      const now = new Date('2026-08-08T00:00:00.000Z')
      const record = {
        workspace_id: 'workspace_mongo_canonical_claim_contract',
        canonical_artifact_key: 'arxiv:2608.00000:v1:claim-contract',
        idempotency_key: 'canonical_claim_contract',
        path: 'references/papers/arxiv-2608-00000-v1/metadata.json',
        content_sha256: digest('claim contract'),
        status: 'staging' as const,
        created_at: now,
        updated_at: now,
      }
      assert.equal((await store.claimCanonicalArtifact(record)).state, 'claimed')
      assert.equal((await store.claimCanonicalArtifact(record)).state, 'existing')
    }

    // Real Mongo path-level CAS: unrelated heads may advance together, while
    // two writers based on revision 1 produce exactly one revision-2 head.
    {
      const workspaceId = 'workspace_mongo_path_cas'
      const leftRepository = new MultiAgentWorkspaceRepository()
      const rightRepository = new MultiAgentWorkspaceRepository()
      const [left, right] = await Promise.all([
        leftRepository.commitFile(
          root,
          publicWrite(workspaceId, 'analysis/parallel-left.md', 'left', 'parallel_left'),
        ),
        rightRepository.commitFile(
          root,
          publicWrite(workspaceId, 'analysis/parallel-right.md', 'right', 'parallel_right'),
        ),
      ])
      assert.equal(left.revision, 1)
      assert.equal(right.revision, 1)

      const initial = await leftRepository.commitFile(
        root,
        publicWrite(workspaceId, 'analysis/contended.md', 'initial', 'contended_seed'),
      )
      assert.equal(initial.revision, 1)
      const contenders = await Promise.allSettled([
        leftRepository.commitFile(
          root,
          publicWrite(workspaceId, 'analysis/contended.md', 'alpha', 'contended_alpha', 1),
        ),
        rightRepository.commitFile(
          root,
          publicWrite(workspaceId, 'analysis/contended.md', 'beta', 'contended_beta', 1),
        ),
      ])
      const fulfilled = contenders.filter(
        (result): result is PromiseFulfilledResult<import('../types').WorkspaceFileSnapshot> => (
          result.status === 'fulfilled'
        ),
      )
      const rejected = contenders.filter(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      )
      assert.equal(fulfilled.length, 1)
      assert.equal(fulfilled[0].value.revision, 2)
      assert.equal(rejected.length, 1)
      assert.ok(rejected[0].reason instanceof WorkspaceRevisionConflictError)
      assert.equal(rejected[0].reason.expectedRevision, 1)
      assert.equal(rejected[0].reason.actualRevision, 2)

      const head = await WorkspaceFile.findOne({
        workspace_id: workspaceId,
        path: 'analysis/contended.md',
      }).lean()
      assert.equal(head?.revision, 2)
      assert.equal(
        await WorkspaceFile.countDocuments({ workspace_id: workspaceId }),
        3,
        'path CAS must not replace or drop unrelated heads',
      )
    }

    // Restart-safe archive numbering must come from the authoritative main
    // head, not the legacy Conversation manifest. This reproduces production:
    // every Run gets a fresh WorkspaceInstance and an empty/stale manifest.
    {
      const workspaceId = 'workspace_mongo_bridge_archive_restart'
      const bytes = new Map<string, Buffer>()
      let objectSequence = 0
      const readEntryBytes = async (_path: string, entry: FileEntry): Promise<Buffer | null> => (
        'gridfs_id' in entry ? bytes.get(entry.gridfs_id) ?? null : null
      )
      const persistence = {
        async writeTextFile(_conversationId: string, _path: string, content: string) {
          const id = `mongo_bridge_gridfs_${++objectSequence}`
          bytes.set(id, Buffer.from(content, 'utf8'))
          return id
        },
        async writeDocumentFile() {
          throw new Error('document persistence is not used by this test')
        },
        async readTextFile(id: string) {
          return bytes.get(id)?.toString('utf8') ?? null
        },
      }
      const freshWorkspace = async (
        runId: string,
        manifest: Record<string, ManifestEntry> = {},
      ) => {
        const repository = new MultiAgentWorkspaceRepository()
        const bridge = await createMultiAgentWorkspaceBridge({
          repository,
          workspaceId,
          actor: root,
          writer: writer(ROOT_AGENT_ID, runId),
          legacyFiles: {},
          readEntryBytes,
        })
        return {
          repository,
          workspace: createWorkspaceInstance(
            materialsDiscoveryWorkspace,
            bridge.projectedFiles,
            manifest,
            { conversationId: workspaceId, onFileMutations: bridge.onFileMutations },
            persistence,
          ),
        }
      }

      const path = 'output/restart-safe.md'
      await (await freshWorkspace('mongo_bridge_v1')).workspace.writeText(path, 'revision one')
      await (await freshWorkspace('mongo_bridge_v2')).workspace.writeText(path, 'revision two')
      await (await freshWorkspace('mongo_bridge_v3', {
        [path]: { current_version: 1, versions: [] },
      })).workspace.writeText(path, 'revision three')

      const repository = new MultiAgentWorkspaceRepository()
      assert.equal((await repository.getFile(workspaceId, path, root))?.revision, 3)
      assert.equal(
        (await repository.getFile(workspaceId, buildVersionArchivePath(path, 1), root))?.metadata.sha256,
        digest('revision one'),
      )
      assert.equal(
        (await repository.getFile(workspaceId, buildVersionArchivePath(path, 2), root))?.metadata.sha256,
        digest('revision two'),
      )

      // Crash window: archive CAS committed, main CAS did not. A new writer
      // must reuse the byte-identical immutable archive and advance the main.
      const resumablePath = 'analysis/archive-first.md'
      await (await freshWorkspace('mongo_bridge_resume_seed')).workspace.writeText(
        resumablePath,
        'before archive-first crash',
      )
      const resumableMain = await repository.getFile(workspaceId, resumablePath, root)
      assert.ok(resumableMain)
      const resumableArchivePath = buildVersionArchivePath(resumablePath, 1)
      const resumableReservationId = 'mongo_bridge_archive_first_reservation'
      await repository.reserveFileSet(
        workspaceId,
        resumableReservationId,
        [resumableArchivePath, resumablePath],
      )
      const archived = await repository.commitFile(root, {
        workspaceId,
        path: resumableArchivePath,
        expectedRevision: null,
        visibility: 'public',
        storageRef: resumableMain.storage_ref,
        metadata: resumableMain.metadata,
        writer: writer(ROOT_AGENT_ID, 'mongo_bridge_archive_first'),
        reservationId: resumableReservationId,
      })
      assert.equal(await repository.getFile(workspaceId, resumableArchivePath, root), null)
      await (await freshWorkspace('mongo_bridge_resume_takeover')).workspace.writeText(
        resumablePath,
        'after takeover',
      )
      assert.equal((await repository.getFile(workspaceId, resumablePath, root))?.revision, 2)
      assert.equal(
        (await repository.getFile(workspaceId, resumableArchivePath, root))?.version_id,
        archived.version_id,
      )
      assert.equal(
        (await repository.getFileSetReservation(workspaceId, resumableReservationId))?.status,
        'finalized',
      )

      // The cross-writer exception is archive-only and content-addressed. A
      // same-number archive with different bytes must remain a hard conflict.
      const divergentPath = 'analysis/divergent-archive.md'
      await (await freshWorkspace('mongo_bridge_divergent_seed')).workspace.writeText(
        divergentPath,
        'canonical revision one',
      )
      await repository.commitFile(root, {
        workspaceId,
        path: buildVersionArchivePath(divergentPath, 1),
        expectedRevision: null,
        visibility: 'public',
        storageRef: { driver: 'gridfs', object_id: 'mongo_gridfs_wrong_archive' },
        metadata: metadata('wrong archive'),
        writer: writer(ROOT_AGENT_ID, 'mongo_bridge_divergent_archive'),
      })
      await assert.rejects(
        (await freshWorkspace('mongo_bridge_divergent_retry')).workspace.writeText(
          divergentPath,
          'must not commit',
        ),
        WorkspaceRevisionConflictError,
      )
      assert.equal((await repository.getFile(workspaceId, divergentPath, root))?.revision, 1)
    }

    // Capacity CAS at 499/500: exactly one reservation gets the last slot and
    // the rejected contender leaves neither a reservation nor a staged head.
    {
      const workspaceId = 'workspace_mongo_capacity_500'
      const leftRepository = new MultiAgentWorkspaceRepository()
      const rightRepository = new MultiAgentWorkspaceRepository()
      await leftRepository.initializeCapacity(
        workspaceId,
        Array.from({ length: 499 }, (_, index) => `references/existing-${index}.md`),
      )

      const candidates = [
        { repository: leftRepository, reservationId: 'reservation_last_a', path: 'references/last-a.md' },
        { repository: rightRepository, reservationId: 'reservation_last_b', path: 'references/last-b.md' },
      ]
      const reservations = await Promise.allSettled(candidates.map(candidate => (
        candidate.repository.reserveFileSet(
          workspaceId,
          candidate.reservationId,
          [candidate.path],
        )
      )))
      assert.equal(reservations.filter(result => result.status === 'fulfilled').length, 1)
      const rejected = reservations.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      )
      assert.ok(rejected)
      assert.ok(rejected.reason instanceof WorkspaceCapacityError)

      const winnerIndex = reservations.findIndex(result => result.status === 'fulfilled')
      const winner = candidates[winnerIndex]
      const loser = candidates[1 - winnerIndex]
      await winner.repository.commitFile(root, publicWrite(
        workspaceId,
        winner.path,
        'the final capacity slot',
        'capacity_winner',
        null,
        winner.reservationId,
      ))
      assert.equal(await winner.repository.getFile(workspaceId, winner.path, root), null)
      await winner.repository.finalizeFileSet(workspaceId, winner.reservationId)

      const capacity = await WorkspaceCapacity.findOne({ workspace_id: workspaceId }).lean()
      assert.equal(capacity?.published_paths.length, 500)
      assert.ok(capacity?.published_paths.includes(winner.path))
      assert.equal(
        capacity?.reservations.filter(item => item.status === 'reserved').length,
        0,
      )
      assert.equal(
        await WorkspaceFile.countDocuments({ workspace_id: workspaceId, path: loser.path }),
        0,
      )
      await assert.rejects(
        leftRepository.reserveFileSet(
          workspaceId,
          'reservation_over_capacity',
          ['references/overflow-a.md', 'references/overflow-b.md'],
        ),
        WorkspaceCapacityError,
      )
      assert.equal(
        await WorkspaceFile.countDocuments({
          workspace_id: workspaceId,
          path: { $in: ['references/overflow-a.md', 'references/overflow-b.md'] },
        }),
        0,
      )
    }

    // Whole-set publication is governed by one capacity CAS. Mongo heads may
    // exist while staged, but no reader sees either path until finalization.
    {
      const workspaceId = 'workspace_mongo_whole_set'
      const repository = new MultiAgentWorkspaceRepository()
      const reservationId = 'reservation_whole_set'
      const paths = ['references/paper/original.pdf', 'references/paper/fulltext.md']
      await repository.reserveFileSet(workspaceId, reservationId, paths)
      await Promise.all(paths.map((path, index) => repository.commitFile(root, publicWrite(
        workspaceId,
        path,
        `staged member ${index}`,
        `whole_set_${index}`,
        null,
        reservationId,
      ))))

      assert.equal(
        await WorkspaceFile.countDocuments({ workspace_id: workspaceId }),
        2,
        'the immutable references should be durably staged before publication',
      )
      assert.equal(await repository.getFile(workspaceId, paths[0], root), null)
      assert.equal(await repository.getFile(workspaceId, paths[1], root), null)
      assert.deepEqual(await repository.listFiles(workspaceId, root), [])

      await repository.finalizeFileSet(workspaceId, reservationId)
      assert.deepEqual(
        (await repository.listFiles(workspaceId, root)).map(file => file.path),
        [...paths].sort(),
      )
      const reservation = await repository.getFileSetReservation(workspaceId, reservationId)
      assert.equal(reservation?.status, 'finalized')
    }

    // A live staged owner is preserved. Once every staged writer loses its
    // fence, recovery discards only the mutable heads and releases visibility;
    // append-only unreachable revisions remain available for later GC/audit.
    {
      const workspaceId = 'workspace_mongo_stale_heads'
      let fenceIsLive = true
      const repository = new MultiAgentWorkspaceRepository({
        fenceValidator: () => fenceIsLive,
      })
      const reservationId = 'reservation_stale_heads'
      const paths = ['analysis/stale-a.md', 'analysis/stale-b.md']
      await repository.reserveFileSet(workspaceId, reservationId, paths)
      await Promise.all(paths.map((path, index) => repository.commitFile(root, publicWrite(
        workspaceId,
        path,
        `stale content ${index}`,
        `stale_writer_${index}`,
        null,
        reservationId,
      ))))

      assert.equal(await repository.recoverStaleFileSet(workspaceId, reservationId), false)
      assert.equal(await WorkspaceFile.countDocuments({ workspace_id: workspaceId }), 2)
      fenceIsLive = false
      assert.equal(await repository.recoverStaleFileSet(workspaceId, reservationId), true)
      assert.equal(await WorkspaceFile.countDocuments({ workspace_id: workspaceId }), 0)
      assert.equal(
        await WorkspaceFileRevision.countDocuments({ workspace_id: workspaceId }),
        2,
        'discarding stale heads must not mutate append-only revision records',
      )
      assert.deepEqual(await repository.listFiles(workspaceId, root), [])
      const reservation = await repository.getFileSetReservation(workspaceId, reservationId)
      assert.equal(reservation?.status, 'finalized')
    }

    // Two independent Agent executors may publish one canonical paper asset.
    // The canonical key, not a process-local lock or tool-use id, picks one head.
    {
      const workspaceId = 'workspace_mongo_managed_reference'
      const leftRepository = new MultiAgentWorkspaceRepository()
      const rightRepository = new MultiAgentWorkspaceRepository()
      const leftActor = member('agent_literature_left', true)
      const rightActor = member('agent_literature_right', true)
      const canonicalArtifactKey = 'arxiv:2608.00001:v1:parsed-fulltext'
      const path = 'references/papers/arxiv-2608-00001-v1/parsed/fulltext.md'
      const content = 'one canonical full text shared by the team'

      const [left, right] = await Promise.all([
        leftRepository.commitManagedReference(leftActor, {
          workspaceId,
          canonicalArtifactKey,
          path,
          storageRef: { driver: 'gridfs', object_id: 'gridfs_managed_left' },
          metadata: metadata(content),
          writer: writer(leftActor.agentId, 'managed_left'),
          idempotencyKey: 'fetch_command_left',
        }),
        rightRepository.commitManagedReference(rightActor, {
          workspaceId,
          canonicalArtifactKey,
          path,
          storageRef: { driver: 'gridfs', object_id: 'gridfs_managed_right' },
          metadata: metadata(content),
          writer: writer(rightActor.agentId, 'managed_right'),
          idempotencyKey: 'fetch_command_right',
        }),
      ])
      assert.equal(left.file.version_id, right.file.version_id)
      assert.equal(left.file.revision, 1)
      assert.equal([left.created, right.created].filter(Boolean).length, 1)
      assert.equal(await WorkspaceFile.countDocuments({ workspace_id: workspaceId }), 1)
      assert.equal(
        await WorkspaceCanonicalArtifact.countDocuments({
          workspace_id: workspaceId,
          canonical_artifact_key: canonicalArtifactKey,
          status: 'published',
        }),
        1,
      )
    }

    // Proposal publication uses an immutable source identity plus a stable key.
    // A replay from a replacement Runner returns the same public revision and
    // does not append another immutable version.
    {
      const workspaceId = 'workspace_mongo_proposal_replay'
      const author = member('agent_proposal_author')
      const sourcePath = '.sci-pegasus/agents/agent_proposal_author/draft.md'
      const sourceContent = 'reviewed private draft'
      const sourceRepository = new MultiAgentWorkspaceRepository()
      await sourceRepository.commitFile(author, {
        workspaceId,
        path: sourcePath,
        expectedRevision: null,
        visibility: 'agent_private',
        ownerAgentId: author.agentId,
        storageRef: { driver: 'gridfs', object_id: 'gridfs_proposal_source' },
        metadata: metadata(sourceContent),
        writer: writer(author.agentId, 'proposal_source'),
      })

      const targetPath = 'output/reviewed-draft.md'
      const publicationKey = 'workspace-proposal:proposal-item-1:output/reviewed-draft.md'
      const leftRepository = new MultiAgentWorkspaceRepository()
      const rightRepository = new MultiAgentWorkspaceRepository()
      const publications = await Promise.all([
        leftRepository.acceptProposalItem({
          workspaceId,
          sourcePath,
          targetPath,
          publicationKey,
          expectedSourceSha256: digest(sourceContent),
          expectedTargetRevision: null,
          actor: root,
          writer: writer(ROOT_AGENT_ID, 'proposal_review_original'),
        }),
        rightRepository.acceptProposalItem({
          workspaceId,
          sourcePath,
          targetPath,
          publicationKey,
          expectedSourceSha256: digest(sourceContent),
          expectedTargetRevision: null,
          actor: root,
          writer: writer(ROOT_AGENT_ID, 'proposal_review_competing'),
        }),
      ])
      assert.ok(publications.every(result => result.status === 'accepted'))
      if (publications[0].status !== 'accepted' || publications[1].status !== 'accepted') {
        throw new Error('The proposal publication race unexpectedly conflicted')
      }
      assert.equal(publications[0].file.version_id, publications[1].file.version_id)
      const revisionCountBeforeReplay = await WorkspaceFileRevision.countDocuments({
        workspace_id: workspaceId,
        path: targetPath,
      })

      const replayed = await new MultiAgentWorkspaceRepository().acceptProposalItem({
        workspaceId,
        sourcePath,
        targetPath,
        publicationKey,
        expectedSourceSha256: digest(sourceContent),
        expectedTargetRevision: null,
        actor: root,
        writer: writer(
          ROOT_AGENT_ID,
          'proposal_review_original',
          'fence_replacement_runner',
        ),
      })
      assert.equal(replayed.status, 'accepted')
      if (replayed.status === 'accepted') {
        assert.equal(replayed.file.version_id, publications[0].file.version_id)
        assert.equal(replayed.file.revision, 1)
      }
      assert.equal(
        await WorkspaceFileRevision.countDocuments({
          workspace_id: workspaceId,
          path: targetPath,
        }),
        revisionCountBeforeReplay,
        'a publication-key replay must not append a duplicate immutable revision',
      )
      assert.equal(await WorkspaceFile.countDocuments({
        workspace_id: workspaceId,
        path: targetPath,
      }), 1)
    }

    // File-set aborts must leave neither an unreachable immutable revision nor
    // its GridFS files/chunks. GridFS metadata acts as a durable cleanup intent,
    // including the crash window where upload finished before any head existed.
    {
      const workspaceId = 'workspace_mongo_gridfs_abort_gc'
      const path = 'output/spatial/objects/aborted/model.glb'
      const reservationId = 'reservation_gridfs_abort_gc'
      const repository = new MultiAgentWorkspaceRepository()
      await repository.reserveFileSet(workspaceId, reservationId, [path])
      const bytes = Buffer.alloc(12)
      bytes.write('glTF', 0, 'ascii')
      bytes.writeUInt32LE(2, 4)
      bytes.writeUInt32LE(bytes.length, 8)
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      const objectId = await writeDocumentToGridFS(workspaceId, path, bytes, {
        filename: 'model.glb',
        mimeType: 'model/gltf-binary',
        sha256,
        source: { provider: 'fixture' },
        provenance: { retrieved_at: new Date().toISOString() },
        capacityReservationId: reservationId,
      })
      await repository.commitFile(root, {
        workspaceId,
        path,
        expectedRevision: null,
        visibility: 'public',
        storageRef: { driver: 'gridfs', object_id: objectId },
        metadata: {
          kind: 'document',
          mime_type: 'model/gltf-binary',
          filename: 'model.glb',
          size_bytes: bytes.length,
          sha256,
        },
        writer: writer(ROOT_AGENT_ID, 'gridfs_abort_gc'),
        reservationId,
      })
      assert.equal(await database.collection('workspace_files.files').countDocuments(), 1)
      assert.ok(await database.collection('workspace_files.chunks').countDocuments() >= 1)
      await repository.discardFileSet(workspaceId, reservationId)
      assert.equal(await WorkspaceFile.countDocuments({ workspace_id: workspaceId }), 0)
      assert.equal(
        await WorkspaceFileRevision.countDocuments({ workspace_id: workspaceId }),
        1,
        'abort keeps immutable evidence during the bounded audit window',
      )
      const reclaimed = await reclaimUnreferencedWorkspaceGridFS(
        200,
        new Date(Date.now() + 25 * 60 * 60 * 1_000),
      )
      assert.equal(reclaimed.blobsRemoved, 1)
      assert.equal(reclaimed.revisionsRemoved, 1)
      assert.equal(await WorkspaceFileRevision.countDocuments({ workspace_id: workspaceId }), 0)
      assert.equal(await database.collection('workspace_files.files').countDocuments(), 0)
      assert.equal(await database.collection('workspace_files.chunks').countDocuments(), 0)

      const preHeadPath = 'output/spatial/objects/pre-head/model.glb'
      const preHeadReservation = 'reservation_gridfs_pre_head_gc'
      await repository.reserveFileSet(workspaceId, preHeadReservation, [preHeadPath])
      await writeDocumentToGridFS(workspaceId, preHeadPath, bytes, {
        filename: 'model.glb',
        mimeType: 'model/gltf-binary',
        sha256,
        source: { provider: 'fixture' },
        provenance: { retrieved_at: new Date().toISOString() },
        capacityReservationId: preHeadReservation,
      })
      await repository.discardFileSet(workspaceId, preHeadReservation)
      const reclaimedPreHead = await reclaimUnreferencedWorkspaceGridFS()
      assert.equal(reclaimedPreHead.blobsRemoved, 1)
      assert.equal(await database.collection('workspace_files.files').countDocuments(), 0)
      assert.equal(await database.collection('workspace_files.chunks').countDocuments(), 0)

      const publishedPath = 'output/spatial/objects/published/model.glb'
      const publishedReservation = 'reservation_gridfs_published_keep'
      await repository.reserveFileSet(workspaceId, publishedReservation, [publishedPath])
      const publishedObjectId = await writeDocumentToGridFS(workspaceId, publishedPath, bytes, {
        filename: 'model.glb',
        mimeType: 'model/gltf-binary',
        sha256,
        source: { provider: 'fixture' },
        provenance: { retrieved_at: new Date().toISOString() },
        capacityReservationId: publishedReservation,
      })
      await repository.commitFile(root, {
        workspaceId,
        path: publishedPath,
        expectedRevision: null,
        visibility: 'public',
        storageRef: { driver: 'gridfs', object_id: publishedObjectId },
        metadata: {
          kind: 'document',
          mime_type: 'model/gltf-binary',
          filename: 'model.glb',
          size_bytes: bytes.length,
          sha256,
        },
        writer: writer(ROOT_AGENT_ID, 'gridfs_published_keep'),
        reservationId: publishedReservation,
      })
      await repository.finalizeFileSet(workspaceId, publishedReservation)
      await reclaimUnreferencedWorkspaceGridFS(
        200,
        new Date(Date.now() + 365 * 24 * 60 * 60 * 1_000),
      )
      assert.equal(await database.collection('workspace_files.files').countDocuments({
        _id: new mongoose.Types.ObjectId(publishedObjectId),
      }), 1, 'published GridFS bytes must survive every garbage sweep')
      assert.equal(await WorkspaceFileRevision.countDocuments({
        workspace_id: workspaceId,
        path: publishedPath,
      }), 1)
    }

    console.log('Multi-Agent Workspace Mongo integration verification passed.')
  } finally {
    await database.dropDatabase()
    await mongoose.disconnect()
  }
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
