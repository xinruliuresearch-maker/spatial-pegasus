import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const viewerEntry = resolve('node_modules/@manycore/aholo-viewer/dist/index.js')
const EXPECTED_DIRECT_WORKER_COUNT = 3
const source = await readFile(viewerEntry, 'utf8')

let patched = source
for (const blobVariable of ['TranscoderWorkerBlobUrl', 'SplatWorkerBlobUrl', 'SplatSortWorkerBlobUrl']) {
  patched = patched.replace(
    `return new Worker(${blobVariable}, { type: "module" });`,
    'return new Worker(workerUrl, { type: "module" });',
  )
}
patched = patched.replace(
  'new FactoryWorkerPool("splat", WorkerFactor2, Math.max(0, navigator.hardwareConcurrency - 1), 1)',
  'new FactoryWorkerPool("splat", WorkerFactor2, Math.max(1, (navigator.hardwareConcurrency || 2) - 1), 1)',
)

const directWorkerCount = patched.match(/return new Worker\(workerUrl, \{ type: "module" \}\);/g)?.length ?? 0
const hasSafePoolFloor = patched.includes(
  'new FactoryWorkerPool("splat", WorkerFactor2, Math.max(1, (navigator.hardwareConcurrency || 2) - 1), 1)',
)
if (directWorkerCount !== EXPECTED_DIRECT_WORKER_COUNT || !hasSafePoolFloor) {
  throw new Error('Unsupported @manycore/aholo-viewer build: Worker bootstrap signature changed.')
}

if (patched !== source) {
  await writeFile(viewerEntry, patched)
  console.log('[postinstall] Patched Aholo Viewer workers for same-origin Next.js loading.')
}
