import assert from 'node:assert/strict'
import { buildBehaviorBlock } from '../../agent/system-prompt'
import { executeEdit } from '../edit'
import { executeGlob } from '../glob'
import { executeGrep } from '../grep'
import { executRead } from '../read'
import { executeRecallHistory } from '../recall-history'
import { getToolSchemasForCapabilities } from '../schemas'
import { executeSkill } from '../skill'
import { executeWebSearch } from '../web-search'
import { executeWrite } from '../write'
import { executeArxivFetchPaper } from '../arxiv-fetch-paper'
import { executeArxivSearchPapers } from '../arxiv-search-papers'
import { executeSciverseFetchPaper } from '../sciverse-fetch-paper'
import { executeSciverseListRelations } from '../sciverse-list-relations'
import { executeSciverseSearchEvidence } from '../sciverse-search-evidence'
import { executeSciverseSearchPapers } from '../sciverse-search-papers'
import { executeSearchDocument } from '../search-document'
import { createInMemoryWorkspace } from '../__test-utils__/in-memory-workspace'

const CORE_TOOLS = [
  'Read',
  'Write',
  'Edit',
  'GenerateImage',
  'CreateObject3D',
  'CreateWorld3D',
  'CreateSpatialScene',
  'SetSceneEnvironment',
  'SetSceneWorld',
  'AddSceneObject',
  'AddSceneTerrain',
  'TransformSceneObject',
  'RemoveSceneObject',
  'ApplySceneSpec',
  'InspectSpatialScene',
  'RestoreSpatialScene',
  'SetSceneViewpoint',
  'FocusSceneObject',
  'CaptureSceneView',
  'QuerySceneSurface',
  'GetSpatialJob',
  'WaitSpatialJob',
  'InspectSpatialArtifact',
  'Glob',
  'Grep',
  'Skill',
  'WebSearch',
  'ArxivSearchPapers',
  'ArxivFetchPaper',
  'SciverseSearchPapers',
  'SciverseSearchEvidence',
  'SciverseFetchPaper',
  'SciverseListRelations',
  'SearchDocument',
  'Agent',
  'SendMessage',
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
  'ReviewWorkspaceChanges',
  'ManageAgent',
  'AskUserQuestion',
]

function schema(name: string) {
  const item = getToolSchemasForCapabilities({
    supportsVision: true,
    includeRecallHistory: true,
  }).find(candidate => candidate.name === name)
  assert.ok(item, `missing schema: ${name}`)
  return item.input_schema as {
    properties?: Record<string, Record<string, unknown>>
    required?: string[]
    anyOf?: unknown
  }
}

function assertSourceBoundSchema(name: string): void {
  assert.equal(schema(name).properties?.source, undefined, `${name} must not expose source`)
}

