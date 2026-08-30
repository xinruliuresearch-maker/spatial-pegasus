import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  InMemoryMultiAgentWorkspaceStore,
  MultiAgentWorkspaceRepository,
  WorkspaceAclError,
  WorkspaceCapacityError,
  WorkspaceExecutionFenceError,
  WorkspaceFile,
  WorkspaceFileRevision,
  WorkspaceReservationConflictError,
  WorkspaceReservationError,
  WorkspaceRevisionConflictError,
  WorkspaceProposalPublicationConflictError,
  type WorkspaceActor,
  type WorkspaceFileMetadata,
  type WorkspaceFileWrite,
  type WorkspaceWriterProvenance,
} from '..'

const WORKSPACE = 'workspace_multi_agent_test'
const TEAM = 'team_multi_agent_test'
const ROOT_ID = 'agent_root'
let version = 0

const root: WorkspaceActor = {
  teamId: TEAM,
  agentId: ROOT_ID,
  rootAgentId: ROOT_ID,
  role: 'root',
}

function member(agentId: string, references?: string[]): WorkspaceActor {
  return {
    teamId: TEAM,
    agentId,
    rootAgentId: ROOT_ID,
    role: 'member',
    privatePathReferences: references,
  }
}

function writer(agentId: string, runId = `run_${agentId}`): WorkspaceWriterProvenance {
  return {
    team_id: TEAM,
    agent_id: agentId,
    task_id: `task_${agentId}`,
    run_id: runId,
    execution_fence_token: `fence_${runId}`,
  }
}

function metadata(content: string): WorkspaceFileMetadata {
  return {
    kind: 'text',
    mime_type: 'text/markdown',
    size_bytes: Buffer.byteLength(content),
    sha256: createHash('sha256').update(content).digest('hex'),
  }
}

function publicWrite(path: string, content: string, runId: string): WorkspaceFileWrite {
  return {
    workspaceId: WORKSPACE,
    path,
    expectedRevision: null,
    visibility: 'public',
    storageRef: { driver: 'gridfs', object_id: `gridfs_${runId}` },
    metadata: metadata(content),
    writer: writer(ROOT_ID, runId),
  }
}

function repository(maxFiles = 500): {
  repo: MultiAgentWorkspaceRepository
  store: InMemoryMultiAgentWorkspaceStore
} {
  const store = new InMemoryMultiAgentWorkspaceStore()
  const repo = new MultiAgentWorkspaceRepository({
    store,
    maxFiles,
    versionId: () => `wfver_test_${++version}`,
    now: () => new Date(`2026-08-08T00:00:${String(version % 60).padStart(2, '0')}.000Z`),
    fenceValidator: ({ writer: provenance }) => provenance.execution_fence_token.startsWith('fence_'),
  })
  return { repo, store }
}

async function verifyParallelPathsAndSamePathConflict(): Promise<void> {
  const { repo } = repository()
  const [left, right] = await Promise.all([
    repo.commitFile(root, publicWrite('analysis/parallel-left.md', 'left', 'parallel_left')),
    repo.commitFile(root, publicWrite('analysis/parallel-right.md', 'right', 'parallel_right')),
  ])
  assert.equal(left.revision, 1)
  assert.equal(right.revision, 1)
  assert.deepEqual(
    (await repo.listFiles(WORKSPACE, root)).map(file => file.path),
    ['analysis/parallel-left.md', 'analysis/parallel-right.md'],
  )

  const contenders = await Promise.allSettled([
    repo.commitFile(root, publicWrite('analysis/same-path.md', 'alpha', 'same_alpha')),
    repo.commitFile(root, publicWrite('analysis/same-path.md', 'beta', 'same_beta')),
  ])
  assert.equal(contenders.filter(item => item.status === 'fulfilled').length, 1)
  const rejected = contenders.find(item => item.status === 'rejected')
  assert.ok(rejected && rejected.status === 'rejected')
  assert.ok(
    rejected.reason instanceof WorkspaceReservationConflictError
      || rejected.reason instanceof WorkspaceRevisionConflictError,
  )

  const idempotentWrite = publicWrite('analysis/idempotent.md', 'same', 'same_command')
  const [idempotentLeft, idempotentRight] = await Promise.all([
    repo.commitFile(root, idempotentWrite),
    repo.commitFile(root, idempotentWrite),
  ])
  assert.equal(idempotentLeft.version_id, idempotentRight.version_id)
}

