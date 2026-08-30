import { ToolResult, SkillDefinition } from '../types'

interface SkillInput {
  name: string
  args?: string
}

export async function executeSkill(
  input: SkillInput,
  skills: Map<string, SkillDefinition>
): Promise<ToolResult> {
  if (typeof input.name !== 'string' || !input.name.trim()) {
    return { content: 'Skill name cannot be empty', is_error: true }
  }
  if (input.args !== undefined && typeof input.args !== 'string') {
    return { content: 'Skill args must be a string', is_error: true }
  }
  const name = input.name.trim()
  const skill = skills.get(name)
  if (!skill) {
    const available = Array.from(skills.keys()).join(', ')
    return {
      content: `Skill "${name}" not found. Available skills: ${available}`,
      is_error: true,
    }
  }

  // Format aligned with Claude Code's Skill tool return:
  // "Launching skill" + "Base directory" + full SKILL.md content
  const argsLine = input.args ? `\n\nArguments: ${input.args}` : ''
  return {
    content: `Launching skill: ${skill.name}${argsLine}\n\nBase directory for this skill: /skills/${skill.name}\n\n${skill.body}`,
  }
}
