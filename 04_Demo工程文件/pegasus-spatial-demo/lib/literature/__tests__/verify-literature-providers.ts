import assert from 'node:assert/strict'
import { ArxivLiteratureProvider, normalizeArxivId, parseArxivAtomFeed } from '../providers/arxiv'
import { SciverseLiteratureProvider } from '../providers/sciverse'

const SCIVERSE_DOC_ID = 'a'.repeat(64)

const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <opensearch:totalResults>2</opensearch:totalResults>
  <entry>
    <id>https://arxiv.org/abs/2401.01234v2</id>
    <updated>2026-01-02T03:04:05Z</updated>
    <published>2025-12-01T00:00:00Z</published>
    <title>  Layered &amp; stable material  </title>
    <summary>A measured band gap &lt; 2 eV.</summary>
    <author><name>Ada Lovelace</name></author>
    <author><name>Chien-Shiung Wu</name></author>
    <arxiv:doi>10.1000/example</arxiv:doi>
    <arxiv:license>https://creativecommons.org/licenses/by/4.0/</arxiv:license>
    <category term="cond-mat.mtrl-sci" />
    <link rel="alternate" href="https://arxiv.org/abs/2401.01234v2" />
    <link title="pdf" type="application/pdf" href="https://arxiv.org/pdf/2401.01234v2" />
  </entry>