async function verifyAclAndExplicitPrivateReference(): Promise<void> {
  const { repo } = repository()
  const owner = member('agent_owner')
  const privatePath = '.sci-pegasus/agents/agent_owner/findings.md'
  await repo.commitFile(owner, {
    workspaceId: WORKSPACE,
    path: privatePath,
    expectedRevision: null,
    visibility: 'agent_private',
    ownerAgentId: owner.agentId,
    storageRef: { driver: 'gridfs', object_id: 'gridfs_private' },
    metadata: metadata('private'),
    writer: writer(owner.agentId),
  })

  assert.equal((await repo.getFile(WORKSPACE, privatePath, root))?.path, privatePath)
  await assert.rejects(
    repo.getFile(WORKSPACE, privatePath, member('agent_peer')),
    WorkspaceAclError,
  )
  assert.equal(
    (await repo.getFile(WORKSPACE, privatePath, member('agent_peer', [privatePath])))?.path,
    privatePath,
  )
  await assert.rejects(
    repo.commitFile(owner, {
      ...publicWrite('analysis/member-cannot-publish.md', 'no', 'member_public'),
      writer: writer(owner.agentId, 'member_public'),
    }),
    WorkspaceAclError,
  )
  const delegatedImageMember: WorkspaceActor = {
    ...owner,
    publicWriteTool: 'GenerateImage',
  }
  const delegatedImage = await repo.commitFile(delegatedImageMember, {
    workspaceId: WORKSPACE,
    path: 'output/spatial/images/member-generated.png',
    expectedRevision: null,
    visibility: 'public',
    storageRef: { driver: 'asset', asset_id: 'asset_member_generated', variant: 'model' },
    metadata: {
      kind: 'raster',
      mime_type: 'image/png',
      size_bytes: 128,
      sha256: 'a'.repeat(64),
    },
    writer: writer(owner.agentId, 'member_generate_image'),
  })
  assert.equal(delegatedImage.path, 'output/spatial/images/member-generated.png')
  await assert.rejects(
    repo.commitFile(delegatedImageMember, {
      ...publicWrite('analysis/member-still-cannot-publish.md', 'no', 'member_public_other'),
      writer: writer(owner.agentId, 'member_public_other'),
    }),
    WorkspaceAclError,
  )
  await assert.rejects(
    repo.commitFile(owner, {
      workspaceId: WORKSPACE,
      path: '.sci-pegasus/agents/agent_peer/not-owned.md',
      expectedRevision: null,
      visibility: 'agent_private',
      ownerAgentId: owner.agentId,
      storageRef: { driver: 'gridfs', object_id: 'gridfs_wrong_owner' },
      metadata: metadata('no'),
      writer: writer(owner.agentId, 'wrong_owner'),
    }),
    WorkspaceAclError,
  )
}

async function verifyCapacityBoundaryIsAtomic(): Promise<void> {
  const { repo, store } = repository()
  const existing = Array.from({ length: 499 }, (_, index) => `notes/existing-${index}.md`)
  await repo.initializeCapacity(WORKSPACE, existing)

  await assert.rejects(
    repo.reserveFileSet(WORKSPACE, 'reservation_overflow', [
      'notes/file-500.md',
      'notes/file-501.md',
    ]),
    WorkspaceCapacityError,
  )
  assert.equal(await store.getFile(WORKSPACE, 'notes/file-500.md'), null)
  assert.equal(await store.getFile(WORKSPACE, 'notes/file-501.md'), null)
  assert.equal((await store.getCapacity(WORKSPACE))?.published_paths.length, 499)

  await repo.commitFile(root, publicWrite('notes/file-500.md', 'last slot', 'capacity_last'))
  assert.equal((await store.getCapacity(WORKSPACE))?.published_paths.length, 500)
  await assert.rejects(
    repo.commitFile(root, publicWrite('notes/file-501.md', 'overflow', 'capacity_overflow')),
    WorkspaceCapacityError,
  )
  assert.equal(await store.getFile(WORKSPACE, 'notes/file-501.md'), null)
}

