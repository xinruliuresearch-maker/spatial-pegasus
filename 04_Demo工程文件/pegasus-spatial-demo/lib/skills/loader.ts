import fs from 'fs'
import path from 'path'
import { SkillDefinition } from '../types'

const PROJECT_GUIDE_SKILLS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'spatial-creation': Object.freeze(['imagegen', 'spatial-creation']),
  'materials-discovery': Object.freeze([
    'research-orchestration',
    'literature-discovery',
    'evidence-synthesis',
    'gap-and-hypothesis',
    'scientific-review',
    'research-reporting',
  ]),
})

export interface LoadSkillsOptions {
  projectGuideTemplateId?: string
}

/**
 * Scan the skills directory and parse all SKILL.md files.
 * Extracts YAML frontmatter (name + description) and body content.
 * Returns a Map of skill name → SkillDefinition.
 */
export function loadSkills(options: LoadSkillsOptions = {}): Map<string, SkillDefinition> {
  const skills = new Map<string, SkillDefinition>()
  const skillsDir = path.join(process.cwd(), 'lib', 'skills')
  const projectSkillNames = options.projectGuideTemplateId
    ? PROJECT_GUIDE_SKILLS[options.projectGuideTemplateId]
    : undefined
  const allowedNames = options.projectGuideTemplateId
    ? new Set(projectSkillNames ?? [])
    : undefined

  if (!fs.existsSync(skillsDir)) return skills

  const entries = fs.readdirSync(skillsDir, { withFileTypes: true })

  for (const entry of entries) {
    if (!entry.isDirectory()) continue

    const skillMdPath = path.join(skillsDir, entry.name, 'SKILL.md')
    if (!fs.existsSync(skillMdPath)) continue

    const raw = fs.readFileSync(skillMdPath, 'utf-8')
    const parsed = parseFrontmatter(raw)

    if (!parsed.name || !parsed.description) continue
    if (allowedNames && !allowedNames.has(parsed.name)) continue

    skills.set(parsed.name, {
      name: parsed.name,
      description: parsed.description,
      body: parsed.body,
      dirPath: path.join(skillsDir, entry.name),
    })
  }

  return skills
}

interface ParsedSkill {
  name: string
  description: string
  body: string
}

function parseFrontmatter(content: string): ParsedSkill {
  const fmRegex = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/
  const match = content.match(fmRegex)

  if (!match) {
    return { name: '', description: '', body: content }
  }

  const frontmatter = match[1]
  const body = match[2].trim()

  // Simple YAML parsing for name and description
  const name = extractYamlField(frontmatter, 'name')
  const description = extractYamlField(frontmatter, 'description')

  return { name, description, body }
}

function extractYamlField(yaml: string, field: string): string {
  // Try multi-line block scalar first (`field: >\n  ...`). The single-line
  // pattern below would otherwise match the literal `>` as the field value
  // and skip the actual content on the indented lines that follow.
  const multiLine = new RegExp(`^${field}:\\s*>\\s*\\n((?:  .+\\n?)*)`, 'm')
  const multiMatch = yaml.match(multiLine)
  if (multiMatch) {
    return multiMatch[1]
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)
      .join(' ')
  }

  // Fallback: single-line `field: value`
  const singleLine = new RegExp(`^${field}:\\s*(.+)$`, 'm')
  const singleMatch = yaml.match(singleLine)
  if (singleMatch) {
    return singleMatch[1].trim().replace(/^["']|["']$/g, '')
  }

  return ''
}
