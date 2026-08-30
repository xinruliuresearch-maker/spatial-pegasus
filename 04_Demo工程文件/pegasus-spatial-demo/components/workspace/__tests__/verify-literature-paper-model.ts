import assert from 'node:assert/strict'
import type { WorkspaceArtifact } from '@/hooks/useWorkspaceArtifacts'
import {
  classifyScientificImageSource,
  collectLiteratureBundleArtifacts,
  extractDoiFromMarkdown,
  extractFirstMarkdownHeading,
  isPlaceholderTitle,
  normalizeAuthors,
  parseLiteratureArtifactPath,
  parseLiteratureMetadata,
  parseLiteratureProvenance,
  resolvePaperTitle,
  safeHttpUrl,
  splitScientificFrontMatter,
  stripFirstMarkdownHeading,
} from '../literature-paper-model'

const DOC_ID = 'a'.repeat(64)
const DIRECTORY = `references/papers/sciverse-${DOC_ID}-0123456789`
const SOURCE_PATH = `${DIRECTORY}/source-fulltext.md`

function artifact(path: string, type: WorkspaceArtifact['type'] = 'text'): WorkspaceArtifact {
  return { path, type, label: path.split('/').at(-1) ?? path, content: '' }
}

const sourceIdentity = parseLiteratureArtifactPath(SOURCE_PATH)
assert.deepEqual(sourceIdentity, {
  directory: DIRECTORY,
  source: 'sciverse',
  sourceId: DOC_ID,
  shortId: `${'a'.repeat(12)}…`,
  role: 'source-fulltext',
})

const arxivIdentity = parseLiteratureArtifactPath(
  'references/papers/arxiv-2608.01234v2-ffffffffff/parsed/fulltext.md',
)
assert.equal(arxivIdentity?.source, 'arxiv')
assert.equal(arxivIdentity?.sourceId, '2608.01234v2')
assert.equal(arxivIdentity?.role, 'parsed-fulltext')
assert.equal(parseLiteratureArtifactPath('references/searches/search-1.json'), null)

const bundle = collectLiteratureBundleArtifacts(SOURCE_PATH, [
  artifact(SOURCE_PATH, 'markdown'),
  artifact(`${DIRECTORY}/metadata.json`),
  artifact(`${DIRECTORY}/provenance.json`),
  artifact('references/papers/sciverse-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-0123456789/metadata.json'),
])
assert.equal(bundle.sourceFulltext?.path, SOURCE_PATH)
assert.equal(bundle.metadata?.path, `${DIRECTORY}/metadata.json`)
assert.equal(bundle.provenance?.path, `${DIRECTORY}/provenance.json`)

const metadata = parseLiteratureMetadata(JSON.stringify({
  schemaVersion: 1,
  paper: {
    ref: {
      source: 'sciverse',
      sourceId: DOC_ID,
      uniqueId: 'doi:10.1000/example',
      documentId: DOC_ID,
    },
    title: `Sciverse document ${DOC_ID}`,
    authors: ['Ada  Lovelace', 'Ada Lovelace', { name: 'Grace Hopper' }, 'ada lovelace'],
    abstract: '  A structured   abstract. ',
    venue: 'Journal of Test Materials',
    publishedYear: 2026,
    doi: '10.1000/example',
    landingUrl: 'https://example.test/paper',
    citationCount: 42,
    influentialCitationCount: 7,
    categories: ['Materials Science', 'Materials Science'],
  },
  storedContent: {
    path: SOURCE_PATH,
    kind: 'fulltext',
    mimeType: 'text/markdown',
  },
}))
assert.ok(metadata)
assert.deepEqual(metadata.authors, ['Ada Lovelace', 'Grace Hopper'])
assert.deepEqual(metadata.categories, ['Materials Science'])
assert.equal(metadata.abstract, 'A structured abstract.')
assert.equal(metadata.citationCount, 42)
assert.equal(isPlaceholderTitle(metadata.title ?? '', metadata.ref), true)

assert.deepEqual(
  normalizeAuthors(['Ａｄａ', 'Ada', 'Ada ', 'Grace  Hopper', 'Grace Hopper']),
  ['Ada', 'Grace Hopper'],
)
assert.deepEqual(
  normalizeAuthors([
    'martinez-manez, ramon',
    'ramón martínez-máñez',
    'gonzalezalvarez, isabel',
    'isabel González-Álvarez',
  ]),
  ['ramón martínez-máñez', 'isabel González-Álvarez'],
)

