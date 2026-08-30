import type { AtomicPreference, MemoryEvidenceRef } from './types'
import type { MemoryCandidateDocument } from './models'

export function buildExtractionPrompt(evidence: MemoryEvidenceRef[]): string {
  return `你是 Pegasus Spatial 的后台记忆摘要器。只分析本次 Agent Loop 新增的、已经过滤过的证据。\n\n` +
    `目标：提取一条可供未来查询的历史事件；仅在用户原话明确表达长期偏好时生成偏好候选。\n\n` +
    `硬性边界：\n` +
    `- 助手的建议、产物风格和历史查询结果都不是用户偏好。\n` +
    `- 不把当前项目的临时要求升级为长期偏好，除非用户明确表示“以后/一直/我偏好/我习惯/不要再”。\n` +
    `- 历史只陈述发生过什么，不把旧项目的配色、风格或决策写成未来约束。\n` +
    `- preference_candidates 每项必须引用至少一个 role=user 的 evidence_id。\n` +
    `- 没有有价值事件可把 history_event 设为 null；没有偏好则返回空数组。\n\n` +
    `只输出合法 JSON，不要 Markdown：\n` +
    `{"history_event":null|{"title":"","summary":"","detail":"","project":"","decisions":[],"artifacts":[],"tags":[],"search_terms":[]},` +
    `"preference_candidates":[{"category":"","subject":"","statement":"","scope":"general","polarity":"positive|negative|neutral","evidence_ids":[]}]}\n\n` +
    `证据：\n${JSON.stringify(evidence)}`
}
export function buildConsolidationPrompt(
  profile: AtomicPreference[],
  candidates: MemoryCandidateDocument[]
): string {
  const compactCandidates = candidates.map(item => ({
    candidate_id: item.candidate_id,
    category: item.category,
    subject: item.subject,
    statement: item.statement,
    scope: item.scope,
    polarity: item.polarity,
    evidence_refs: item.evidence_refs,
  }))
  return `你是 Pegasus Spatial 的长期用户画像沉淀器。对 10 条已验证候选进行保守归并。\n\n` +
    `规则：\n` +
    `- 用户画像是参考，不是任务规范；宁可 ignore，也不要把单项目临时要求永久化。\n` +
    `- category 必须兼容、scope 不矛盾、肯定与否定不能自动合并。\n` +
    `- 明显冲突必须 conflict，绝不自动覆盖旧偏好。\n` +
    `- update 必须给 existing_preference_id；add 不得复制已有偏好。\n` +
    `- 每个候选必须恰好出现一次。\n\n` +
    `只输出合法 JSON，不要 Markdown：\n` +
    `{"decisions":[{"candidate_id":"","action":"add|update|ignore|conflict","existing_preference_id":null,"reason":"","preference":null|{"category":"","subject":"","statement":"","scope":"","polarity":"positive|negative|neutral"}}]}\n\n` +
    `现有画像：${JSON.stringify(profile)}\n候选：${JSON.stringify(compactCandidates)}`
}