function verifySchemas(): void {
  const visionNames = getToolSchemasForCapabilities({ supportsVision: true }).map(item => item.name)
  const textNames = getToolSchemasForCapabilities({ supportsVision: false }).map(item => item.name)
  assert.deepEqual(visionNames, CORE_TOOLS)
  assert.deepEqual(textNames, CORE_TOOLS)
  assert.deepEqual(
    getToolSchemasForCapabilities({ supportsVision: true, includeRecallHistory: true })
      .map(item => item.name),
    [...CORE_TOOLS, 'RecallHistory'],
  )

  const retired = [
    'ImageProcessor',
    'ImageToFigure',
    'InspectCanvas',
    'CanvasCode',
    'AssembleXML',
    'ParseDocument',
    'CheckParseJob',
    'SearchLiterature',
    'FetchPaper',
    'CreateAgent',
    'AssignAgentTask',
    'SendAgentMessage',
    'InspectAgentTeam',
    'WaitForAgents',
    'SubmitAgentResult',
    'ReviewAgentResult',
  ]
  for (const name of retired) assert.ok(!visionNames.includes(name), `${name} must remain retired`)

  const memberNames = getToolSchemasForCapabilities({
    supportsVision: true,
    isRoot: false,
  }).map(item => item.name)
  for (const expensive of [
    'GenerateImage', 'CreateObject3D', 'CreateWorld3D', 'CreateSpatialScene', 'SetSceneEnvironment', 'SetSceneWorld',
    'AddSceneObject', 'AddSceneTerrain', 'TransformSceneObject', 'RemoveSceneObject', 'ApplySceneSpec', 'RestoreSpatialScene',
    'SetSceneViewpoint', 'FocusSceneObject', 'CaptureSceneView', 'QuerySceneSurface',
  ]) {
    assert.ok(!memberNames.includes(expensive), `Member wildcard surface must exclude ${expensive}`)
  }
  assert.ok(memberNames.includes('GetSpatialJob'))
  assert.ok(memberNames.includes('InspectSpatialArtifact'))
  assert.ok(memberNames.includes('InspectSpatialScene'))
  const explicitlyDelegated = getToolSchemasForCapabilities({
    supportsVision: true,
    isRoot: false,
    allowedTools: ['GenerateImage', 'AddSceneObject'],
  }).map(item => item.name)
  assert.deepEqual(explicitlyDelegated, ['GenerateImage', 'AddSceneObject'])

  const spatialNames = getToolSchemasForCapabilities({
    supportsVision: true,
    isRoot: true,
    projectTemplateId: 'spatial-creation',
  }).map(item => item.name)
  assert.ok(spatialNames.includes('CreateWorld3D'))
  for (const researchTool of [
    'ArxivSearchPapers',
    'ArxivFetchPaper',
    'SciverseSearchPapers',
    'SciverseSearchEvidence',
    'SciverseFetchPaper',
    'SciverseListRelations',
    'SearchDocument',
  ]) {
    assert.ok(!spatialNames.includes(researchTool), `${researchTool} must not enter the spatial default surface`)
  }

  assert.deepEqual(schema('Read').required, ['file_path'])
  assert.deepEqual(schema('GenerateImage').required, ['prompt', 'output_path'])
  assert.match(String(schema('GenerateImage').properties?.output_path.pattern), /^\^output\/spatial\/images/)
  assert.equal(schema('GenerateImage').properties?.aspect_ratio.enum, undefined)
  const aspectRatioPattern = new RegExp(String(schema('GenerateImage').properties?.aspect_ratio.pattern))
  assert.match('2:1', aspectRatioPattern)
  assert.match('2.39:1', aspectRatioPattern)
  assert.deepEqual(schema('CreateObject3D').required, ['output_path_prefix'])
  assert.equal(schema('CreateObject3D').properties?.reference_image_paths.maxItems, 4)
  assert.deepEqual(schema('CreateWorld3D').required, ['output_path_prefix'])
  // Runtime validation enforces these cross-field requirements. Keeping
  // top-level combinators out of the public schema preserves relay support.
  assert.equal(schema('CreateObject3D').anyOf, undefined)
  assert.equal(schema('CreateWorld3D').anyOf, undefined)
  assert.equal(schema('TransformSceneObject').anyOf, undefined)
  assert.deepEqual(schema('SetSceneEnvironment').required, ['scene_id', 'image_path'])
  assert.deepEqual(schema('ApplySceneSpec').required, ['scene_id', 'spec_path'])
  assert.match(String(schema('ApplySceneSpec').properties?.spec_path.pattern), /^\^output\/spatial\/scenes/)
  assert.deepEqual(schema('AddSceneTerrain').required, ['scene_id', 'object_job_id'])
  assert.deepEqual(schema('QuerySceneSurface').required, ['scene_id', 'terrain_instance_id', 'horizontal'])
  assert.deepEqual(schema('GetSpatialJob').required, ['job_id'])
  assert.equal(schema('WaitSpatialJob').properties?.timeout_ms.maximum, 120000)
  assert.deepEqual(schema('InspectSpatialArtifact').required, ['artifact_id'])
  assert.equal(schema('Glob').properties?.max_results.maximum, 500)
  assert.equal(schema('Grep').properties?.context_lines.maximum, 3)
  assert.deepEqual(schema('Glob').properties?.kind.enum, ['text', 'raster', 'document', 'all'])

  for (const name of [
    'ArxivSearchPapers',
    'ArxivFetchPaper',
    'SciverseSearchPapers',
    'SciverseSearchEvidence',
    'SciverseFetchPaper',
    'SciverseListRelations',
  ]) {
    assertSourceBoundSchema(name)
  }
  assert.deepEqual(schema('ArxivSearchPapers').required, ['query'])
  assert.equal(schema('ArxivSearchPapers').properties?.limit.maximum, 50)
  assert.deepEqual(schema('ArxivFetchPaper').required, ['arxiv_id'])
  assert.equal(schema('ArxivFetchPaper').properties?.source_id, undefined)
  assert.equal(schema('SciverseSearchPapers').required, undefined)
  assert.equal(schema('SciverseSearchPapers').properties?.page_size.maximum, 50)
  assert.deepEqual(schema('SciverseSearchEvidence').required, ['query'])
  assert.equal(schema('SciverseSearchEvidence').properties?.top_k.maximum, 100)
  assert.deepEqual(schema('SciverseFetchPaper').required, ['doc_id'])
  assert.equal(schema('SciverseFetchPaper').properties?.source_id, undefined)
  assert.deepEqual(schema('SciverseListRelations').required, ['unique_id', 'relation'])
  assert.equal(schema('SciverseListRelations').properties?.page_size.maximum, 200)

  const arxivFetch = getToolSchemasForCapabilities({ supportsVision: true })
    .find(candidate => candidate.name === 'ArxivFetchPaper')
  assert.match(arxivFetch?.description ?? '', /PDF/i)
  assert.match(arxivFetch?.description ?? '', /same call/i)
  const sciverseFetch = getToolSchemasForCapabilities({ supportsVision: true })
    .find(candidate => candidate.name === 'SciverseFetchPaper')
  assert.match(sciverseFetch?.description ?? '', /full text/i)
  assert.match(sciverseFetch?.description ?? '', /same call/i)

  assert.equal(schema('SearchDocument').properties?.max_results.maximum, 50)
  for (const name of ['Agent', 'TaskCreate']) {
    const budgetSchema = schema(name).properties?.budget as {
      additionalProperties?: boolean
      properties?: Record<string, Record<string, unknown>>
    }
    assert.equal(budgetSchema.additionalProperties, false)
    assert.equal(budgetSchema.properties?.max_tokens.type, 'integer')
    assert.equal(budgetSchema.properties?.max_cost_usd.type, 'number')
    assert.equal(budgetSchema.properties?.max_tool_calls.minimum, 0)
    assert.equal(budgetSchema.properties?.max_download_bytes.minimum, 0)
  }
  assert.deepEqual(schema('Agent').required, ['name', 'description', 'prompt'])
  assert.ok(!schema('Agent').required?.includes('allowed_tools'))
  assert.ok(!schema('Agent').required?.includes('refs'))
  assert.equal(schema('Agent').properties?.refs.maxItems, 100)
  assert.deepEqual(schema('SendMessage').required, ['to', 'message'])
  assert.deepEqual(Object.keys(schema('SendMessage').properties ?? {}).sort(), [
    'message',
    'refs',
    'summary',
    'task_id',
    'to',
  ])
  assert.equal(schema('SendMessage').properties?.refs.maxItems, 100)
  assert.deepEqual(schema('TaskCreate').required, ['subject', 'description', 'owner'])
  assert.deepEqual(schema('TaskUpdate').required, ['task_id'])
  assert.ok(!(schema('TaskUpdate').properties?.status.enum as string[]).includes('submitted'))
  assert.ok(!(schema('TaskUpdate').properties?.status.enum as string[]).includes('running'))
  assert.deepEqual(schema('TaskGet').required, ['task_id'])
  const reviewResultSchema = schema('ReviewWorkspaceChanges')
  assert.deepEqual(reviewResultSchema.required, ['result_id', 'file_reviews'])
  const fileReviewItems = reviewResultSchema.properties?.file_reviews.items as {
    properties?: Record<string, Record<string, unknown>>
  }
  assert.ok(fileReviewItems)
  assert.ok(
    (fileReviewItems.properties?.action.enum as unknown[]).includes('request_changes'),
    'ReviewWorkspaceChanges file actions must include request_changes',
  )
  assert.equal(fileReviewItems.properties?.expected_target_revision.type, 'integer')
  assert.equal(fileReviewItems.properties?.expected_target_revision.minimum, 0)
  assert.match(
    String(fileReviewItems.properties?.expected_target_revision.description ?? ''),
    /omit.*target must not exist/i,
  )
  assert.deepEqual(schema('ManageAgent').required, ['name', 'action'])
  assert.equal(schema('ManageAgent').properties?.agent_id, undefined)
  const definitions = getToolSchemasForCapabilities({ supportsVision: true })
  assert.match(definitions.find(tool => tool.name === 'Agent')?.description ?? '', /idle/i)
  assert.match(definitions.find(tool => tool.name === 'Agent')?.description ?? '', /SendMessage/)
  assert.match(definitions.find(tool => tool.name === 'SendMessage')?.description ?? '', /automatically wakes/i)
  assert.match(definitions.find(tool => tool.name === 'SendMessage')?.description ?? '', /do not.*poll/i)
  assert.equal(schema('AskUserQuestion').properties?.questions.maxItems, 4)
  assert.equal(schema('RecallHistory').properties?.limit.maximum, 10)
}

