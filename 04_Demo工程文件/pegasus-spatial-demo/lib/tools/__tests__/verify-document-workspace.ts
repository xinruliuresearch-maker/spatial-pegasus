import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { buildWorkspaceProjection } from '../../agent/compaction'
import { executeGlob } from '../glob'
import { executRead } from '../read'
import { createInMemoryWorkspace } from '../__test-utils__/in-memory-workspace'
import type { WorkspaceDocumentWrite } from '../../workspace/types'

const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n', 'ascii')
const GLB = (() => {
  const value = Buffer.alloc(24)
  value.write('glTF', 0, 'ascii')
  value.writeUInt32LE(2, 4)
  value.writeUInt32LE(value.length, 8)
  value.writeUInt32LE(4, 12)
  value.writeUInt32LE(0x4e4f534a, 16)
  value.write('{}  ', 20, 'ascii')
  return value
})()
const PLY = Buffer.from([
  'ply',
  'format ascii 1.0',
  'element vertex 1',
  'property float x',
  'property float y',
  'property float z',
  'end_header',
  '0 0 0',
  '',
].join('\n'), 'ascii')
const SPZ = gzipSync(Buffer.from('pegasus-spatial-test-splat', 'utf8'))

function documentInput(buffer = PDF): WorkspaceDocumentWrite {
  return {
    path: 'references/papers/arxiv-1234/original.pdf',
    buffer,
    filename: 'arxiv-1234.pdf',
    mimeType: 'application/pdf; charset=binary',
    source: {
      provider: 'arxiv',
      canonical_url: 'https://arxiv.org/abs/1234.5678',
      external_id: '1234.5678v1',
    },
    provenance: {
      retrieved_at: '2026-08-07T00:00:00.000Z',
      version: 'v1',
      license: 'arXiv.org perpetual, non-exclusive license',
      provenance_path: 'references/papers/arxiv-1234/provenance.json',
    },
  }
}

function modelInput(buffer = GLB): WorkspaceDocumentWrite {
  return {
    path: 'output/spatial/objects/chair-a/model.glb',
    buffer,
    filename: 'chair-a.glb',
    mimeType: 'model/gltf-binary',
    source: {
      provider: 'lux3d',
      external_id: 'lux-task-a',
    },
    provenance: {
      retrieved_at: '2026-08-25T00:00:00.000Z',
      version: 'G1',
    },
  }
}

function worldDocumentInput(
  format: 'ply' | 'spz',
  buffer = format === 'ply' ? PLY : SPZ,
): WorkspaceDocumentWrite {
  return {
    path: `output/spatial/worlds/world-a/world.${format}`,
    buffer,
    filename: `world-a.${format}`,
    mimeType: format === 'ply' ? 'application/ply' : 'application/vnd.aholo.spz',
    source: {
      provider: 'aholo',
      external_id: 'world-a',
    },
    provenance: {
      retrieved_at: '2026-08-25T00:00:00.000Z',
      version: 'world-generation-v1',
    },
  }
}

