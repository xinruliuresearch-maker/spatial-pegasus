import assert from 'node:assert/strict'
import { materialsDiscoveryWorkspace } from '../../workspace/definitions/materials-discovery'
import {
  createWorkspaceInstance,
  type WorkspaceInstancePersistence,
} from '../../workspace/instance'
import {
  createMultiAgentWorkspaceBridge,
  InMemoryMultiAgentWorkspaceStore,
  MultiAgentWorkspaceRepository,
  WorkspaceCapacityError,
  type WorkspaceActor,
  type WorkspaceWriterProvenance,
} from '../../workspace/multi-agent'
import type { PdfParserPort } from '../../document-parsers/types'
import {
  FetchPaperMaterializationError,
  LiteratureService,
} from '../service'
import type {
  FetchedLiteraturePaper,
  LiteratureProvider,
  LiteratureProviderRegistry,
} from '../types'

const TEAM = 'team_literature_reservation'
const ROOT = 'agent_root'
const SCIVERSE_ID = 'b'.repeat(64)
const ARXIV_ID = '2608.01234v1'
const PDF = Buffer.from('%PDF-1.7\nreservation fixture')
let objectId = 0
let versionId = 0

function actor(): WorkspaceActor {
  return {
    teamId: TEAM,
    agentId: ROOT,
    rootAgentId: ROOT,
    role: 'root',
    managedReferenceTool: true,
  }
}

function writer(runId: string): WorkspaceWriterProvenance {
  return {
    team_id: TEAM,
    agent_id: ROOT,
    run_id: runId,
    execution_fence_token: `fence_${runId}`,
  }
}

function persistence(bytes: Map<string, Buffer>): Partial<WorkspaceInstancePersistence> {
  return {
    async writeTextFile(_conversationId, _path, content) {
      const id = `text_${++objectId}`
      bytes.set(id, Buffer.from(content, 'utf8'))
      return id
    },
    async writeDocumentFile(_conversationId, _path, buffer) {
      const id = `document_${++objectId}`
      bytes.set(id, Buffer.from(buffer))
      return id
    },
    async readTextFile(id) {
      return bytes.get(id)?.toString('utf8') ?? null
    },
    async readBufferFile(id, range) {
      const buffer = bytes.get(id)
      if (!buffer) return null
      return range ? Buffer.from(buffer.subarray(range.start, range.endExclusive)) : Buffer.from(buffer)
    },
  }
}

function repository(store: InMemoryMultiAgentWorkspaceStore, maxFiles = 500) {
  return new MultiAgentWorkspaceRepository({
    store,
    maxFiles,
    versionId: () => `literature_reservation_version_${++versionId}`,
    fenceValidator: () => true,
  })
}

async function workspaceFor(
  repo: MultiAgentWorkspaceRepository,
  bytes: Map<string, Buffer>,
  workspaceId: string,
  runId: string,
) {
  const bridge = await createMultiAgentWorkspaceBridge({
    repository: repo,
    workspaceId,
    actor: actor(),
    writer: writer(runId),
    readEntryBytes: async (_path, entry) => (
      'gridfs_id' in entry ? Buffer.from(bytes.get(entry.gridfs_id) ?? Buffer.alloc(0)) : null
    ),
    fileSetPollMs: 10,
    fileSetWaitMs: 2_000,
    fileSetStaleMs: 5_000,
  })
  return createWorkspaceInstance(
    materialsDiscoveryWorkspace,
    bridge.projectedFiles,
    {},
    {
      conversationId: workspaceId,
      onFileMutations: bridge.onFileMutations,
      onFileSetBegin: bridge.onFileSetBegin,
      onFileSetFinalize: bridge.onFileSetFinalize,
      onFileSetAbort: bridge.onFileSetAbort,
    },
    persistence(bytes),
  )
}

function sciverseFetch(): FetchedLiteraturePaper {
  return {
    source: 'sciverse',
    paper: {
      ref: { source: 'sciverse', sourceId: SCIVERSE_ID, documentId: SCIVERSE_ID },
      title: 'Canonical electrolyte paper',
      authors: ['Fixture'],
    },
    content: {
      kind: 'fulltext',
      text: '# Canonical full text\nshared materialization',
      mimeType: 'text/markdown',
      filename: 'source-fulltext.md',
    },
    retrievedAt: '2026-08-08T00:00:00.000Z',
  }
}

function arxivFetch(): FetchedLiteraturePaper {
  return {
    source: 'arxiv',
    paper: {
      ref: { source: 'arxiv', sourceId: ARXIV_ID, version: 'v1' },
      title: 'Recoverable PDF paper',
      authors: ['Fixture'],
    },
    content: {
      kind: 'pdf',
      buffer: Buffer.from(PDF),
      mimeType: 'application/pdf',
      filename: `${ARXIV_ID}.pdf`,
      canonicalUrl: `https://arxiv.org/pdf/${ARXIV_ID}`,
    },
    retrievedAt: '2026-08-08T00:00:00.000Z',
  }
}

