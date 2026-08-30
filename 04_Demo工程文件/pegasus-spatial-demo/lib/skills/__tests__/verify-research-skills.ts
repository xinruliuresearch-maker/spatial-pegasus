import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { loadSkills } from '../loader'

const ROOT = path.join(process.cwd(), 'lib', 'skills')

const SPECS = {
  'research-orchestration': [
    'path-selection.md',
    'team-and-stopping.md',
  ],
  'literature-discovery': [
    'review-update.md',
    'adjacent-search.md',
    'failure-modes.md',
  ],
  'evidence-synthesis': [
    'evidence-ledger-and-matrix.md',
    'conflict-analysis.md',
  ],
  'gap-and-hypothesis': [
    'gap-register.md',
    'hypothesis-and-directions.md',
  ],
  'scientific-review': [
    'review-checklist.md',
    'adversarial-cases.md',
  ],
  'research-reporting': [
    'markdown-templates.md',
    'language-and-failures.md',
  ],
} as const

function verifySkillFiles(): string {
  const loaded = loadSkills()
  const aggregate: string[] = []

  for (const [name, expectedReferences] of Object.entries(SPECS)) {
    const skillDir = path.join(ROOT, name)
    const skillPath = path.join(skillDir, 'SKILL.md')
    assert.ok(fs.existsSync(skillPath), `${name} is missing SKILL.md`)

    const raw = fs.readFileSync(skillPath, 'utf8')
    const loadedSkill = loaded.get(name)
    assert.ok(loadedSkill, `${name} was not loaded`)
    assert.equal(loadedSkill.name, name)
    const frontmatter = raw.match(/^---\n([\s\S]*?)\n---\n/)
    assert.ok(frontmatter, `${name} needs valid frontmatter boundaries`)
    const frontmatterKeys = [...frontmatter[1].matchAll(/^([a-z][a-z-]*):/gm)]
      .map(match => match[1])
      .sort()
    assert.deepEqual(frontmatterKeys, ['description', 'name'], `${name} frontmatter should stay minimal`)
    assert.match(raw, new RegExp(`^name: ${name}$`, 'm'))
    assert.match(name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    assert.ok(loadedSkill.description.length <= 1024, `${name} description is too long`)
    assert.match(loadedSkill.description, /用于/, `${name} needs a positive trigger`)
    assert.match(loadedSkill.description, /不用于/, `${name} needs a negative trigger`)

    const referenced = new Set<string>()
    const referencePattern = new RegExp(`/skills/${name}/references/([a-z0-9-]+\\.md)`, 'g')
    for (const match of raw.matchAll(referencePattern)) referenced.add(match[1])

    for (const file of expectedReferences) {
      assert.ok(referenced.has(file), `${name} must directly reference ${file}`)
      const referencePath = path.join(skillDir, 'references', file)
      assert.ok(fs.existsSync(referencePath), `${name} reference is unreadable: ${file}`)
      const relative = path.relative(path.join(skillDir, 'references'), referencePath)
      assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative), `${name} reference escaped its directory`)
      const content = fs.readFileSync(referencePath, 'utf8')
      assert.ok(content.trim().length > 100, `${name} reference is unexpectedly empty: ${file}`)
      aggregate.push(content)
    }

    aggregate.push(raw)
  }

  assert.equal(
    [...loaded.keys()].filter(name => name in SPECS).length,
    Object.keys(SPECS).length,
    'all research skills should be discoverable',
  )

  return aggregate.join('\n')
}

function verifyResearchInvariants(content: string): void {
  for (const route of ['review_update', 'adjacent_tension', 'hybrid']) {
    assert.match(content, new RegExp(route), `missing research route ${route}`)
  }

  assert.match(content, /主锚点综述/)
  assert.match(content, /1–2 篇/)
  assert.match(content, /impact_boost/)
  assert.match(content, /sort_by_year: "none"/)
  assert.match(content, /Journal Impact Factor/)
  assert.match(content, /至少两条独立来源链/)
  assert.match(content, /single-source \/ provisional/)

  for (const response of [
    'direct_response',
    'partial_response',
    'indirect_response',
    'contradict',
    'qualify',
    'no_response',
  ]) {
    assert.match(content, new RegExp(response), `missing response label ${response}`)
  }

  for (const status of [
    'candidate',
    'unresolved',
    'attempted',
    'partially_answered',
    'conditionally_answered',
    'contested',
    'answered',
    'reframed',
    'indeterminate',
  ]) {
    assert.match(content, new RegExp(status), `missing Gap status ${status}`)
  }

  for (const axis of [
    'material/composition',
    'structure/interface/morphology',
    'mechanism/phenomenon',
    'synthesis/process',
    'characterization/measurement',
    'computation/model/data treatment',
    'application/function/metric',
    'operating regime/scale/failure mode',
  ]) {
    assert.ok(content.includes(axis), `missing adjacency axis ${axis}`)
  }

  assert.match(content, /1–3 个 Agent/)
  assert.match(content, /3–5 个 Agent/)
  assert.match(content, /idle Agent/)
  assert.match(content, /SendMessage/)
  assert.match(content, /observed/)
  assert.match(content, /author-proposed/)
  assert.match(content, /agent-inferred/)
  assert.match(content, /experimentally-tested/)
}

