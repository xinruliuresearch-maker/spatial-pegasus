import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  SUBSTANTIVE_RETRIEVAL_TOOLS,
  gradeResearchSkillToolTrace,
  type ToolTraceExpectation,
} from './tool-trace-grader'
import { assertWorkspaceWritePath } from '../../lib/workspace/path-policy'

type JsonRecord = Record<string, unknown>

const baseDir = new URL('.', import.meta.url)
const allowedAssertionTypes = new Set([
  'contains',
  'not_contains',
  'regex',
  'file_exists',
  'file_glob_exists',
  'file_contains',
  'json_equals',
  'model',
])
const researchSkills = [
  'research-orchestration',
  'literature-discovery',
  'evidence-synthesis',
  'gap-and-hypothesis',
  'scientific-review',
  'research-reporting',
]
const fixtureRoots = new Set(['notes'])
const artifactRoots = new Set(['analysis', 'references', 'output'])
const forbiddenWorkspaceSegments = new Set(['.agents', '.codex', '.sci-pegasus', 'node_modules', '.git'])

function record(value: unknown, label: string): JsonRecord {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`)
  return value as JsonRecord
}

function array(value: unknown, label: string): unknown[] {
  assert.ok(Array.isArray(value), `${label} must be an array`)
  return value
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`)
  assert.ok(value.trim(), `${label} must not be empty`)
  return value
}

function readJson(filename: string): JsonRecord {
  return record(JSON.parse(readFileSync(new URL(filename, baseDir), 'utf8')) as unknown, filename)
}

function assertUnique(values: string[], label: string): void {
  assert.equal(new Set(values).size, values.length, `${label} must be unique`)
}

function assertSafeWorkspacePath(value: string, label: string, allowedRoots: ReadonlySet<string>): void {
  const normalized = assertWorkspaceWritePath(value, {
    allowedRoots: [...allowedRoots],
    allowedRootFiles: [],
  })
  assert.equal(normalized, value, `${label} must already be normalized`)
  const segments = value.split('/')
  assert.equal(segments.some(segment => forbiddenWorkspaceSegments.has(segment)), false,
    `${label} targets a reserved runtime directory`)
}

function validateAssertions(value: unknown, label: string): void {
  const assertions = array(value, label).map((item, index) => record(item, `${label}[${index}]`))
  const ids = assertions.map((item, index) => nonEmptyString(item.id, `${label}[${index}].id`))
  assertUnique(ids, `${label} ids`)
  for (const [index, assertion] of assertions.entries()) {
    nonEmptyString(assertion.text, `${label}[${index}].text`)
    const type = nonEmptyString(assertion.type, `${label}[${index}].type`)
    assert.ok(allowedAssertionTypes.has(type), `${label}[${index}] has unsupported type ${type}`)
    if (typeof assertion.path === 'string') {
      assertSafeWorkspacePath(assertion.path, `${label}[${index}].path`, artifactRoots)
    }
  }
}

function validateDefinitionOnlyPolicy(root: JsonRecord, filename: string, live: boolean): void {
  assert.equal(root.status, 'definitions_only_not_run')
  const policy = record(root.execution_policy, `${filename}.execution_policy`)
  assert.equal(policy.model_behavior_results_available, false)
  if (live) {
    assert.equal(policy.mode, 'live_sciverse_arxiv')
    assert.equal(policy.ci_allowed, false)
    assert.equal(policy.network_required, true)
    assert.equal(policy.estimate_only_required_before_run, true)
    assert.equal(policy.explicit_user_approval_required_after_estimate, true)
    assert.deepEqual(policy.approved_limits_required, [
      'model_calls_or_cli_turns',
      'literature_api_calls',
      'document_downloads',
    ])
  } else {
    assert.equal(policy.network_allowed, false)
    assert.equal(policy.model_or_agent_runs_in_ci, false)
  }
}