async function verifyReservedSetPublishesTogether(): Promise<void> {
  const { repo } = repository()
  const paths = ['analysis/set-a.md', 'analysis/set-b.md']
  await repo.reserveFileSet(WORKSPACE, 'reservation_atomic_set', paths)
  await repo.commitFile(root, {
    ...publicWrite(paths[0], 'set a', 'set_a'),
    reservationId: 'reservation_atomic_set',
  })
  assert.equal(await repo.getFile(WORKSPACE, paths[0], root), null)
  await assert.rejects(
    repo.releaseFileSet(WORKSPACE, 'reservation_atomic_set'),
    WorkspaceReservationError,
  )
  await repo.commitFile(root, {
    ...publicWrite(paths[1], 'set b', 'set_b'),
    reservationId: 'reservation_atomic_set',
  })
  assert.deepEqual(await repo.listFiles(WORKSPACE, root), [])

  await repo.finalizeFileSet(WORKSPACE, 'reservation_atomic_set')
  assert.deepEqual(
    (await repo.listFiles(WORKSPACE, root)).map(file => file.path),
    paths,
  )
}

async function verifyLostFenceCannotReserveOrPublish(): Promise<void> {
  const store = new InMemoryMultiAgentWorkspaceStore()
  const repo = new MultiAgentWorkspaceRepository({
    store,
    fenceValidator: () => false,
  })
  await assert.rejects(
    repo.commitFile(root, publicWrite('analysis/stale.md', 'stale', 'stale_run')),
    WorkspaceExecutionFenceError,
  )
  assert.equal(await store.getCapacity(WORKSPACE), null)
  assert.equal(await store.getFile(WORKSPACE, 'analysis/stale.md'), null)
}

async function verifyFenceLostAtPublishBoundaryReleasesCapacity(): Promise<void> {
  const store = new InMemoryMultiAgentWorkspaceStore()
  let fenceChecks = 0
  const repo = new MultiAgentWorkspaceRepository({
    store,
    fenceValidator: () => {
      fenceChecks += 1
      return fenceChecks === 1
    },
  })
  await assert.rejects(
    repo.commitFile(root, publicWrite('analysis/fence-lost-after-reserve.md', 'stale', 'lost_after_reserve')),
    WorkspaceExecutionFenceError,
  )
  assert.equal(fenceChecks, 2, 'the lease fence must be rechecked at the publication CAS boundary')
  assert.equal(await store.getFile(WORKSPACE, 'analysis/fence-lost-after-reserve.md'), null)
  const capacity = await store.getCapacity(WORKSPACE)
  assert.deepEqual(capacity?.published_paths, [])
  assert.equal(capacity?.reservations.length, 1)
  assert.equal(capacity?.reservations[0].status, 'released')
}

