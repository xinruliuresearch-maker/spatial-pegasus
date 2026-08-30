export const SUBSTANTIVE_RETRIEVAL_TOOLS = Object.freeze([
  'SciverseSearchPapers',
  'SciverseSearchEvidence',
  'SciverseListRelations',
  'SciverseFetchPaper',
  'ArxivSearchPapers',
  'ArxivFetchPaper',
] as const)

export interface ToolTraceEvent {
  sequence: number
  tool_name: string
  input?: unknown
}

export interface ToolTraceExpectation {
  required_skill?: string
  must_precede_first_substantive_retrieval?: boolean
  forbid_skill?: string
  forbid_substantive_retrieval?: boolean
}

export interface ToolTraceGrade {
  passed: boolean
  evidence: string[]
}

function skillNameFromInput(input: unknown): string | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const record = input as Record<string, unknown>
  for (const key of ['skill', 'name', 'skill_name']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function validateTrace(trace: readonly ToolTraceEvent[]): ToolTraceEvent[] {
  const ordered = [...trace].sort((left, right) => left.sequence - right.sequence)
  const seen = new Set<number>()
  for (const event of ordered) {
    if (!Number.isInteger(event.sequence) || event.sequence < 0) {
      throw new Error('tool trace sequence must be a non-negative integer')
    }
    if (seen.has(event.sequence)) throw new Error('tool trace sequence values must be unique')
    seen.add(event.sequence)
    if (typeof event.tool_name !== 'string' || !event.tool_name.trim()) {
      throw new Error('tool trace tool_name must be a non-empty string')
    }
  }
  return ordered
}

export function gradeResearchSkillToolTrace(
  trace: readonly ToolTraceEvent[],
  expectation: ToolTraceExpectation,
): ToolTraceGrade {
  const ordered = validateTrace(trace)
  const retrievalTools = new Set<string>(SUBSTANTIVE_RETRIEVAL_TOOLS)
  const skillCalls = ordered.filter(event => event.tool_name === 'Skill')
  const firstRetrieval = ordered.find(event => retrievalTools.has(event.tool_name))
  const evidence: string[] = []

  if (expectation.required_skill) {
    const requiredCall = skillCalls.find(event => skillNameFromInput(event.input) === expectation.required_skill)
    if (!requiredCall) {
      return {
        passed: false,
        evidence: [`Skill(${expectation.required_skill}) was not called.`],
      }
    }
    evidence.push(`Skill(${expectation.required_skill}) called at sequence ${requiredCall.sequence}.`)
    if (
      expectation.must_precede_first_substantive_retrieval
      && firstRetrieval
      && requiredCall.sequence >= firstRetrieval.sequence
    ) {
      return {
        passed: false,
        evidence: [
          ...evidence,
          `${firstRetrieval.tool_name} occurred first at sequence ${firstRetrieval.sequence}.`,
        ],
      }
    }
    if (firstRetrieval) {
      evidence.push(`${firstRetrieval.tool_name} first retrieved literature at sequence ${firstRetrieval.sequence}.`)
    } else {
      evidence.push('No substantive literature retrieval tool was called.')
    }
  }

  if (expectation.forbid_skill) {
    const forbiddenCall = skillCalls.find(event => skillNameFromInput(event.input) === expectation.forbid_skill)
    if (forbiddenCall) {
      return {
        passed: false,
        evidence: [`Forbidden Skill(${expectation.forbid_skill}) call at sequence ${forbiddenCall.sequence}.`],
      }
    }
    evidence.push(`Skill(${expectation.forbid_skill}) was not called.`)
  }

  if (expectation.forbid_substantive_retrieval) {
    if (firstRetrieval) {
      return {
        passed: false,
        evidence: [`Forbidden ${firstRetrieval.tool_name} call at sequence ${firstRetrieval.sequence}.`],
      }
    }
    evidence.push('No substantive literature retrieval tool was called.')
  }

  return { passed: true, evidence }
}