function validateEvalSet(filename: string, expectedIds: string[], live: boolean): void {
  const root = readJson(filename)
  assert.equal(root.schema_version, '1.0')
  const skill = record(root.skill, `${filename}.skill`)
  assert.equal(skill.name, 'research-orchestration')
  assert.equal(skill.target, 'portable')
  validateDefinitionOnlyPolicy(root, filename, live)

  if (live) {
    const requiredTools = array(root.required_tools, `${filename}.required_tools`)
      .map(value => nonEmptyString(value, `${filename} required tool`))
    assertUnique(requiredTools, `${filename} required tools`)
    for (const tool of ['Skill', 'SciverseSearchPapers', 'SciverseFetchPaper', 'ArxivSearchPapers', 'ArxivFetchPaper']) {
      assert.ok(requiredTools.includes(tool), `${filename} must require ${tool}`)
    }
  }

  const cases = array(root.cases, `${filename}.cases`).map((item, index) =>
    record(item, `${filename}.cases[${index}]`),
  )
  const ids = cases.map((item, index) => nonEmptyString(item.id, `${filename}.cases[${index}].id`))
  assertUnique(ids, `${filename} case ids`)
  assert.deepEqual([...ids].sort(), [...expectedIds].sort(), `${filename} coverage changed unexpectedly`)

  for (const [index, item] of cases.entries()) {
    nonEmptyString(item.prompt, `${filename}.cases[${index}].prompt`)
    assert.equal(item.should_trigger, true)
    const setupFiles = record(item.setup_files, `${filename}.cases[${index}].setup_files`)
    for (const [path, content] of Object.entries(setupFiles)) {
      assertSafeWorkspacePath(path, `${filename} setup path`, fixtureRoots)
      nonEmptyString(content, `${filename} setup file ${path}`)
    }
    const capabilities = array(
      item.required_capabilities,
      `${filename}.cases[${index}].required_capabilities`,
    ).map(value => nonEmptyString(value, `${filename} capability`))
    assert.equal(capabilities.includes('filesystem'), true)
    assert.equal(capabilities.includes('network'), live, `${filename} network isolation mismatch`)
    validateAssertions(item.assertions, `${filename}.cases[${index}].assertions`)
    const requiredArtifacts = array(item.assertions, 'assertions')
      .map(value => record(value, 'assertion'))
      .filter(assertion => assertion.type === 'file_exists')
      .map(assertion => assertion.path)
    for (const requiredPath of [
      'analysis/research-scope.md',
      'references/evidence-ledger.md',
      'output/research-report.md',
    ]) {
      assert.ok(requiredArtifacts.includes(requiredPath), `${item.id} must require ${requiredPath}`)
    }
  }
}

function validateSessionSet(): void {
  const filename = 'session-scenarios.json'
  const root = readJson(filename)
  assert.equal(root.schema_version, '1.0')
  validateDefinitionOnlyPolicy(root, filename, false)
  const dimensions = array(root.review_dimensions, `${filename}.review_dimensions`).map((item, index) =>
    record(item, `${filename}.review_dimensions[${index}]`),
  )
  assertUnique(dimensions.map(item => nonEmptyString(item.id, 'review dimension id')), 'review dimension ids')
  for (const dimension of dimensions) {
    for (const field of ['label', 'anchor_1', 'anchor_3', 'anchor_5']) {
      nonEmptyString(dimension[field], `review dimension ${field}`)
    }
  }

  const scenarios = array(root.scenarios, `${filename}.scenarios`).map((item, index) =>
    record(item, `${filename}.scenarios[${index}]`),
  )
  const expectedIds = [
    'review-gap-status-revision',
    'adjacency-boundary-refinement',
    'late-prompt-injection',
    'member-message-prompt-injection',
  ]
  const ids = scenarios.map(item => nonEmptyString(item.id, 'scenario id'))
  assert.deepEqual([...ids].sort(), [...expectedIds].sort())
  assertUnique(ids, 'session scenario ids')
  for (const scenario of scenarios) {
    const setupFiles = record(scenario.setup_files, `${scenario.id}.setup_files`)
    for (const [path, content] of Object.entries(setupFiles)) {
      assertSafeWorkspacePath(path, `${scenario.id} setup path`, fixtureRoots)
      nonEmptyString(content, `${scenario.id} setup file ${path}`)
    }
    const capabilities = array(scenario.required_capabilities, 'session required_capabilities')
    assert.ok(capabilities.includes('filesystem'))
    assert.ok(capabilities.includes('persistent_session'))
    assert.equal(capabilities.includes('network'), false)
    const turns = array(scenario.turns, 'session turns').map((item, index) => record(item, `turn[${index}]`))
    assert.ok(turns.length >= 2)
    assertUnique(turns.map(item => nonEmptyString(item.id, 'turn id')), `${scenario.id} turn ids`)
    for (const turn of turns) nonEmptyString(turn.prompt, 'turn prompt')
    const turnIds = new Set(turns.map(item => item.id as string))
    if (scenario.injected_events !== undefined) {
      const events = array(scenario.injected_events, `${scenario.id}.injected_events`)
        .map((item, index) => record(item, `${scenario.id}.injected_events[${index}]`))
      assert.ok(capabilities.includes('agent_team'), `${scenario.id} injected events require agent_team`)
      for (const event of events) {
        const afterTurn = nonEmptyString(event.after_turn, `${scenario.id} event after_turn`)
        assert.ok(turnIds.has(afterTurn), `${scenario.id} event refers to an unknown turn`)
        assert.equal(event.type, 'agent_mailbox_message')
        assert.equal(event.sender_role, 'member')
        nonEmptyString(event.message_kind, `${scenario.id} event message_kind`)
        nonEmptyString(event.content, `${scenario.id} event content`)
      }
    }
    validateAssertions(scenario.assertions, `${scenario.id}.assertions`)
  }
}