async function verifyConcurrent499To500BoundaryHasOneWinner(): Promise<void> {
  const { repo, store } = repository()
  await repo.initializeCapacity(
    WORKSPACE,
    Array.from({ length: 499 }, (_, index) => `notes/concurrent-existing-${index}.md`),
  )
  const results = await Promise.allSettled([
    repo.commitFile(root, publicWrite('notes/concurrent-slot-a.md', 'a', 'capacity_concurrent_a')),
    repo.commitFile(root, publicWrite('notes/concurrent-slot-b.md', 'b', 'capacity_concurrent_b')),
  ])
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1)
  const rejected = results.find(item => item.status === 'rejected')
  assert.ok(rejected && rejected.status === 'rejected')
  assert.ok(rejected.reason instanceof WorkspaceCapacityError)
  const capacity = await store.getCapacity(WORKSPACE)
  assert.equal(capacity?.published_paths.length, 500)
  const newHeads = await Promise.all([
    store.getFile(WORKSPACE, 'notes/concurrent-slot-a.md'),
    store.getFile(WORKSPACE, 'notes/concurrent-slot-b.md'),
  ])
  assert.equal(newHeads.filter(Boolean).length, 1, 'the losing write must not leave a staged head')
}

async function verifyCanonicalLiteratureCommitIsIdempotent(): Promise<void> {
  const { repo, store } = repository()
  const literatureAgent: WorkspaceActor = {
    ...member('agent_literature'),
    managedReferenceTool: true,
  }
  const input = {
    workspaceId: WORKSPACE,
    canonicalArtifactKey: 'arxiv:2608.00001:v1:fulltext',
    path: 'references/papers/arxiv-2608-00001/source-fulltext.md',
    storageRef: { driver: 'gridfs' as const, object_id: 'gridfs_arxiv_fulltext' },
    metadata: metadata('canonical full text'),
    writer: writer(literatureAgent.agentId, 'literature_fetch'),
    idempotencyKey: 'tool_use_fetch_arxiv_1',
  }
  const [first, duplicate] = await Promise.all([
    repo.commitManagedReference(literatureAgent, input),
    repo.commitManagedReference(literatureAgent, input),
  ])
  assert.equal(first.file.version_id, duplicate.file.version_id)
  assert.equal(first.file.revision, 1)
  assert.equal([first.created, duplicate.created].filter(Boolean).length, 1)
  assert.equal((await store.listFiles(WORKSPACE)).length, 1)
  assert.equal(
    (await store.getCanonicalArtifact(WORKSPACE, input.canonicalArtifactKey))?.status,
    'published',
  )

  await assert.rejects(
    repo.commitManagedReference(literatureAgent, {
      ...input,
      metadata: metadata('different bytes'),
      storageRef: { driver: 'gridfs', object_id: 'different_gridfs_object' },
      idempotencyKey: 'tool_use_fetch_arxiv_2',
    }),
    /different content/,
  )
}