async function verifyRuntimeGuards(): Promise<void> {
  const workspace = createInMemoryWorkspace()
  assert.equal((await executRead({ file_path: '', offset: 1 }, workspace, new Map())).is_error, true)
  assert.equal((await executeWrite({ file_path: '', content: 'x' }, workspace)).is_error, true)
  assert.equal((await executeEdit({ file_path: '', old_string: 'x', new_string: 'y' }, workspace)).is_error, true)
  assert.equal((await executeGlob({ pattern: '**/*', max_results: 0 }, workspace)).is_error, true)
  assert.equal((await executeGrep({ pattern: 'x', context_lines: 4 }, workspace)).is_error, true)
  assert.equal((await executeSkill({ name: '' }, new Map())).is_error, true)
  assert.equal((await executeWebSearch({ query: '' })).is_error, true)
  assert.equal((await executeArxivSearchPapers({ query: '' }, { workspace })).is_error, true)
  assert.equal((await executeArxivFetchPaper({ arxiv_id: '' }, { workspace })).is_error, true)
  assert.equal((await executeSciverseSearchPapers({}, { workspace })).is_error, true)
  assert.equal((await executeSciverseSearchEvidence({ query: '' }, { workspace })).is_error, true)
  assert.equal((await executeSciverseFetchPaper({ doc_id: '' }, { workspace })).is_error, true)
  assert.equal((await executeSciverseListRelations({
    unique_id: '',
    relation: 'REFERENCES',
  }, { workspace })).is_error, true)
  assert.equal((await executeSearchDocument({ query: '' }, { workspace })).is_error, true)
  assert.equal((await executeRecallHistory({ query: 'history', limit: 11 }, 'user')).is_error, true)
}

async function main(): Promise<void> {
  verifySchemas()
  await verifyRuntimeGuards()
  const behavior = buildBehaviorBlock()
  assert.match(behavior, /AskUserQuestion 只用于真正阻塞推进/)
  assert.match(behavior, /不要在同一响应中混用其他工具/)
  console.log('tool-contracts:verify passed')
}

void main()