function verifyIndependentScientificReviewGate(): void {
  const orchestration = fs.readFileSync(
    path.join(ROOT, 'research-orchestration', 'SKILL.md'),
    'utf8',
  )
  const teamReference = fs.readFileSync(
    path.join(ROOT, 'research-orchestration', 'references', 'team-and-stopping.md'),
    'utf8',
  )

  assert.match(orchestration, /任何实质性最终研究报告在标记完成前[^]*scientific-review/)
  assert.match(orchestration, /没有复核记录[^]*只能称为 draft/)
  assert.match(orchestration, /未主导相关检索\/综合分支的隔离成员/)
  assert.match(orchestration, /窄问题由 Root 独立完成时[^]*对抗性复核 pass/)
  assert.match(orchestration, /analysis\/scientific-review\.md/)
  assert.match(orchestration, /critical\/major[^]*再对受影响判断复核/)

  assert.match(teamReference, /完成门槛，不是可选润色步骤/)
  assert.match(teamReference, /多 Agent 或争议任务[^]*未主导相关检索、证据综合或 Gap 判定的成员/)
  assert.match(teamReference, /窄 Root-only 任务[^]*独立对抗性 pass/)
  assert.match(teamReference, /没有复核记录时[^]*不能声称实质性最终报告已完成/)
}

function verifyResearchReportingLanguageContract(): void {
  const reporting = fs.readFileSync(
    path.join(ROOT, 'research-reporting', 'SKILL.md'),
    'utf8',
  )
  const template = fs.readFileSync(
    path.join(ROOT, 'research-reporting', 'references', 'markdown-templates.md'),
    'utf8',
  )

  assert.match(reporting, /面向用户的综合交付默认使用中文/)
  assert.match(reporting, /只有用户明确要求其他语言时[^]*切换/)
  assert.match(reporting, /英文[^]*本身不等于用户明确要求英文交付/)
  assert.match(
    reporting,
    /论文题名[^]*必要的原文引文[^]*参考文献[^]*代码[^]*路径[^]*C\/E\/G\/H ID[^]*公式[^]*化学式[^]*保留原文/,
  )

  assert.match(template, /^# 科研发现报告$/m)
  for (const heading of [
    '核心结论',
    '范围与方法',
    '领域地图与锚点综述',
    '证据支持的发现',
    'Gap 状态更新',
    '冲突与边界条件',
    '假设与研究方向',
    '限制与负结果',
    '复现路径索引',
  ]) {
    assert.match(template, new RegExp(`^## ${heading}$`, 'm'), `missing Chinese report heading: ${heading}`)
  }
  for (const retiredHeading of [
    'Research discovery report',
    'Executive answer',
    'Scope and method',
    'Field map and anchor reviews',
    'Evidence-backed findings',
    'Gap status update',
    'Conflicts and boundary conditions',
    'Hypotheses and research directions',
    'Limitations and negative findings',
    'Reproduction map',
  ]) {
    assert.doesNotMatch(
      template,
      new RegExp(`^#{1,2} ${retiredHeading}$`, 'm'),
      `retired English report heading returned: ${retiredHeading}`,
    )
  }

  assert.match(template, /用户明确要求其他语言/)
  assert.match(template, /论文题名[^]*必要的原文引文[^]*参考文献[^]*代码[^]*路径[^]*C\/E\/G\/H ID[^]*公式[^]*化学式[^]*保留原文/)
  assert.match(template, /review_update[^]*adjacent_tension[^]*hybrid/)
  assert.match(template, /^## 证据账本索引$/m)
  assert.doesNotMatch(template, /^## Evidence Ledger 索引$/m)
  assert.match(template, /^# 证据账本$/m)
  assert.match(template, /\| G ID \| 归一化 Gap \| 状态 \| 范围 \|/)
}

const content = verifySkillFiles()
verifyResearchInvariants(content)
verifyIndependentScientificReviewGate()
verifyResearchReportingLanguageContract()

console.log('Research skill verification passed.')