function registry(
  counts: Record<string, number>,
  delayMs = 0,
): LiteratureProviderRegistry {
  const sciverse: LiteratureProvider = {
    source: 'sciverse',
    async searchPapers() { throw new Error('not used') },
    async fetchPaper() {
      counts.sciverse = (counts.sciverse ?? 0) + 1
      if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs))
      return sciverseFetch()
    },
  }
  const arxiv: LiteratureProvider = {
    source: 'arxiv',
    async searchPapers() { throw new Error('not used') },
    async fetchPaper() {
      counts.arxiv = (counts.arxiv ?? 0) + 1
      return arxivFetch()
    },
  }
  return new Map([
    ['sciverse', sciverse],
    ['arxiv', arxiv],
  ])
}

function parser(fail: boolean): PdfParserPort {
  return {
    async parse() {
      if (fail) throw new Error('intentional parser failure')
      return {
        markdown: '# Parsed\nrecovered without another download\n',
        pages: [{ page: 1, text: 'recovered without another download' }],
        blocks: [{
          blockId: 'page-1-block-1',
          page: 1,
          index: 1,
          type: 'text',
          text: 'recovered without another download',
        }],
        totalPages: 1,
        parsedPages: [1],
        parser: { name: 'pdf-parse', version: '2.4.5' },
        warnings: [],
      }
    },
  }
}

async function verifyDistributedFetchCoalesces(): Promise<void> {
  const store = new InMemoryMultiAgentWorkspaceStore()
  const repo = repository(store)
  const bytes = new Map<string, Buffer>()
  const workspaceId = 'workspace_literature_distributed'
  const left = await workspaceFor(repo, bytes, workspaceId, 'run_left')
  const right = await workspaceFor(repo, bytes, workspaceId, 'run_right')
  const counts: Record<string, number> = {}
  const providers = registry(counts, 30)

  const [first, joined] = await Promise.all([
    new LiteratureService(left, providers).fetchPaper({ source: 'sciverse', sourceId: SCIVERSE_ID }),
    new LiteratureService(right, providers).fetchPaper({ source: 'sciverse', sourceId: SCIVERSE_ID }),
  ])
  assert.equal(counts.sciverse, 1, 'separate WorkspaceInstances must share one provider flight')
  assert.deepEqual(
    [first.downloadBytes, joined.downloadBytes].sort((a, b) => a - b),
    [0, Buffer.byteLength('# Canonical full text\nshared materialization')],
  )
  assert.equal((await repo.listFiles(workspaceId, actor())).length, 3)
  assert.equal(first.fullText, joined.fullText)
}

async function verifyCapacityFailsBeforeNetwork(): Promise<void> {
  const store = new InMemoryMultiAgentWorkspaceStore()
  const repo = repository(store)
  const workspaceId = 'workspace_literature_capacity'
  await repo.initializeCapacity(
    workspaceId,
    Array.from({ length: 499 }, (_, index) => `notes/existing-${index}.md`),
  )
  const bytes = new Map<string, Buffer>()
  const workspace = await workspaceFor(repo, bytes, workspaceId, 'run_capacity')
  const counts: Record<string, number> = {}
  await assert.rejects(
    new LiteratureService(workspace, registry(counts)).fetchPaper({
      source: 'sciverse',
      sourceId: SCIVERSE_ID,
    }),
    WorkspaceCapacityError,
  )
  assert.equal(counts.sciverse ?? 0, 0, 'capacity must be reserved before provider I/O')
  assert.equal((await store.listFiles(workspaceId)).length, 0, 'capacity rejection leaves no staged heads')
}

async function verifyParserFailureCanResumeWithoutDownload(): Promise<void> {
  const store = new InMemoryMultiAgentWorkspaceStore()
  const repo = repository(store)
  const bytes = new Map<string, Buffer>()
  const workspaceId = 'workspace_literature_parser_resume'
  const workspace = await workspaceFor(repo, bytes, workspaceId, 'run_parser')
  const counts: Record<string, number> = {}
  const providers = registry(counts)

  await assert.rejects(
    new LiteratureService(workspace, providers, { pdfParser: parser(true) }).fetchPaper({
      source: 'arxiv',
      sourceId: ARXIV_ID,
    }),
    FetchPaperMaterializationError,
  )
  assert.equal(counts.arxiv, 1)
  assert.equal((await repo.listFiles(workspaceId, actor())).length, 3, 'PDF core is published as a recoverable subset')

  const recovered = await new LiteratureService(workspace, providers, {
    pdfParser: parser(false),
  }).fetchPaper({ source: 'arxiv', sourceId: ARXIV_ID })
  assert.equal(recovered.downloadBytes, 0)
  assert.equal(counts.arxiv, 1, 'retry parses the canonical PDF without another provider call')
  assert.equal((await repo.listFiles(workspaceId, actor())).length, 6)
  assert.match(recovered.fullText, /recovered without another download/)
}

async function main(): Promise<void> {
  await verifyDistributedFetchCoalesces()
  await verifyCapacityFailsBeforeNetwork()
  await verifyParserFailureCanResumeWithoutDownload()
  console.log('literature-reservations:verify passed')
}

void main()