async function verifyProposalAcceptCasAndRetarget(): Promise<void> {
  const { repo } = repository()
  const author = member('agent_author')
  const sourcePath = '.sci-pegasus/agents/agent_author/draft.md'
  await repo.commitFile(author, {
    workspaceId: WORKSPACE,
    path: sourcePath,
    expectedRevision: null,
    visibility: 'agent_private',
    ownerAgentId: author.agentId,
    storageRef: { driver: 'gridfs', object_id: 'gridfs_draft' },
    metadata: metadata('draft'),
    writer: writer(author.agentId, 'draft_run'),
  })

  const accepted = await repo.acceptProposalItem({
    workspaceId: WORKSPACE,
    sourcePath,
    targetPath: 'output/accepted.md',
    publicationKey: 'workspace-proposal:accepted:target-a',
    expectedTargetRevision: null,
    actor: root,
    writer: writer(ROOT_ID, 'review_accept'),
  })
  assert.equal(accepted.status, 'accepted')
  if (accepted.status === 'accepted') {
    assert.equal(accepted.file.storage_ref.driver, 'gridfs')
    assert.equal(accepted.file.publication_key, 'workspace-proposal:accepted:target-a')
    assert.equal(accepted.file.publication_source?.path, sourcePath)
    assert.equal(accepted.file.publication_source?.sha256, metadata('draft').sha256)
  }

  const replayedAfterTakeover = await repo.acceptProposalItem({
    workspaceId: WORKSPACE,
    sourcePath,
    targetPath: 'output/accepted.md',
    publicationKey: 'workspace-proposal:accepted:target-a',
    expectedTargetRevision: null,
    actor: root,
    writer: {
      ...writer(ROOT_ID, 'review_accept'),
      execution_fence_token: 'fence_after_runner_takeover',
    },
  })
  assert.equal(replayedAfterTakeover.status, 'accepted')
  if (accepted.status === 'accepted' && replayedAfterTakeover.status === 'accepted') {
    assert.equal(replayedAfterTakeover.file.revision, accepted.file.revision)
    assert.equal(replayedAfterTakeover.file.version_id, accepted.file.version_id)
  }

  const conflict = await repo.acceptProposalItem({
    workspaceId: WORKSPACE,
    sourcePath,
    targetPath: 'output/accepted.md',
    publicationKey: 'workspace-proposal:different-proposal:same-target',
    expectedTargetRevision: null,
    actor: root,
    writer: writer(ROOT_ID, 'review_conflict'),
  })
  assert.deepEqual(conflict, {
    status: 'conflict',
    code: 'target_revision_conflict',
    path: 'output/accepted.md',
    expectedRevision: null,
    actualRevision: 1,
  })

  const retargeted = await repo.acceptProposalItem({
    workspaceId: WORKSPACE,
    sourcePath,
    targetPath: 'output/retargeted.md',
    publicationKey: 'workspace-proposal:accepted:retargeted',
    expectedTargetRevision: null,
    actor: root,
    writer: writer(ROOT_ID, 'review_retarget'),
  })
  assert.equal(retargeted.status, 'accepted')

  await repo.commitFile(root, publicWrite('output/revisioned.md', 'old public draft', 'revisioned_seed'))
  const revisioned = await repo.acceptProposalItem({
    workspaceId: WORKSPACE,
    sourcePath,
    targetPath: 'output/revisioned.md',
    publicationKey: 'workspace-proposal:accepted:revisioned',
    expectedTargetRevision: 1,
    actor: root,
    writer: writer(ROOT_ID, 'review_revisioned'),
  })
  assert.equal(revisioned.status, 'accepted')
  if (revisioned.status === 'accepted') assert.equal(revisioned.file.revision, 2)
  const revisionedReplay = await repo.acceptProposalItem({
    workspaceId: WORKSPACE,
    sourcePath,
    targetPath: 'output/revisioned.md',
    publicationKey: 'workspace-proposal:accepted:revisioned',
    expectedTargetRevision: 1,
    actor: root,
    writer: {
      ...writer(ROOT_ID, 'review_revisioned'),
      execution_fence_token: 'fence_revisioned_takeover',
    },
  })
  assert.equal(revisionedReplay.status, 'accepted')
  if (revisionedReplay.status === 'accepted') assert.equal(revisionedReplay.file.revision, 2)

  await repo.commitFile(author, {
    workspaceId: WORKSPACE,
    path: sourcePath,
    expectedRevision: 1,
    visibility: 'agent_private',
    ownerAgentId: author.agentId,
    storageRef: { driver: 'gridfs', object_id: 'gridfs_changed_draft' },
    metadata: metadata('changed draft'),
    writer: writer(author.agentId, 'draft_changed_run'),
  })
  await assert.rejects(
    repo.acceptProposalItem({
      workspaceId: WORKSPACE,
      sourcePath,
      targetPath: 'output/accepted.md',
      publicationKey: 'workspace-proposal:accepted:target-a',
      expectedTargetRevision: null,
      actor: root,
      writer: writer(ROOT_ID, 'review_accept_after_source_change'),
    }),
    (error: unknown) => error instanceof WorkspaceProposalPublicationConflictError,
    'the same publication key must never replay against a different private source revision',
  )
}