</feed>`

async function verifyArxivPureParsing(): Promise<void> {
  assert.equal(normalizeArxivId('arXiv:2401.01234v2'), '2401.01234v2')
  assert.equal(normalizeArxivId('https://arxiv.org/pdf/math.GT/0309136.pdf'), 'math.GT/0309136')
  assert.throws(() => normalizeArxivId('https://evil.example/paper.pdf'))

  const feed = parseArxivAtomFeed(ATOM)
  assert.equal(feed.total, 2)
  assert.equal(feed.papers.length, 1)
  assert.equal(feed.papers[0].ref.sourceId, '2401.01234v2')
  assert.equal(feed.papers[0].title, 'Layered & stable material')
  assert.deepEqual(feed.papers[0].authors, ['Ada Lovelace', 'Chien-Shiung Wu'])
  assert.equal(feed.papers[0].doi, '10.1000/example')
  assert.equal(feed.papers[0].licenseUrl, 'https://creativecommons.org/licenses/by/4.0/')

  const feedWithoutTotal = parseArxivAtomFeed(
    ATOM.replace(/\s*<opensearch:totalResults>2<\/opensearch:totalResults>/, ''),
  )
  assert.equal(feedWithoutTotal.total, 1)
}

async function verifyArxivNetworkAdapter(): Promise<void> {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input)
    calls.push({ url, init })
    if (url.includes('id_list=')) {
      return new Response(ATOM, { headers: { 'Content-Type': 'application/atom+xml' } })
    }
    if (url.includes('/api/query')) {
      return new Response(ATOM, { headers: { 'Content-Type': 'application/atom+xml' } })
    }
    if (url === 'https://arxiv.org/pdf/2401.01234v2') {
      return new Response(null, {
        status: 302,
        headers: { Location: 'https://export.arxiv.org/pdf/2401.01234v2' },
      })
    }
    if (url === 'https://export.arxiv.org/pdf/2401.01234v2') {
      return new Response(new Uint8Array(Buffer.from('%PDF-1.7\nfixture')), {
        headers: { 'Content-Type': 'application/pdf' },
      })
    }
    throw new Error(`Unexpected URL: ${url}`)
  }
  const provider = new ArxivLiteratureProvider({
    fetchImpl: fakeFetch,
    requestIntervalMs: 0,
    now: () => new Date('2026-08-07T00:00:00.000Z'),
  })
  const page = await provider.searchPapers({
    source: 'arxiv',
    query: 'solid electrolyte',
    limit: 5,
    sort: 'newest',
    filters: {
      authors: ['Ada Lovelace', 'Chien-Shiung Wu'],
      categories: ['cond-mat.mtrl-sci', 'physics.chem-ph'],
    },
  })
  assert.equal(page.source, 'arxiv')
  assert.equal(page.nextCursor, '1')
  const searchUrl = new URL(calls[0].url)
  assert.equal(
    searchUrl.searchParams.get('search_query'),
    'all:"solid electrolyte" AND (au:"Ada Lovelace" OR au:"Chien-Shiung Wu") AND (cat:cond-mat.mtrl-sci OR cat:physics.chem-ph)',
  )
  assert.equal(searchUrl.searchParams.get('sortBy'), 'submittedDate')
  await assert.rejects(
    provider.searchPapers({
      source: 'sciverse',
      query: 'wrong provider',
      page: 1,
      pageSize: 1,
    }),
    /cannot search source: sciverse/,
  )

  const fetched = await provider.fetchPaper({ sourceId: '2401.01234v2' })
  assert.equal(fetched.content.kind, 'pdf')
  assert.equal(fetched.retrievedAt, '2026-08-07T00:00:00.000Z')
  if (fetched.content.kind === 'pdf') assert.match(fetched.content.buffer.toString('ascii'), /^%PDF-/)
  assert.ok(calls.some(call => call.init?.redirect === 'manual'))
}

async function verifyArxivRejectsUntrustedRedirect(): Promise<void> {
  const fakeFetch: typeof fetch = async input => {
    const url = String(input)
    if (url.includes('id_list=')) return new Response(ATOM)
    return new Response(null, { status: 302, headers: { Location: 'https://evil.example/file.pdf' } })
  }
  const provider = new ArxivLiteratureProvider({ fetchImpl: fakeFetch, requestIntervalMs: 0 })
  await assert.rejects(
    provider.fetchPaper({ sourceId: '2401.01234v2' }),
    /untrusted origin/,
  )
}

async function verifyArxivRejectsMismatchedMetadata(): Promise<void> {
  let pdfRequested = false
  const mismatchedAtom = ATOM.replaceAll('2401.01234v2', '2401.01234v3')
  const fakeFetch: typeof fetch = async input => {
    const url = String(input)
    if (url.includes('id_list=')) return new Response(mismatchedAtom)
    pdfRequested = true
    return new Response(new Uint8Array(Buffer.from('%PDF-1.7\nfixture')))
  }
  const provider = new ArxivLiteratureProvider({ fetchImpl: fakeFetch, requestIntervalMs: 0 })
  await assert.rejects(
    provider.fetchPaper({ sourceId: '2401.01234v2' }),
    /metadata identifier mismatch/,
  )
  assert.equal(pdfRequested, false)
}

async function verifySciverseAdapter(): Promise<void> {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input)
    calls.push({ url, init })
    if (url.endsWith('/meta-search')) {
      return Response.json({
        results: [{
          unique_id: 'uid:paper-1',
          doc_id: SCIVERSE_DOC_ID,
          title: 'Ceramic electrolyte',
          author: [{ name: 'Author A' }],
          abstract: 'A metadata abstract.',
          publication_published_year: 2025,
          publication_venue_name_unified: 'Materials Letters',
          citation_count: 12,
          access_license: 'CC-BY-4.0',
          is_content_accessible: true,
        }],
        total_count: 8,
        next_cursor: 'cursor-2',
      }, { headers: { 'x-request-id': 'req-meta' } })
    }
    if (url.endsWith('/agentic-search')) {
      return Response.json({
        hits: [{
          doc_id: SCIVERSE_DOC_ID,
          unique_id: 'uid:paper-1',
          chunk_id: 'chunk-9',
          title: 'Ceramic electrolyte',
          author: ['Author A'],
          abstract: 'A metadata abstract.',
          chunk: 'ionic conductivity evidence',
          offset: 128,
          page_no: 7,
          score: 0.91,
          source_type: 'pdf',
          publication_published_year: 2025,
        }],
      }, { headers: { 'x-request-id': 'req-evidence' } })
    }
    if (url.endsWith('/meta-paper-relations')) {
      return Response.json({
        items: [{ id: 'uid:cited-1', id_type: 'unique_id', title: 'Prior electrolyte study' }],
        total_count: 1,
        page: 1,
        page_size: 25,
        total_pages: 1,
      }, { headers: { 'x-request-id': 'req-relations' } })
    }
    const parsed = new URL(url)
    assert.equal(parsed.pathname, '/content')
    assert.equal(parsed.searchParams.get('limit'), '8192')
    const offset = Number(parsed.searchParams.get('offset'))
    if (offset === 0) {
      return Response.json({
        text: '# Part 1\nα',
        bytes_returned: 999,
        next_offset: 17,
        more: true,
        metadata: {
          unique_id: 'uid:paper-1',
          title: 'Ceramic electrolyte',
          author: ['Author A'],
          access_license: 'CC-BY-4.0',
        },
      })
    }
    assert.equal(offset, 17)
    return Response.json({
      text: '# Part 2\nβ',
      chars_returned: 3,
      next_offset: 999,
      more: false,
    })
  }
  const provider = new SciverseLiteratureProvider({
    token: 'test-token',
    fetchImpl: fakeFetch,
    maxContentPages: 2,
    now: () => new Date('2026-08-07T00:00:00.000Z'),
  })

  const papers = await provider.searchPapers({
    source: 'sciverse',
    query: 'electrolyte',
    authors: ['Author A'],
    yearFrom: 2020,
    sortByYear: 'desc',
    freshnessBoost: 'MILD',
    impactBoost: 'STRONG',
    languageAffinity: 'NONE',
    page: 1,
    pageSize: 3,
  })
  assert.equal(papers.total, 8)
  assert.equal(papers.nextCursor, 'cursor-2')
  assert.equal(papers.papers[0].ref.uniqueId, 'uid:paper-1')
  assert.equal(papers.papers[0].ref.documentId, SCIVERSE_DOC_ID)
  assert.deepEqual(papers.papers[0].authors, ['Author A'])
  assert.equal(papers.papers[0].license, 'CC-BY-4.0')
  const paperSearchBody = JSON.parse(String(calls[0].init?.body))
  assert.equal(paperSearchBody.query, 'electrolyte')
  assert.equal(paperSearchBody.page_size, 3)
  assert.deepEqual(paperSearchBody.filters, [
    { field: 'author', operator: 'FILTER_OP_IN', value: ['Author A'] },
    { field: 'publication_published_year', operator: 'FILTER_OP_GTE', value: 2020 },
  ])
  assert.deepEqual(paperSearchBody.sort, [
    { field: 'publication_published_year', order: 'SORT_ORDER_DESC' },
  ])

  const evidence = await provider.searchEvidence({
    source: 'sciverse',
    query: 'measured ionic conductivity',
    topK: 4,
    mode: 'quality',
    sourceTypes: ['pdf'],
    filters: { doc_id: [SCIVERSE_DOC_ID] },
  })
  assert.equal(evidence.hits.length, 1)
  assert.deepEqual(evidence.hits[0], {
    source: 'sciverse',
    documentId: SCIVERSE_DOC_ID,
    chunkId: 'chunk-9',
    uniqueId: 'uid:paper-1',
    title: 'Ceramic electrolyte',
    authors: ['Author A'],
    abstract: 'A metadata abstract.',
    chunk: 'ionic conductivity evidence',
    score: 0.91,
    offset: 128,
    offsetUnit: 'utf8_byte',
    page: 7,
    sourceType: 'pdf',
    venue: undefined,
    publishedYear: 2025,
  })
  assert.deepEqual(JSON.parse(String(calls[1].init?.body)), {
    retrieval: 'hybrid',
    sub_queries: 3,
    query: 'measured ionic conductivity',
    top_k: 4,
    source_types: ['pdf'],
    filters: { doc_id: [SCIVERSE_DOC_ID] },
  })

  const relations = await provider.listPaperRelations({
    source: 'sciverse',
    uniqueId: 'uid:paper-1',
    relation: 'REFERENCES',
    page: 1,
    pageSize: 25,
  })
  assert.equal(relations.totalCount, 1)
  assert.equal(relations.items[0].id, 'uid:cited-1')
  assert.deepEqual(JSON.parse(String(calls[2].init?.body)), {
    unique_id: 'uid:paper-1',
    relation: 'REFERENCES',
    page: 1,
    page_size: 25,
  })

  const fetched = await provider.fetchPaper({ sourceId: SCIVERSE_DOC_ID })
  assert.equal(fetched.content.kind, 'fulltext')
  if (fetched.content.kind === 'fulltext') {
    assert.equal(fetched.content.text, '# Part 1\nα# Part 2\nβ')
  }
  assert.equal(fetched.paper.title, 'Ceramic electrolyte')
  assert.deepEqual(
    calls.filter(call => call.url.includes('/content')).map(call => new URL(call.url).searchParams.get('offset')),
    ['0', '17'],
  )
  for (const call of calls) {
    assert.equal((call.init?.headers as Record<string, string>).Authorization, 'Bearer test-token')
  }

  await assert.rejects(
    provider.searchPapers({ source: 'arxiv', query: 'wrong provider', limit: 1 }),
    /cannot search source: arxiv/,
  )

  let invoked = false
  const unavailable = new SciverseLiteratureProvider({
    token: '',
    fetchImpl: async () => { invoked = true; return Response.json({}) },
  })
  await assert.rejects(
    unavailable.searchPapers({
      source: 'sciverse',
      query: 'x',
      page: 1,
      pageSize: 1,
    }),
    /SCIVERSE_API_TOKEN/,
  )
  assert.equal(invoked, false)
}

async function verifyEnvironmentBaseUrls(): Promise<void> {
  const previousArxiv = process.env.ARXIV_API_BASE_URL
  const previousSciverse = process.env.SCIVERSE_API_BASE_URL
  const previousToken = process.env.SCIVERSE_API_TOKEN
  try {
    process.env.ARXIV_API_BASE_URL = 'https://arxiv-proxy.example/api/query'
    process.env.SCIVERSE_API_BASE_URL = 'https://sciverse-proxy.example/'
    process.env.SCIVERSE_API_TOKEN = 'environment-token'

    let arxivUrl = ''
    const arxiv = new ArxivLiteratureProvider({
      fetchImpl: async input => {
        arxivUrl = String(input)
        return new Response(ATOM)
      },
      requestIntervalMs: 0,
    })
    await arxiv.searchPapers({ source: 'arxiv', query: 'material', limit: 1 })
    assert.equal(new URL(arxivUrl).origin, 'https://arxiv-proxy.example')

    let sciverseCall: { url?: string; authorization?: string } = {}
    const sciverse = new SciverseLiteratureProvider({
      fetchImpl: async (input, init) => {
        sciverseCall = {
          url: String(input),
          authorization: (init?.headers as Record<string, string>).Authorization,
        }
        return Response.json({ results: [], total_count: 0 })
      },
    })
    await sciverse.searchPapers({
      source: 'sciverse',
      query: 'material',
      page: 1,
      pageSize: 1,
    })
    assert.equal(sciverseCall.url, 'https://sciverse-proxy.example/meta-search')
    assert.equal(sciverseCall.authorization, 'Bearer environment-token')
  } finally {
    restoreEnvironment('ARXIV_API_BASE_URL', previousArxiv)
    restoreEnvironment('SCIVERSE_API_BASE_URL', previousSciverse)
    restoreEnvironment('SCIVERSE_API_TOKEN', previousToken)
  }
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

async function main(): Promise<void> {
  await verifyArxivPureParsing()
  await verifyArxivNetworkAdapter()
  await verifyArxivRejectsUntrustedRedirect()
  await verifyArxivRejectsMismatchedMetadata()
  await verifySciverseAdapter()
  await verifyEnvironmentBaseUrls()
  console.log('literature-providers:verify passed')
}

void main()
