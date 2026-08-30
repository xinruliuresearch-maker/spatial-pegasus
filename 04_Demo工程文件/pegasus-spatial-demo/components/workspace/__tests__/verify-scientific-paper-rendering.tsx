import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ScientificMarkdown } from '../ScientificMarkdown'
import { classifyScientificFigureShape } from '../ScientificFigure'
import { isExactMalformedScientificImagePlaceholder } from '../rehype-scientific-figures'

const documentId = 'a'.repeat(64)
const directory = `references/papers/sciverse-${documentId}-0123456789`
const sourcePath = `${directory}/source-fulltext.md`
const markdown = [
  'Review',
  '',
  '# A rendered scientific paper',
  '',
  'Inline formula $E = mc^2$.',
  '',
  '<table><tr><th>Condition</th><th>Value</th></tr><tr><td rowspan="2">A</td><td>42</td></tr></table>',
  '',
  '![Figure 1](dt=2026-03-27/figure-1.jpg)',
  '',
  '<script>globalThis.__unsafe = true</script>',
].join('\n')

const scientificHtml = renderToStaticMarkup(
  createElement(ScientificMarkdown, {
    content: markdown,
    conversationId: 'conversation-id',
    sourcePath,
  }),
)
assert.match(scientificHtml, /class="katex"/, 'inline LaTeX is rendered through KaTeX')
assert.match(scientificHtml, /max-w-\[72ch\]/, 'paper text uses a restrained academic reading measure')
assert.match(scientificHtml, /Iowan Old Style/, 'paper body uses the local academic serif stack')
assert.match(scientificHtml, /text-\[13\.5px\]/, 'paper body typography stays compact')
assert.doesNotMatch(scientificHtml, /<h1/, 'the reader header remains the only document H1')
assert.match(scientificHtml, /<h2[^>]*>A rendered scientific paper<\/h2>/, 'provider H1 is demoted to an article section')
assert.match(scientificHtml, /<table/, 'publisher HTML tables remain readable')
assert.match(scientificHtml, /aria-label="论文表格，可横向滚动"[^>]*tabindex="0"/, 'wide tables expose keyboard scrolling')
assert.match(scientificHtml, /row[Ss]pan="2"/, 'safe table spans are preserved')
assert.doesNotMatch(scientificHtml, /<script|__unsafe/, 'untrusted raw HTML is removed')
assert.match(scientificHtml, /\/api\/conversations\/conversation-id\/literature\/resource\?/, 'relative figures use the authenticated proxy')

const compactFrontMatterHtml = renderToStaticMarkup(
  createElement(ScientificMarkdown, {
    content: 'A. Author, B. Author\n\nDepartment of Materials Science',
    conversationId: 'conversation-id',
    sourcePath,
    variant: 'front-matter',
  }),
)
assert.match(compactFrontMatterHtml, /data-variant="front-matter"/, 'publisher masthead uses the compact renderer')
assert.match(compactFrontMatterHtml, /text-\[11\.5px\]/, 'publisher masthead stays visually subordinate')

const placeholderHash = '9'.repeat(64)
const figureClusterMarkdown = [
  `![](image)ge/dt=2026-03-19/ht=13//${placeholderHash}.jpg)`,
  '',
  ...Array.from({ length: 7 }, (_, index) => `![Panel ${index + 1}](figures/panel-${index + 1}.jpg)\n`),
].join('\n')
const figureClusterHtml = renderToStaticMarkup(
  createElement(ScientificMarkdown, {
    content: figureClusterMarkdown,
    conversationId: 'conversation-id',
    sourcePath,
  }),
)
assert.match(figureClusterHtml, /data-scientific-figure-cluster=""/, 'consecutive image paragraphs become one figure plate')
assert.match(figureClusterHtml, /data-scientific-figure-count="7"/, 'a seven-panel scientific plate remains a single cluster')
assert.equal((figureClusterHtml.match(/data-scientific-image=""/g) ?? []).length, 7, 'the cluster retains every valid panel')
assert.match(figureClusterHtml, /aria-label="论文组合图，共 7 个图版"/, 'multi-panel plates expose an accessible group label')
assert.match(figureClusterHtml, /h-auto w-auto max-w-full/, 'figures preserve their intrinsic aspect ratio')
assert.match(figureClusterHtml, /max-h-\[min\(58svh,28rem\)\]/, 'cluster panels have a restrained viewport and absolute height cap')
assert.doesNotMatch(figureClusterHtml, new RegExp(placeholderHash), 'the exact unrecoverable provider placeholder is presentation-hidden')

const exactPlaceholderNode = {
  type: 'element',
  tagName: 'p',
  properties: {},
  children: [
    { type: 'element', tagName: 'img', properties: { src: 'image', alt: '' }, children: [] },
    { type: 'text', value: `ge/dt=2026-03-19/ht=13//${placeholderHash}.jpg)` },
  ],
}
assert.equal(isExactMalformedScientificImagePlaceholder(exactPlaceholderNode), true)
assert.equal(isExactMalformedScientificImagePlaceholder({
  ...exactPlaceholderNode,
  children: [
    { type: 'element', tagName: 'img', properties: { src: 'image', alt: 'Figure' }, children: [] },
    { type: 'text', value: `ge/dt=2026-03-19/ht=13//${placeholderHash}.jpg)` },
  ],
}), false, 'a meaningful alt makes the near-match visible')
assert.equal(isExactMalformedScientificImagePlaceholder({
  ...exactPlaceholderNode,
  children: [
    { type: 'element', tagName: 'img', properties: { src: 'image', alt: '' }, children: [] },
    { type: 'text', value: `ge/dt=2026-03-19/ht=13//${placeholderHash}.tif)` },
  ],
}), false, 'an unsupported tail is not broadly hidden')

const renderedNearMiss = renderToStaticMarkup(
  createElement(ScientificMarkdown, {
    content: `![Figure](image)ge/dt=2026-03-19/ht=13//${placeholderHash}.jpg)`,
    conversationId: 'conversation-id',
    sourcePath,
  }),
)
assert.match(renderedNearMiss, new RegExp(placeholderHash), 'a near-match remains visible in the rendered paper')

const eightPanelHtml = renderToStaticMarkup(
  createElement(ScientificMarkdown, {
    content: Array.from({ length: 8 }, (_, index) => `![Panel ${index + 1}](figures/eight-${index + 1}.jpg)`).join('\n\n'),
    conversationId: 'conversation-id',
    sourcePath,
  }),
)
assert.equal((eightPanelHtml.match(/data-scientific-figure-cluster=""/g) ?? []).length, 2, 'oversized runs split into bounded figure plates')
assert.match(eightPanelHtml, /data-scientific-figure-count="7"/)
assert.match(eightPanelHtml, /data-scientific-figure-count="1"/)

const nestedImagesHtml = renderToStaticMarkup(
  createElement(ScientificMarkdown, {
    content: '> ![Quoted panel 1](figures/quoted-1.jpg)\n>\n> ![Quoted panel 2](figures/quoted-2.jpg)',
    conversationId: 'conversation-id',
    sourcePath,
  }),
)
assert.doesNotMatch(nestedImagesHtml, /data-scientific-figure-cluster=""/, 'images inside a quotation are never regrouped across its semantic boundary')

assert.equal(classifyScientificFigureShape(90, 900), 'narrow', 'a colorbar is detected from its intrinsic ratio')
assert.equal(classifyScientificFigureShape(1600, 300), 'wide', 'a wide strip is detected from its intrinsic ratio')
assert.equal(classifyScientificFigureShape(800, 800), 'balanced')

console.log('scientific paper rendering verification passed')
