import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { SkillDefinition } from '../../types'
import { createInMemoryWorkspace } from '../__test-utils__/in-memory-workspace'
import { executRead } from '../read'

async function main(): Promise<void> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'sci-pegasus-read-skill-'))
  const skillDir = join(tempRoot, 'research-orchestration')
  const referencesDir = join(skillDir, 'references')
  const outsidePath = join(tempRoot, 'outside.md')
  const escapedSkillDir = join(tempRoot, 'escaped-skill')
  const outsideReferencesDir = join(tempRoot, 'outside-references')

  try {
    await mkdir(join(referencesDir, 'nested'), { recursive: true })
    await writeFile(join(referencesDir, 'guide.md'), '# Guide\ninside', 'utf8')
    await writeFile(join(referencesDir, '证据.md'), '# Evidence\nencoded filename', 'utf8')
    await writeFile(join(referencesDir, 'nested', 'matrix.md'), '# Matrix', 'utf8')
    await writeFile(outsidePath, 'must never be readable', 'utf8')
    await symlink(outsidePath, join(referencesDir, 'outside-link.md'))
    await mkdir(escapedSkillDir, { recursive: true })
    await mkdir(outsideReferencesDir, { recursive: true })
    await writeFile(join(outsideReferencesDir, 'escaped.md'), 'escaped root secret', 'utf8')
    await symlink(outsideReferencesDir, join(escapedSkillDir, 'references'))

    const skill: SkillDefinition = {
      name: 'research-orchestration',
      description: 'test skill',
      body: 'test',
      dirPath: skillDir,
    }
    const skills = new Map([[skill.name, skill]])
    skills.set('escaped-skill', {
      name: 'escaped-skill',
      description: 'references root symlink escape fixture',
      body: 'test',
      dirPath: escapedSkillDir,
    })
    const workspace = createInMemoryWorkspace()

    const plain = await executRead(
      { file_path: '/skills/research-orchestration/references/guide.md' },
      workspace,
      skills,
    )
    assert.equal(plain.is_error, undefined)
    assert.match(plain.content, /inside/)

    const nested = await executRead(
      { file_path: '/skills/research-orchestration/references/nested/matrix.md' },
      workspace,
      skills,
    )
    assert.equal(nested.is_error, undefined)
    assert.match(nested.content, /Matrix/)

    const encodedFilename = await executRead(
      { file_path: '/skills/research-orchestration/references/%E8%AF%81%E6%8D%AE.md' },
      workspace,
      skills,
    )
    assert.equal(encodedFilename.is_error, undefined)
    assert.match(encodedFilename.content, /encoded filename/)

    const rejectedPaths = [
      '/skills/research-orchestration/references/../outside.md',
      '/skills/research-orchestration/references/%2e%2e%2foutside.md',
      '/skills/research-orchestration/references/%2Fetc%2Fpasswd',
      '/skills/research-orchestration/references//etc/passwd',
      '/skills/research-orchestration/references/%ZZ',
      '/skills/research-orchestration/references/outside-link.md',
    ]

    for (const filePath of rejectedPaths) {
      const result = await executRead({ file_path: filePath }, workspace, skills)
      assert.equal(result.is_error, true, `expected rejection for ${filePath}`)
      assert.doesNotMatch(result.content, /must never be readable/)
    }

    const escapedRoot = await executRead(
      { file_path: '/skills/escaped-skill/references/escaped.md' },
      workspace,
      skills,
    )
    assert.equal(escapedRoot.is_error, true)
    assert.doesNotMatch(escapedRoot.content, /escaped root secret/)

    console.log('read-skill-references:verify passed')
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

void main()