function validateExperimentManifest(): void {
  const filename = 'experiment-manifest.json'
  const root = readJson(filename)
  assert.equal(root.schema_version, '1.0')
  assert.equal(root.status, 'definitions_only_not_run')
  const comparison = record(root.comparison, `${filename}.comparison`)
  assert.equal(comparison.primary, 'candidate')
  assert.equal(comparison.baseline, 'no_skill')
  assert.equal(comparison.paired_cases, true)
  assert.ok(Number(comparison.minimum_repetitions) >= 1)

  const configurations = array(root.configurations, `${filename}.configurations`)
    .map((item, index) => record(item, `${filename}.configurations[${index}]`))
  assert.deepEqual(configurations.map(item => item.id), ['no_skill', 'candidate'])
  assert.equal(configurations[0].project_guide, null)
  assert.deepEqual(configurations[0].skills, [])
  const guide = record(configurations[1].project_guide, 'candidate.project_guide')
  assert.equal(guide.template_id, 'materials-discovery')
  assert.equal(guide.version, 1)
  assert.deepEqual(configurations[1].skills, researchSkills)

  const sets = record(root.sets, `${filename}.sets`)
  assert.deepEqual(sets, {
    offline_output: 'evals.json',
    offline_session: 'session-scenarios.json',
    trigger_and_order: 'trigger-cases.json',
    live: 'live-cases.json',
  })
  const policy = record(root.execution_policy, `${filename}.execution_policy`)
  assert.equal(policy.model_or_agent_runs_in_ci, false)
  assert.equal(policy.model_behavior_results_available, false)
  assert.equal(policy.estimate_only_required_before_any_model_run, true)
  assert.equal(policy.explicit_user_approval_required_after_estimate, true)
}

function expectation(value: unknown, label: string): ToolTraceExpectation {
  const parsed = record(value, label)
  const result: ToolTraceExpectation = {}
  for (const key of [
    'required_skill',
    'must_precede_first_substantive_retrieval',
    'forbid_skill',
    'forbid_substantive_retrieval',
  ] as const) {
    if (parsed[key] !== undefined) Object.assign(result, { [key]: parsed[key] })
  }
  return result
}

