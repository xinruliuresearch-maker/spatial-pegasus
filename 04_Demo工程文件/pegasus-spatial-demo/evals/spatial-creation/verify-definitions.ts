import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

type JsonRecord = Record<string, unknown>

function record(value: unknown, label: string): JsonRecord {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`)
  return value as JsonRecord
}

function strings(value: unknown, label: string): string[] {
  assert.ok(Array.isArray(value), `${label} must be an array`)
  for (const item of value) assert.equal(typeof item, 'string', `${label} must contain strings`)
  return value as string[]
}

const root = record(JSON.parse(readFileSync(new URL('./behavior-cases.json', import.meta.url), 'utf8')), 'root')
assert.equal(root.schema_version, '1.0')
assert.equal(root.status, 'definitions_only_not_run')
const policy = record(root.execution_policy, 'execution_policy')
assert.equal(policy.network_allowed, false)
assert.equal(policy.model_or_agent_runs_in_ci, false)
assert.equal(policy.model_behavior_results_available, false)
assert.equal(policy.live_replay_required_before_demo, true)

const expensive = strings(root.expensive_tools, 'expensive_tools')
assert.deepEqual(expensive.sort(), ['CreateObject3D', 'CreateWorld3D', 'GenerateImage'].sort())
const cases = (root.cases as unknown[]).map((value, index) => record(value, `cases[${index}]`))
const expectedIds = [
  'direct-object-request',
  'direct-world-request',
  'reference-image-edit',
  'ambiguous-object-or-world',
  'scene-observation-adjustment',
  'format-basis-orientation-review',
  'lux-modular-environment-assembly',
  'lux-important-module-multiview',
  'parallel-asset-fanout',
  'asset-maker-submit-and-continue',
  'async-spatial-published-notification',
  'two-ready-assets-serialized-placement',
]
assert.deepEqual(cases.map(value => value.id).sort(), expectedIds.sort())

for (const value of cases) {
  assert.equal(typeof value.prompt, 'string')
  assert.ok((value.prompt as string).trim())
  const expected = record(value.expected, `${String(value.id)}.expected`)
  assert.equal(expected.final_language, 'zh-CN')
}

const byId = new Map(cases.map(value => [value.id, record(value.expected, `${String(value.id)}.expected`)]))
assert.deepEqual(byId.get('direct-object-request')?.must_call_one_of, ['CreateObject3D'])
assert.deepEqual(byId.get('direct-world-request')?.must_call_one_of, ['CreateWorld3D'])
assert.deepEqual(byId.get('reference-image-edit')?.must_call_one_of, ['GenerateImage'])
assert.deepEqual(byId.get('ambiguous-object-or-world')?.must_call_one_of, ['AskUserQuestion'])
assert.deepEqual(byId.get('scene-observation-adjustment')?.must_call_one_of, ['TransformSceneObject'])
assert.deepEqual(byId.get('scene-observation-adjustment')?.must_eventually_call, ['CaptureSceneView'])
assert.equal(byId.get('scene-observation-adjustment')?.cost_only_ask_forbidden, true)
assert.equal(byId.get('format-basis-orientation-review')?.classification, 'asset_basis_mismatch')
assert.deepEqual(byId.get('format-basis-orientation-review')?.must_not_call, ['TransformSceneObject'])
assert.deepEqual(byId.get('format-basis-orientation-review')?.required_review_checks, [
  'gravity_direction',
  'support_points',
  'load_bearing_surface',
  'same_camera_format_comparison',
])
assert.equal(byId.get('format-basis-orientation-review')?.ambiguous_single_view_status, 'unknown')
assert.deepEqual(byId.get('lux-modular-environment-assembly')?.must_call_one_of, ['CreateObject3D'])
assert.deepEqual(byId.get('lux-modular-environment-assembly')?.must_eventually_call, [
  'CreateSpatialScene',
  'AddSceneObject',
])
assert.equal(byId.get('lux-modular-environment-assembly')?.world_role, 'optional_ambient_background')
assert.equal(byId.get('lux-modular-environment-assembly')?.editable_truth, 'glb')
assert.deepEqual(byId.get('lux-important-module-multiview')?.must_call_one_of, ['CreateObject3D'])
assert.equal(byId.get('lux-important-module-multiview')?.reference_image_count, 2)
assert.deepEqual(byId.get('lux-important-module-multiview')?.must_not_call, ['CreateWorld3D'])
assert.equal(byId.get('parallel-asset-fanout')?.must_create_agents_min, 2)
assert.equal(byId.get('parallel-asset-fanout')?.single_scene_mutation_owner, true)
assert.equal(byId.get('parallel-asset-fanout')?.must_not_reject_due_to_project_slot_limit, true)
assert.equal(byId.get('parallel-asset-fanout')?.worker_submission_concurrency_configurable, true)
assert.deepEqual(byId.get('asset-maker-submit-and-continue')?.must_not_call, ['WaitSpatialJob'])
assert.equal(byId.get('asset-maker-submit-and-continue')?.must_not_claim_published, true)
assert.equal(byId.get('async-spatial-published-notification')?.notification_kind, 'spatial_job_update')
assert.equal(byId.get('async-spatial-published-notification')?.same_tool_use_second_result_forbidden, true)
assert.equal(byId.get('async-spatial-published-notification')?.duplicate_terminal_delivery_count, 1)
assert.equal(byId.get('two-ready-assets-serialized-placement')?.single_scene_mutation_owner, true)
assert.equal(byId.get('two-ready-assets-serialized-placement')?.expected_final_scene_version, 6)
assert.deepEqual(
  record(
    byId.get('lux-important-module-multiview')?.forbidden_tool_fields,
    'lux-important-module-multiview.forbidden_tool_fields',
  ).CreateObject3D,
  ['prompt'],
)
for (const id of ['direct-object-request', 'direct-world-request']) {
  assert.deepEqual(byId.get(id)?.optional_before_target, ['GenerateImage'])
}

console.log('spatial-creation behavior definition verification passed')
