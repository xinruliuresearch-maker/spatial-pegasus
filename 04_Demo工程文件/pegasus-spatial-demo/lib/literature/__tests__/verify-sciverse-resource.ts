import assert from 'node:assert/strict'
import {
  assertSciverseProviderResourceRef,
  assertSciverseSourceFulltextPath,
  buildSciverseResourceUrl,
  extractMarkdownImageReferences,
  fetchSciverseImageResource,
  markdownHasExactImageReference,
  SciverseResourceError,
} from '../sciverse-resource'

const DOC_ID = 'a'.repeat(64)
const SOURCE_PATH = `references/papers/sciverse-${DOC_ID}-0123456789/source-fulltext.md`
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

function assertResourceError(action: () => unknown, code: string): void {
  assert.throws(action, error => (
    error instanceof SciverseResourceError && error.code === code
  ))
}

assert.equal(assertSciverseSourceFulltextPath(SOURCE_PATH), SOURCE_PATH)
for (const invalid of [
  'references/papers/arxiv-2608.00001/source-fulltext.md',
  `references/papers/sciverse-${DOC_ID}-0123456789/metadata.json`,
  `analysis/sciverse-${DOC_ID}-0123456789/source-fulltext.md`,
]) {
  assertResourceError(() => assertSciverseSourceFulltextPath(invalid), 'invalid_source_path')
}

for (const ref of ['dt=10.1000.figure-1.jpg', 'figures/panel-a.png', 'media/image%20one.webp']) {
  assert.equal(assertSciverseProviderResourceRef(ref), ref)
}
for (const invalid of [
  '',
  '/figure.png',
  '//evil.example/figure.png',
  'https://evil.example/figure.png',
  'data:image/png;base64,AAAA',
  'figures\\image.png',
  'figures/../image.png',
  'figures/%2e%2e/image.png',
  '%2f%2fevil.example/image.png',
  'figure%5cimage.png',
  'figure\u0000.png',
  'x'.repeat(1_025),
  'bad%escape.png',
]) {
  assertResourceError(() => assertSciverseProviderResourceRef(invalid), 'invalid_ref')
}

const markdown = [
  '# Paper',
  '![Panel A](dt=10.1000.figure-1.jpg)',
  '![Panel B](<figures/panel-b.png> "caption")',
  '![Escaped](figures/panel\\(c\\).png)',
  '\\![Not an image](hidden.png)',
].join('\n')
assert.equal(markdownHasExactImageReference(markdown, 'dt=10.1000.figure-1.jpg'), true)
assert.equal(markdownHasExactImageReference(markdown, 'figures/panel-b.png'), true)
assert.equal(markdownHasExactImageReference(markdown, 'figures/panel(c).png'), true)
assert.equal(markdownHasExactImageReference(markdown, 'figure-1.jpg'), false)
assert.equal(markdownHasExactImageReference(markdown, 'hidden.png'), false)
assert.equal(markdownHasExactImageReference('![Broken](figure.png not-a-title', 'figure.png'), false)
assert.deepEqual(
  [...extractMarkdownImageReferences(markdown)],
  ['dt=10.1000.figure-1.jpg', 'figures/panel-b.png', 'figures/panel(c).png'],
)

const built = buildSciverseResourceUrl(
  'figures/panel a.png',
  'https://sciverse-proxy.example/api/',
)
assert.equal(
  built.toString(),
  'https://sciverse-proxy.example/api/resource?file_name=figures%2Fpanel+a.png',
)

let fetchCall: { url?: string; authorization?: string | null; redirect?: RequestRedirect } = {}
const valid = await fetchSciverseImageResource('figures/panel-a.png', {
  token: 'test-token',
  baseUrl: 'https://sciverse-proxy.example',
  fetchImpl: (async (input, init) => {
    const headers = new Headers(init?.headers)
    fetchCall = {
      url: String(input),
      authorization: headers.get('authorization'),
      redirect: init?.redirect,
    }
    return new Response(ONE_PIXEL_PNG, {
      status: 200,
      headers: { 'content-type': 'image/png', 'content-length': String(ONE_PIXEL_PNG.length) },
    })
  }) as typeof fetch,
})
assert.equal(fetchCall.url, 'https://sciverse-proxy.example/resource?file_name=figures%2Fpanel-a.png')
assert.equal(fetchCall.authorization, 'Bearer test-token')
assert.equal(fetchCall.redirect, 'manual')
assert.equal(valid.contentType, 'image/png')
assert.equal(valid.format, 'png')
assert.equal(valid.width, 1)
assert.equal(valid.height, 1)
assert.deepEqual(valid.bytes, ONE_PIXEL_PNG)

async function assertFetchError(response: Response, code: string): Promise<void> {
  await assert.rejects(
    fetchSciverseImageResource('figure.png', {
      token: 'test-token',
      baseUrl: 'https://sciverse-proxy.example',
      fetchImpl: (async () => response) as typeof fetch,
    }),
    error => error instanceof SciverseResourceError && error.code === code,
  )
}

await assertFetchError(
  new Response(null, { status: 302, headers: { location: 'https://evil.example/image.png' } }),
  'upstream_failure',
)
await assertFetchError(
  new Response('not an image', { status: 200, headers: { 'content-type': 'text/plain' } }),
  'invalid_image',
)
await assertFetchError(
  new Response('not really a png', { status: 200, headers: { 'content-type': 'image/png' } }),
  'invalid_image',
)
await assertFetchError(
  new Response('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>', {
    status: 200,
    headers: { 'content-type': 'image/svg+xml' },
  }),
  'invalid_image',
)
await assertFetchError(
  new Response(ONE_PIXEL_PNG, {
    status: 200,
    headers: { 'content-type': 'image/png', 'content-length': String(13 * 1024 * 1024) },
  }),
  'invalid_image',
)

console.log('Sciverse resource proxy helper verification passed')