function validateTriggerSetAndTraceGrader(): void {
  const filename = 'trigger-cases.json'
  const root = readJson(filename)
  assert.equal(root.schema_version, '1.0')
  assert.equal(root.subject, 'research-orchestration')
  assert.equal(root.status, 'definitions_only_not_run')
  assert.equal(root.trace_grader, 'tool-trace-grader.ts')
  const cases = array(root.cases, `${filename}.cases`)
    .map((item, index) => record(item, `${filename}.cases[${index}]`))
  const expectedIds = [
    'trigger-substantive-gap-research',
    'trigger-multi-paper-conflict-research',
    'skip-simple-concept-explanation',
    'skip-product-strategy-discussion',
    'skip-ordinary-file-edit',
  ]
  const ids = cases.map(item => nonEmptyString(item.id, 'trigger case id'))
  assert.deepEqual(ids, expectedIds)
  assertUnique(ids, 'trigger case ids')
  assert.equal(cases.filter(item => item.should_trigger === true).length, 2)
  assert.equal(cases.filter(item => item.should_trigger === false).length, 3)
  for (const item of cases) {
    nonEmptyString(item.prompt, `${item.id}.prompt`)
    assert.equal(typeof item.should_trigger, 'boolean')
    const traceExpectation = expectation(item.expectation, `${item.id}.expectation`)
    if (item.should_trigger) {
      assert.equal(traceExpectation.required_skill, 'research-orchestration')
      assert.equal(traceExpectation.must_precede_first_substantive_retrieval, true)
    } else {
      assert.equal(traceExpectation.forbid_skill, 'research-orchestration')
      assert.equal(traceExpectation.forbid_substantive_retrieval, true)
    }
  }

  const positiveExpectation = expectation(cases[0].expectation, 'positive expectation')
  assert.equal(gradeResearchSkillToolTrace([
    { sequence: 1, tool_name: 'Skill', input: { skill: 'research-orchestration' } },
    { sequence: 2, tool_name: 'SciverseSearchPapers', input: { query: 'material X' } },
  ], positiveExpectation).passed, true)
  assert.equal(gradeResearchSkillToolTrace([
    { sequence: 1, tool_name: 'ArxivSearchPapers', input: { query: 'material X' } },
    { sequence: 2, tool_name: 'Skill', input: { name: 'research-orchestration' } },
  ], positiveExpectation).passed, false)
  assert.equal(gradeResearchSkillToolTrace([], positiveExpectation).passed, false)

  const negativeExpectation = expectation(cases[2].expectation, 'negative expectation')
  assert.equal(gradeResearchSkillToolTrace([
    { sequence: 1, tool_name: 'Read', input: { file_path: 'analysis/notes.md' } },
  ], negativeExpectation).passed, true)
  assert.equal(gradeResearchSkillToolTrace([
    { sequence: 1, tool_name: 'Skill', input: { skill_name: 'research-orchestration' } },
  ], negativeExpectation).passed, false)
  assert.equal(gradeResearchSkillToolTrace([
    { sequence: 1, tool_name: SUBSTANTIVE_RETRIEVAL_TOOLS[0] },
  ], negativeExpectation).passed, false)
  assert.throws(() => gradeResearchSkillToolTrace([
    { sequence: 1, tool_name: 'Skill' },
    { sequence: 1, tool_name: 'SciverseSearchPapers' },
  ], positiveExpectation), /unique/)
}

function verifyWorkspacePathGuard(): void {
  assert.doesNotThrow(() => assertSafeWorkspacePath('notes/eval-fixtures/literature-pack.md', 'valid fixture', fixtureRoots))
  for (const unsafe of [
    '../outside.md',
    'notes/../outside.md',
    '/tmp/outside.md',
    'notes\\outside.md',
    '.agents/skill.md',
    'notes/.sci-pegasus/private.md',
  ]) {
    assert.throws(() => assertSafeWorkspacePath(unsafe, 'unsafe fixture', fixtureRoots))
  }
}

validateEvalSet('evals.json', [
  'review-gap-answered',
  'review-gap-partially-answered',
  'review-gap-conditionally-answered',
  'conditional-versus-true-conflict',
  'high-citation-low-scope-review',
  'review-without-explicit-cutoff',
  'hybrid-new-material',
  'adjacency-and-analogy-break',
  'single-source-provisional',
  'honest-no-gap',
  'preprint-journal-version-deduplication',
  'untrusted-literature-instructions',
], false)
validateEvalSet('live-cases.json', [
  'live-battery-review-update',
  'live-catalysis-conflict',
  'live-semiconductor-hybrid',
], true)
validateSessionSet()
validateExperimentManifest()
validateTriggerSetAndTraceGrader()
verifyWorkspacePathGuard()

console.log('research-strategy definitions/contracts verified; no model or live behavior was run')
