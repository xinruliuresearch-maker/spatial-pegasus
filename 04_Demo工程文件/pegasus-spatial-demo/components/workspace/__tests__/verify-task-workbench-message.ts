import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(
  join(process.cwd(), 'components', 'workspace', 'TaskWorkbench.tsx'),
  'utf8',
)
const builder = source.match(
  /export function buildResearchProjectMessage[\s\S]+?\n}\n\nexport function TaskWorkbench/,
)?.[0]

assert.ok(builder, 'missing project message builder')
assert.match(builder, /`空间创作目标：\$\{question\.trim\(\)}`/)
assert.doesNotMatch(builder, /创作语境|domain/)
assert.match(builder, /`已有素材与约束：\\n\$\{context\.trim\(\)}`/)
assert.doesNotMatch(builder, /请先|固定流程|物体模式|世界模式/)
assert.match(source, /buildResearchProjectMessage\(question, context\)/)
assert.doesNotMatch(source, /DEFAULT_CREATION_CONTEXT|开放空间创作/)
assert.match(source, /Agent 会自己选择图像、Lux 造物、World 与场景编辑工具/)
assert.match(source, /ModelPickerModal/)
assert.match(source, /上传参考图片/)
assert.match(source, /pendingImages/)
assert.doesNotMatch(source, /CREATION_CONTEXTS|pmo-spatial-context-switcher/)

console.log('task-workbench-message:verify passed')
