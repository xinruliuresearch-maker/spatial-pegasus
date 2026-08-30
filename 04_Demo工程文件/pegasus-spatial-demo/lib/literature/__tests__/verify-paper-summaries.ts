import assert from 'node:assert/strict'
import {
  buildLiteraturePaperSummaries,
  extractFirstPaperHeading,
  extractPaperTitleFromMetadata,
  MAX_PAPER_SUMMARY_FILES,
  PAPER_SUMMARY_READ_CONCURRENCY,
  parsePaperSummaryDirectory,
  parsePaperSummaryFile,
  type LiteraturePaperSummaryFile,
} from '../paper-summaries'

const DOC_ID = 'a'.repeat(64)
const SCIVERSE_DIRECTORY = `references/papers/sciverse-${DOC_ID}-0123456789`
const ARXIV_DIRECTORY = 'references/papers/arxiv-2608.01234v2-abcdef0123'

assert.deepEqual(parsePaperSummaryDirectory(SCIVERSE_DIRECTORY), {
  directory: SCIVERSE_DIRECTORY,
  source: 'sciverse',
  sourceId: DOC_ID,
  shortId: `${'a'.repeat(12)}…`,
})
assert.equal(
  parsePaperSummaryFile(`${ARXIV_DIRECTORY}/parsed/fulltext.md`)?.relativePath,
  'parsed/fulltext.md',
)
assert.equal(parsePaperSummaryFile('../references/papers/bad/metadata.json'), null)
assert.equal(parsePaperSummaryFile(`${SCIVERSE_DIRECTORY}/secrets.json`), null)

const sciverseIdentity = parsePaperSummaryDirectory(SCIVERSE_DIRECTORY)
assert.ok(sciverseIdentity)
assert.equal(extractPaperTitleFromMetadata(JSON.stringify({
  paper: {
    title: '  A real   paper title ',
    ref: { sourceId: DOC_ID, documentId: DOC_ID },
  },
}), sciverseIdentity), 'A real paper title')
assert.equal(extractPaperTitleFromMetadata(JSON.stringify({
  paper: {
    title: `Sciverse document ${DOC_ID}`,
    ref: { sourceId: DOC_ID },
  },
}), sciverseIdentity), undefined)
assert.equal(extractFirstPaperHeading('Lead in\n\n# **Readable** [paper](https://example.test) title\n'), 'Readable paper title')

const contents = new Map<string, string>()
const file = (
  path: string,
  visibility: LiteraturePaperSummaryFile['visibility'] = 'managed_reference',
): LiteraturePaperSummaryFile => ({ path, visibility, sizeBytes: contents.get(path)?.length ?? 128 })

const sciverseMetadata = `${SCIVERSE_DIRECTORY}/metadata.json`
const sciverseFulltext = `${SCIVERSE_DIRECTORY}/source-fulltext.md`
contents.set(sciverseMetadata, JSON.stringify({ paper: { title: 'Untitled', ref: { sourceId: DOC_ID } } }))
contents.set(sciverseFulltext, '# Reconstructed title from full text\n\n## Abstract')

const arxivMetadata = `${ARXIV_DIRECTORY}/metadata.json`
const arxivPdf = `${ARXIV_DIRECTORY}/original.pdf`
contents.set(arxivMetadata, JSON.stringify({ paper: { title: 'Original arXiv paper' } }))

const privateDirectory = 'references/papers/arxiv-2608.99999-1111111111'
const summaries = await buildLiteraturePaperSummaries([
  file(sciverseMetadata),
  file(sciverseFulltext),
  file(arxivMetadata, 'public'),
  file(arxivPdf, 'public'),
  file(`${privateDirectory}/metadata.json`, 'agent_private'),
], async (entry, maxBytes) => contents.get(entry.path)?.slice(0, maxBytes) ?? null)

assert.deepEqual(summaries, [
  {
    directory: ARXIV_DIRECTORY,
    title: 'Original arXiv paper',
    source: 'arxiv',
    primaryPath: arxivPdf,
  },
  {
    directory: SCIVERSE_DIRECTORY,
    title: 'Reconstructed title from full text',
    source: 'sciverse',
    primaryPath: sciverseFulltext,
  },
])

contents.set(sciverseMetadata, JSON.stringify({ paper: { title: 'reconstructed title from full text', ref: { sourceId: DOC_ID } } }))
const casingSummary = await buildLiteraturePaperSummaries(
  [file(sciverseMetadata), file(sciverseFulltext)],
  async (entry, maxBytes) => contents.get(entry.path)?.slice(0, maxBytes) ?? null,
)
assert.equal(casingSummary[0]?.title, 'Reconstructed title from full text')

const manyFiles = Array.from({ length: MAX_PAPER_SUMMARY_FILES + 1 }, (_, index) => {
  const hash = index.toString(16).padStart(10, '0')
  return file(`references/papers/arxiv-2608.${index.toString().padStart(5, '0')}-${hash}/metadata.json`, 'public')
})
const bounded = await buildLiteraturePaperSummaries(manyFiles, async () => null)
assert.equal(bounded.length, MAX_PAPER_SUMMARY_FILES)

let activeReads = 0
let peakReads = 0
await buildLiteraturePaperSummaries(manyFiles.slice(0, 40), async () => {
  activeReads += 1
  peakReads = Math.max(peakReads, activeReads)
  await new Promise(resolve => setTimeout(resolve, 2))
  activeReads -= 1
  return null
})
assert.ok(peakReads > 1, 'summary reads should use a small worker pool')
assert.ok(
  peakReads <= PAPER_SUMMARY_READ_CONCURRENCY,
  `summary reads must stay within ${PAPER_SUMMARY_READ_CONCURRENCY} workers`,
)

console.log('literature paper summary verification passed')