async function verifyDocumentLifecycle(): Promise<void> {
  const workspace = createInMemoryWorkspace()
  const input = documentInput()
  const expectedHash = createHash('sha256').update(PDF).digest('hex')

  const written = await workspace.writeDocument(input)
  assert.equal(written.path, input.path)
  assert.equal(written.mimeType, 'application/pdf')
  assert.equal(written.sizeBytes, PDF.length)
  assert.equal(written.sha256, expectedHash)
  assert.equal(written.source.provider, 'arxiv')

  assert.deepEqual(await workspace.readDocument(input.path), written)
  assert.deepEqual(await workspace.readDocumentBuffer(input.path), PDF)
  assert.equal(await workspace.readText(input.path), null)

  const stat = await workspace.stat(input.path)
  assert.equal(stat?.kind, 'document')
  assert.equal(stat?.sha256, expectedHash)
  assert.equal(stat?.filename, input.filename)

  const idempotent = await workspace.writeDocument(input)
  assert.deepEqual(idempotent, written)
  assert.equal(Object.keys(workspace.dumpDocuments()).length, 1)

  const glob = await executeGlob({ pattern: '**/*.pdf', kind: 'document' }, workspace)
  assert.match(glob.content, /original\.pdf · document · application\/pdf/)

  const read = await executRead({ file_path: input.path }, workspace, new Map())
  assert.equal(read.is_error, undefined)
  assert.match(read.content, /Binary document bytes are intentionally not returned/)
  assert.match(read.content, new RegExp(expectedHash))
  assert.doesNotMatch(read.content, /1 0 obj/)

  const projection = await buildWorkspaceProjection(workspace)
  assert.match(projection.content, /original\.pdf \[document; application\/pdf;/)
}

async function verifyGlbLifecycle(): Promise<void> {
  const workspace = createInMemoryWorkspace()
  const input = modelInput()
  const expectedHash = createHash('sha256').update(GLB).digest('hex')

  const written = await workspace.writeDocument(input)
  assert.equal(written.mimeType, 'model/gltf-binary')
  assert.equal(written.sha256, expectedHash)
  assert.deepEqual(await workspace.readDocumentBuffer(input.path), GLB)

  const glob = await executeGlob({ pattern: 'output/spatial/**/*.glb', kind: 'document' }, workspace)
  assert.match(glob.content, /model\.glb · document · model\/gltf-binary/)

  const malformed = Buffer.from(GLB)
  malformed.writeUInt32LE(GLB.length + 1, 8)
  await assert.rejects(
    createInMemoryWorkspace().writeDocument(modelInput(malformed)),
    /valid GLB 2\.0 container/,
  )
  await assert.rejects(
    createInMemoryWorkspace().writeDocument({ ...modelInput(), path: 'output/spatial/objects/chair-a/model.pdf' }),
    /extension does not match/,
  )
}

async function verifyWorldDocumentLifecycle(): Promise<void> {
  for (const format of ['ply', 'spz'] as const) {
    const workspace = createInMemoryWorkspace()
    const input = worldDocumentInput(format)
    const written = await workspace.writeDocument(input)
    assert.equal(written.mimeType, input.mimeType)
    assert.equal(written.sha256, createHash('sha256').update(input.buffer).digest('hex'))
    assert.deepEqual(await workspace.readDocumentBuffer(input.path), input.buffer)

    const glob = await executeGlob({
      pattern: `output/spatial/worlds/**/*.${format}`,
      kind: 'document',
    }, workspace)
    assert.match(glob.content, new RegExp(`world\\.${format} · document`))
  }

  await assert.rejects(
    createInMemoryWorkspace().writeDocument(worldDocumentInput('ply', Buffer.from('not-ply'))),
    /valid PLY 1\.0 header/,
  )
  await assert.rejects(
    createInMemoryWorkspace().writeDocument(worldDocumentInput('spz', Buffer.from('not-spz'))),
    /SPZ gzip header/,
  )
  await assert.rejects(
    createInMemoryWorkspace().writeDocument({
      ...worldDocumentInput('ply'),
      path: 'output/spatial/worlds/world-a/world.spz',
    }),
    /extension does not match/,
  )
}

async function verifyValidationAndImmutability(): Promise<void> {
  const workspace = createInMemoryWorkspace()
  const input = documentInput()
  await workspace.writeDocument(input)

  await assert.rejects(
    workspace.writeDocument(documentInput(Buffer.from('%PDF-1.7\ndifferent\n%%EOF\n', 'ascii'))),
    /already exists with different content/,
  )
  await assert.rejects(
    workspace.writeDocument({ ...input, path: 'references/papers/arxiv-1234/original.txt' }),
    /must end in \.pdf, \.glb, \.ply, or \.spz/,
  )
  await assert.rejects(
    workspace.write('references/papers/arxiv-1234/other.pdf', 'not a pdf'),
    /writeDocument/,
  )
  await assert.rejects(
    createInMemoryWorkspace().writeDocument(documentInput(Buffer.from('<html>upstream error</html>'))),
    /PDF magic header/,
  )
  await assert.rejects(
    createInMemoryWorkspace().writeDocument({ ...input, mimeType: 'text/html' }),
    /Unsupported document MIME type/,
  )
  await assert.rejects(
    createInMemoryWorkspace().writeDocument({ ...input, filename: '../paper.pdf' }),
    /filename is invalid/,
  )
  await assert.rejects(
    createInMemoryWorkspace().writeDocument({
      ...input,
      source: { provider: 'arxiv', canonical_url: 'javascript:alert(1)' },
    }),
    /must use http or https/,
  )
  await assert.rejects(
    createInMemoryWorkspace().writeDocument({ ...input, buffer: Buffer.alloc(0) }),
    /cannot be empty/,
  )
}

async function main(): Promise<void> {
  await verifyDocumentLifecycle()
  await verifyGlbLifecycle()
  await verifyWorldDocumentLifecycle()
  await verifyValidationAndImmutability()
  console.log('document-workspace:verify passed')
}

void main()
