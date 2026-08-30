import { callAnthropicAPIStream } from '../agent/llm-api'
import { resolveAlias } from '../llm-registry'
import type { MemoryEvidenceRef, PreferenceCandidateInput, HistoryEventInput } from './types'
import type { AtomicPreference } from './types'
import type { MemoryCandidateDocument } from './models'
import { buildConsolidationPrompt, buildExtractionPrompt } from './prompts'

interface ExtractionResult {
  history_event: HistoryEventInput | null
  preference_candidates: PreferenceCandidateInput[]
}
export interface ConsolidationDecision {
  candidate_id: string
  action: 'add' | 'update' | 'ignore' | 'conflict'
  existing_preference_id?: string | null
  reason: string
  preference?: Pick<AtomicPreference, 'category' | 'subject' | 'statement' | 'scope' | 'polarity'> | null
}

function memoryModel(): { model: string; apiKey: string } {
  return resolveAlias('tool_memory_fast')
}

function responseText(content: Awaited<ReturnType<typeof callAnthropicAPIStream>>['content']): string {
  return content.filter(block => block.type === 'text').map(block => block.text).join('').trim()
}

function parseJson<T>(value: string): T {
  const cleaned = value.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  return JSON.parse(cleaned) as T
}

async function runFlash(prompt: string, maxTokens: number): Promise<string> {
  const { model, apiKey } = memoryModel()
  const result = await callAnthropicAPIStream({
    model,
    max_tokens: maxTokens,
    temperature: 0,
    system: [{ type: 'text', text: 'Return only strict JSON matching the requested schema.' }],
    tools: [],
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
  }, undefined, apiKey)
  return responseText(result.content)
}

function validExtraction(value: ExtractionResult, evidence: MemoryEvidenceRef[]): ExtractionResult {
  const ids = new Set(evidence.map(item => item.evidence_id))
  const userIds = new Set(evidence.filter(item => item.role === 'user').map(item => item.evidence_id))
  const candidates = Array.isArray(value.preference_candidates)
    ? value.preference_candidates.filter(item =>
      item && typeof item.statement === 'string' && item.statement.trim() &&
      Array.isArray(item.evidence_ids) && item.evidence_ids.every(id => ids.has(id)) &&
      item.evidence_ids.some(id => userIds.has(id))
    )
    : []
  const history = value.history_event && typeof value.history_event.title === 'string' && typeof value.history_event.summary === 'string'
    ? value.history_event
    : null
  return { history_event: history, preference_candidates: candidates }
}

export async function extractRunMemory(evidence: MemoryEvidenceRef[]): Promise<ExtractionResult> {
  if (!evidence.some(item => item.role === 'user')) return { history_event: null, preference_candidates: [] }
  return validExtraction(parseJson<ExtractionResult>(await runFlash(buildExtractionPrompt(evidence), 3_000)), evidence)
}

export async function consolidateCandidates(
  profile: AtomicPreference[],
  candidates: MemoryCandidateDocument[]
): Promise<ConsolidationDecision[]> {
  const parsed = parseJson<{ decisions?: ConsolidationDecision[] }>(
    await runFlash(buildConsolidationPrompt(profile, candidates), 4_000)
  )
  const candidateIds = new Set(candidates.map(item => item.candidate_id))
  const seen = new Set<string>()
  const decisions = (parsed.decisions ?? []).filter(item => {
    if (!candidateIds.has(item.candidate_id) || seen.has(item.candidate_id)) return false
    if (!['add', 'update', 'ignore', 'conflict'].includes(item.action)) return false
    seen.add(item.candidate_id)
    return true
  })
  for (const candidate of candidates) {
    if (!seen.has(candidate.candidate_id)) {
      decisions.push({ candidate_id: candidate.candidate_id, action: 'ignore', reason: '模型未返回有效决策' })
    }
  }
  return decisions
}