async function verifyProposalItemsAcceptAndConflictIndependently(): Promise<void> {
  const { repo } = repository()
  const author = member('agent_partial_author')
  const firstSource = '.sci-pegasus/agents/agent_partial_author/first.md'
  const secondSource = '.sci-pegasus/agents/agent_partial_author/second.md'
  await Promise.all([
    repo.commitFile(author, {
      workspaceId: WORKSPACE,
      path: firstSource,
      expectedRevision: null,
      visibility: 'agent_private',
      ownerAgentId: author.agentId,
      storageRef: { driver: 'gridfs', object_id: 'gridfs_partial_first' },
      metadata: metadata('first proposal'),
      writer: writer(author.agentId, 'partial_first_source'),
    }),
    repo.commitFile(author, {
      workspaceId: WORKSPACE,
      path: secondSource,
      expectedRevision: null,
      visibility: 'agent_private',
      ownerAgentId: author.agentId,
      storageRef: { driver: 'gridfs', object_id: 'gridfs_partial_second' },
      metadata: metadata('second proposal'),
      writer: writer(author.agentId, 'partial_second_source'),
    }),
  ])
  await repo.commitFile(root, publicWrite('output/occupied.md', 'existing', 'partial_occupied'))

  const [accepted, conflicted] = await Promise.all([
    repo.acceptProposalItem({
      workspaceId: WORKSPACE,
      sourcePath: firstSource,
      targetPath: 'output/partial-accepted.md',
      publicationKey: 'workspace-proposal:partial:first',
      expectedTargetRevision: null,
      actor: root,
      writer: writer(ROOT_ID, 'partial_accept'),
    }),
    repo.acceptProposalItem({
      workspaceId: WORKSPACE,
      sourcePath: secondSource,
      targetPath: 'output/occupied.md',
      publicationKey: 'workspace-proposal:partial:second',
      expectedTargetRevision: null,
      actor: root,
      writer: writer(ROOT_ID, 'partial_conflict'),
    }),
  ])
  assert.equal(accepted.status, 'accepted')
  assert.deepEqual(conflicted, {
    status: 'conflict',
    code: 'target_revision_conflict',
    path: 'output/occupied.md',
    expectedRevision: null,
    actualRevision: 1,
  })
  assert.equal(
    (await repo.getFile(WORKSPACE, 'output/partial-accepted.md', root))?.metadata.sha256,
    metadata('first proposal').sha256,
    'a sibling conflict must not roll back an accepted proposal item',
  )
  assert.equal(
    (await repo.getFile(WORKSPACE, 'output/occupied.md', root))?.metadata.sha256,
    metadata('existing').sha256,
    'the conflicting target must keep its prior revision',
  )
}

function verifyMongooseSchemaContracts(): void {
  const fileIndexes = WorkspaceFile.schema.indexes() as Array<[
    Record<string, unknown>,
    { unique?: boolean },
  ]>
  assert.ok(fileIndexes.some(([keys, options]) => (
    keys.workspace_id === 1 && keys.path === 1 && options.unique === true
  )))
  assert.equal(WorkspaceFileRevision.schema.path('storage_ref').options.immutable, true)
  assert.equal(WorkspaceFileRevision.schema.path('metadata').options.immutable, true)
  assert.equal(WorkspaceFileRevision.schema.path('publication_key').options.immutable, true)
  assert.equal(WorkspaceFileRevision.schema.path('publication_source').options.immutable, true)
}

async function main(): Promise<void> {
  await verifyParallelPathsAndSamePathConflict()
  await verifyAclAndExplicitPrivateReference()
  await verifyCapacityBoundaryIsAtomic()
  await verifyReservedSetPublishesTogether()
  await verifyLostFenceCannotReserveOrPublish()
  await verifyFenceLostAtPublishBoundaryReleasesCapacity()
  await verifyConcurrent499To500BoundaryHasOneWinner()
  await verifyCanonicalLiteratureCommitIsIdempotent()
  await verifyProposalAcceptCasAndRetarget()
  await verifyProposalItemsAcceptAndConflictIndependently()
  verifyMongooseSchemaContracts()
  console.log('multi-agent-workspace:verify passed')
}

void main()
