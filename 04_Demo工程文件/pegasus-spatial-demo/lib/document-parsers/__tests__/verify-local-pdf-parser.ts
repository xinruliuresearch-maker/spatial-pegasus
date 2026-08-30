import assert from 'node:assert/strict'
import {
  LocalPdfParser,
  PdfParserError,
  normalizePdfPageRange,
  type PdfParserBackend,
} from '..'

function pdfString(value: string): string {
  return value.replace(/([\\()])/g, '\\$1')
}

/** Build a tiny standards-compliant PDF without adding a test-only dependency. */
function fixturePdf(pageTexts: string[]): Buffer {
  const objects: string[] = []
  const add = (value: string): number => {
    objects.push(value)
    return objects.length
  }

  const catalogId = add('')
  const pagesId = add('')
  const fontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  const pageIds: number[] = []
  for (const text of pageTexts) {
    const stream = `BT\n/F1 12 Tf\n72 720 Td\n(${pdfString(text)}) Tj\nET\n`
    const contentId = add(`<< /Length ${Buffer.byteLength(stream, 'ascii')} >>\nstream\n${stream}endstream`)
    pageIds.push(add(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] `
      + `/Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`,
    ))
  }
  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`

  let body = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'
  const offsets = [0]
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, 'latin1'))
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xrefOffset = Buffer.byteLength(body, 'latin1')
  body += `xref\n0 ${objects.length + 1}\n`
  body += '0000000000 65535 f \n'
  body += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  body += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\n`
  body += `startxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(body, 'latin1')
}

async function verifyRealExtraction(): Promise<void> {
  const parser = new LocalPdfParser()
  const result = await parser.parse(fixturePdf([
    'Materials discovery alpha',
    'Independent validation beta',
  ]))

  assert.equal(result.totalPages, 2)
  assert.deepEqual(result.parsedPages, [1, 2])
  assert.match(result.pages[0].text, /Materials discovery alpha/)
  assert.match(result.pages[1].text, /Independent validation beta/)
  assert.match(result.markdown, /<!-- page: 1 -->/)
  assert.match(result.markdown, /## Page 2/)
  assert.deepEqual(result.blocks.map(block => block.page), [1, 2])
  assert.equal(result.blocks[0].blockId, 'page-1-block-1')
  assert.deepEqual(result.parser, { name: 'pdf-parse', version: '2.4.5' })
}

async function verifyRangeAndLimits(): Promise<void> {
  assert.deepEqual(normalizePdfPageRange('02-03'), { start: 2, end: 3 })
  assert.deepEqual(normalizePdfPageRange('4'), { start: 4, end: 4 })
  assert.throws(() => normalizePdfPageRange('3-1'), /ascending/)

  const parser = new LocalPdfParser()
  const selected = await parser.parse(
    fixturePdf(['page one', 'page two', 'page three']),
    { pageRange: { start: 2, end: 2 } },
  )
  assert.equal(selected.totalPages, 3)
  assert.deepEqual(selected.parsedPages, [2])
  assert.match(selected.markdown, /page two/i)
  assert.doesNotMatch(selected.markdown, /page one/i)

  const neverCalled = async (): Promise<PdfParserBackend> => {
    throw new Error('backend must not be created for rejected input')
  }
  const bounded = new LocalPdfParser({
    backendFactory: neverCalled,
    limits: { maxInputBytes: 8 },
  })
  await assert.rejects(
    bounded.parse(Buffer.from('%PDF-too-large')),
    (error: unknown) => error instanceof PdfParserError && error.code === 'INPUT_TOO_LARGE',
  )
  await assert.rejects(
    parser.parse(Buffer.from('not a pdf')),
    (error: unknown) => error instanceof PdfParserError && error.code === 'NOT_PDF',
  )
  await assert.rejects(
    parser.parse(fixturePdf(['one']), { pageRange: { start: 2, end: 2 } }),
    (error: unknown) => error instanceof PdfParserError && error.code === 'INVALID_PAGE_RANGE',
  )
}

async function verifyOutputBoundAndCleanup(): Promise<void> {
  let destroyed = false
  const backend: PdfParserBackend = {
    async getInfo() { return { total: 1 } },
    async getText() {
      return { pages: [{ num: 1, text: 'large output' }], text: 'large output', total: 1 }
    },
    async destroy() { destroyed = true },
  }
  const parser = new LocalPdfParser({
    backendFactory: async () => backend,
    limits: { maxOutputBytes: 4 },
  })
  await assert.rejects(
    parser.parse(fixturePdf(['ignored'])),
    (error: unknown) => error instanceof PdfParserError && error.code === 'OUTPUT_TOO_LARGE',
  )
  assert.equal(destroyed, true, 'backend must be destroyed after an output-limit failure')
}

async function verifyAbortAndCleanup(): Promise<void> {
  let destroyed = false
  let extractionStarted!: () => void
  const started = new Promise<void>(resolve => { extractionStarted = resolve })
  const backend: PdfParserBackend = {
    async getInfo() { return { total: 1 } },
    async getText() {
      extractionStarted()
      return new Promise(() => undefined)
    },
    async destroy() { destroyed = true },
  }
  const parser = new LocalPdfParser({ backendFactory: async () => backend })
  const controller = new AbortController()
  const pending = parser.parse(fixturePdf(['ignored']), { signal: controller.signal })
  await started
  controller.abort(new Error('test abort'))
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof PdfParserError && error.code === 'ABORTED',
  )
  assert.equal(destroyed, true, 'backend must be destroyed after abort')
}

async function main(): Promise<void> {
  await verifyRealExtraction()
  await verifyRangeAndLimits()
  await verifyOutputBoundAndCleanup()
  await verifyAbortAndCleanup()
  console.log('local PDF parser verification passed')
}

void main()