const markdown = 'Review\n\n# **A readable paper title**\n\n## Abstract\nText.'
assert.equal(extractFirstMarkdownHeading(markdown), 'A readable paper title')
assert.match(stripFirstMarkdownHeading(markdown), /## Abstract/)
assert.match(stripFirstMarkdownHeading(markdown), /^Review/)
assert.doesNotMatch(stripFirstMarkdownHeading(markdown), /readable paper title/)
assert.equal(resolvePaperTitle(metadata, markdown, sourceIdentity!), 'A readable paper title')
const lateHeading = `${'x'.repeat(2_049)}\n# This is a section, not a document title`
assert.equal(extractFirstMarkdownHeading(lateHeading), undefined)
assert.equal(stripFirstMarkdownHeading(lateHeading), lateHeading)

const legacyPublisherPaper = [
  'A. DI SABATINO*, R. MORERA*, R. CICCOCIOPPO*',
  '',
  '*First Department of Medicine and University of Pavia, Italy',
  '',
  'Accepted for publication 21 July 2005',
  '',
  '# SUMMARY',
  '',
  'Background: Butyrate exerts anti-inflammatory effects.',
].join('\n')
const legacySections = splitScientificFrontMatter(legacyPublisherPaper)
assert.match(legacySections.frontMatter ?? '', /DI SABATINO/)
assert.match(legacySections.frontMatter ?? '', /Accepted for publication/)
assert.doesNotMatch(legacySections.frontMatter ?? '', /SUMMARY|Background/)
assert.match(legacySections.body, /^# SUMMARY/)
assert.match(legacySections.body, /Background: Butyrate/)

const inlineAbstractPaper = [
  'Review',
  '',
  'Adrian H. Teruel, Isabel Gonzalez-Alvarez',
  '',
  'Received: 14 July 2020; Accepted: 2 September 2020',
  '',
  'Abstract: Colonic drug delivery systems are advantageous.',
  '',
  'The work concludes that important questions remain.',
  '',
  'Keywords: intestinal permeability; colon',
  '',
  '# 1. Introduction',
].join('\n')
const inlineAbstractSections = splitScientificFrontMatter(inlineAbstractPaper)
assert.match(inlineAbstractSections.frontMatter ?? '', /Adrian H\. Teruel/)
assert.doesNotMatch(inlineAbstractSections.frontMatter ?? '', /Abstract|Keywords/)
assert.match(inlineAbstractSections.body, /^# Abstract/)
assert.match(inlineAbstractSections.body, /Colonic drug delivery systems/)
assert.match(inlineAbstractSections.body, /Keywords: intestinal permeability/)

const immediateAbstract = splitScientificFrontMatter('Abstract: Directly after the title.\n\n# Introduction')
assert.equal(immediateAbstract.frontMatter, undefined)
assert.match(immediateAbstract.body, /^# Abstract/)

const ordinaryLead = 'This short orientation paragraph is part of the article.\n\n# Introduction\n\nBody.'
assert.deepEqual(splitScientificFrontMatter(ordinaryLead), { body: ordinaryLead })

const lifecycleLead = 'J. Example and A. Author\n\nAccepted for publication 2 May 2025\n\n# Introduction\n\nBody.'
const lifecycleSections = splitScientificFrontMatter(lifecycleLead)
assert.match(lifecycleSections.frontMatter ?? '', /Accepted for publication/)
assert.match(lifecycleSections.body, /^# Introduction/)
assert.equal(
  extractDoiFromMarkdown('Int. J. Mol. Sci. 2020, 21, 6502; doi:10.3390/ijms21186502.'),
  '10.3390/ijms21186502',
)

const realMetadata = parseLiteratureMetadata(JSON.stringify({
  paper: {
    ref: { source: 'sciverse', sourceId: DOC_ID },
    title: 'Interfacial transport in a model material',
    authors: [],
  },
}))
assert.equal(resolvePaperTitle(realMetadata, markdown, sourceIdentity!), 'Interfacial transport in a model material')
const lowerCaseMetadata = parseLiteratureMetadata(JSON.stringify({
  paper: {
    ref: { source: 'sciverse', sourceId: DOC_ID },
    title: 'a readable paper title',
    authors: [],
  },
}))
assert.equal(resolvePaperTitle(lowerCaseMetadata, markdown, sourceIdentity!), 'A readable paper title')

const provenance = parseLiteratureProvenance(JSON.stringify({
  provider: 'sciverse',
  retrievedAt: '2026-08-10T01:02:03.000Z',
  canonicalUrl: 'https://example.test/paper',
  content: {
    path: SOURCE_PATH,
    kind: 'fulltext',
    mimeType: 'text/markdown',
    sizeBytes: 2048,
    sha256: 'f'.repeat(64),
  },
}))
assert.equal(provenance?.provider, 'sciverse')
assert.equal(provenance?.content?.sizeBytes, 2048)
assert.equal(parseLiteratureProvenance('{oops'), null)
assert.equal(parseLiteratureMetadata('[]'), null)

assert.equal(safeHttpUrl('javascript:alert(1)'), undefined)
assert.equal(safeHttpUrl('https://user:pass@example.test/private'), undefined)
assert.equal(safeHttpUrl('https://example.test/paper'), 'https://example.test/paper')

const proxied = classifyScientificImageSource('figure-1.png', 'conversation/with spaces', SOURCE_PATH)
assert.equal(proxied.kind, 'proxy')
if (proxied.kind === 'proxy') {
  assert.match(proxied.url, /^\/api\/conversations\/conversation%2Fwith%20spaces\/literature\/resource\?/)
  const query = new URLSearchParams(proxied.url.split('?')[1])
  assert.equal(query.get('source_path'), SOURCE_PATH)
  assert.equal(query.get('ref'), 'figure-1.png')
}
assert.deepEqual(
  classifyScientificImageSource('https://publisher.test/figure.png', 'conversation', SOURCE_PATH),
  { kind: 'external', url: 'https://publisher.test/figure.png' },
)
assert.deepEqual(
  classifyScientificImageSource('../secret.png', 'conversation', SOURCE_PATH),
  { kind: 'blocked' },
)
assert.deepEqual(
  classifyScientificImageSource('%252e%252e/secret.png', 'conversation', SOURCE_PATH),
  { kind: 'blocked' },
)
assert.deepEqual(
  classifyScientificImageSource('figure.png', 'conversation', 'analysis/report.md'),
  { kind: 'blocked' },
)

console.log('literature paper model verification passed')
