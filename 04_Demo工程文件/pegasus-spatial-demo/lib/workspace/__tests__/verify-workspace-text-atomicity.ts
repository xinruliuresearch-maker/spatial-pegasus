import assert from 'node:assert/strict'
import { buildWorkspaceProjection } from '../../agent/compaction'
import { materialsDiscoveryWorkspace } from '../definitions/materials-discovery'
import {
  createWorkspaceInstance,
  type WorkspaceInstancePersistence,
} from '../instance'
import type { FileEntry, WorkspaceDocumentWrite } from '../types'

const TEXT_PATH = 'notes/atomic-write.md'
const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n', 'ascii')

function documentInput(): WorkspaceDocumentWrite {
  return {
    path: 'references/papers/concurrent/original.pdf',
    buffer: PDF,
    filename: 'concurrent.pdf',
    mimeType: 'application/pdf',
    source: { provider: 'test' },
    provenance: { retrieved_at: '2026-08-07T00:00:00.000Z' },
  }
}

function persistence(
  writeTextFile: WorkspaceInstancePersistence['writeTextFile'],
  writeDocumentFile: WorkspaceInstancePersistence['writeDocumentFile'] = async () => 'document-gridfs-id',
): WorkspaceInstancePersistence {
  return { writeTextFile, writeDocumentFile }
}

async function verifyGridFsFailureLeavesNoGhost(): Promise<void> {
  let indexCalls = 0
  const workspace = createWorkspaceInstance(
    materialsDiscoveryWorkspace,
    {},
    {},
    {
      conversationId: 'conversation-gridfs-failure',
      onFilesUpdate: async () => { indexCalls += 1 },
    },
    persistence(async () => { throw new Error('gridfs unavailable') }),
  )

  await assert.rejects(workspace.writeText(TEXT_PATH, 'ghost'), /gridfs unavailable/)
  assert.equal(workspace.exists(TEXT_PATH), false)
  assert.equal(await workspace.readText(TEXT_PATH), null)
  assert.equal(await workspace.stat(TEXT_PATH), null)
  assert.deepEqual(workspace.list(), [])
  assert.equal(indexCalls, 0)
}

async function verifyIndexFailureRestoresExistingValue(): Promise<void> {
  let upload = 0
  let failIndex = false
  const workspace = createWorkspaceInstance(
    materialsDiscoveryWorkspace,
    {},
    {},
    {
      conversationId: 'conversation-index-failure',
      onFilesUpdate: async () => {
        if (failIndex) throw new Error('index unavailable')
      },
    },
    persistence(async () => `text-gridfs-${++upload}`),
  )

  await workspace.writeText(TEXT_PATH, 'committed')
  failIndex = true
  await assert.rejects(workspace.writeText(TEXT_PATH, 'uncommitted'), /index unavailable/)

  assert.equal(workspace.exists(TEXT_PATH), true)
  assert.equal(await workspace.readText(TEXT_PATH), 'committed')
  assert.equal((await workspace.stat(TEXT_PATH))?.version, 1)
  assert.deepEqual(workspace.list(), [TEXT_PATH])

  failIndex = false
  await workspace.writeText(TEXT_PATH, 'next committed')
  assert.equal(await workspace.readText(TEXT_PATH), 'next committed')
  assert.equal((await workspace.stat(TEXT_PATH))?.version, 2)
  assert.deepEqual(workspace.list(), [
    '.sci-pegasus/versions/notes/atomic-write/v1.md',
    TEXT_PATH,
  ])
}

async function verifyConcurrentWritesAndUnrelatedCommit(): Promise<void> {
  let releaseUpload!: () => void
  let markUploadStarted!: () => void
  const uploadStarted = new Promise<void>(resolve => { markUploadStarted = resolve })
  const uploadGate = new Promise<void>(resolve => { releaseUpload = resolve })
  const persistedSnapshots: Record<string, FileEntry>[] = []

  const workspace = createWorkspaceInstance(
    materialsDiscoveryWorkspace,
    {},
    {},
    {
      conversationId: 'conversation-concurrent',
      onFilesUpdate: async files => {
        persistedSnapshots.push({ ...files })
      },
    },
    persistence(async () => {
      markUploadStarted()
      await uploadGate
      return 'text-gridfs-id'
    }),
  )

  const textWrite = workspace.writeText(TEXT_PATH, 'text')
  await uploadStarted
  const document = await workspace.writeDocument(documentInput())
  releaseUpload()
  await textWrite

  assert.equal((await workspace.readDocument(document.path))?.sha256, document.sha256)
  assert.equal(await workspace.readText(TEXT_PATH), 'text')
  assert.ok(
    persistedSnapshots.at(-1)?.[document.path],
    'the text index snapshot must include an unrelated commit completed during GridFS upload',
  )

  const projection = await buildWorkspaceProjection(workspace)
  assert.match(projection.content, /atomic-write\.md/)
  assert.match(projection.content, /original\.pdf/)
}

async function main(): Promise<void> {
  await verifyGridFsFailureLeavesNoGhost()
  await verifyIndexFailureRestoresExistingValue()
  await verifyConcurrentWritesAndUnrelatedCommit()
  console.log('workspace-text-atomicity:verify passed')
}

void main()
