import assert from 'node:assert/strict'
import { executeEdit } from '../edit'
import { executeGlob } from '../glob'
import { executeGrep } from '../grep'
import { executeWrite } from '../write'
import { createInMemoryWorkspace } from '../__test-utils__/in-memory-workspace'
import {
  assertWorkspaceWritePath,
  buildVersionArchivePath,
  isInternalWorkspacePath,
  isManagedLiteratureArtifactPath,
} from '../../workspace/path-policy'
import { userVisibleWorkspaceRecord } from '../../workspace/public-view'

function verifyWorkspacePolicy(): void {
  assert.equal(assertWorkspaceWritePath('/workspace/analysis/report.md'), 'analysis/report.md')
  assert.equal(
    buildVersionArchivePath('analysis/report.md', 3),
    '.sci-pegasus/versions/analysis/report/v3.md',
  )
  assert.equal(isInternalWorkspacePath('.sci-pegasus/settings/project.md'), true)
  assert.equal(isInternalWorkspacePath('analysis/report.md'), false)
  assert.equal(isInternalWorkspacePath('output/spatial/images/concept_ecotech_city_landmark_dusk_v1.png'), false)
  assert.equal(isInternalWorkspacePath('output/research_report_v2.md'), false)
  assert.equal(isManagedLiteratureArtifactPath('references/searches/search-abc.json'), true)
  assert.equal(isManagedLiteratureArtifactPath('references/papers/arxiv-abc/parsed/fulltext.md'), true)
  assert.equal(isManagedLiteratureArtifactPath('references/papers/arxiv-abc/original.pdf'), true)
  assert.equal(isManagedLiteratureArtifactPath('references/papers/arxiv-abc/notes.md'), false)
  for (const invalid of ['/etc/passwd', '../escape.md', 'custom/file.md', 'ROOT.md']) {
    assert.throws(() => assertWorkspaceWritePath(invalid), invalid)
  }
}

async function verifyTools(): Promise<void> {
  const workspace = createInMemoryWorkspace()
  assert.equal((await executeWrite({
    file_path: 'analysis/research-gaps.md',
    content: 'Evidence A\nContradiction B\nEvidence A',
  }, workspace)).is_error, undefined)
  assert.equal((await executeEdit({
    file_path: 'analysis/research-gaps.md',
    old_string: 'Evidence A',
    new_string: 'Evidence A [verified]',
    replace_all: true,
  }, workspace)).is_error, undefined)
  await executeWrite({
    file_path: '.sci-pegasus/settings/project.md',
    content: 'route: undecided',
  }, workspace)
  assert.equal((await executeWrite({
    file_path: 'references/searches/search-abc.json',
    content: '{}',
  }, workspace)).is_error, true)
  assert.equal((await executeEdit({
    file_path: 'references/papers/arxiv-abc/parsed/fulltext.md',
    old_string: 'x',
    new_string: 'y',
  }, workspace)).is_error, true)

  const glob = await executeGlob({ pattern: '**/*.md' }, workspace)
  assert.match(glob.content, /analysis\/research-gaps\.md/)
  assert.match(glob.content, /\.sci-pegasus\/settings\/project\.md/)

  const grep = await executeGrep({ pattern: 'verified', literal: true }, workspace)
  assert.match(grep.content, /research-gaps\.md:1/)

  assert.deepEqual(
    userVisibleWorkspaceRecord(workspace.dump()),
    { 'analysis/research-gaps.md': 'Evidence A [verified]\nContradiction B\nEvidence A [verified]' },
  )
}

async function main(): Promise<void> {
  verifyWorkspacePolicy()
  await verifyTools()
  console.log('workspace-tools:verify passed')
}

void main()
