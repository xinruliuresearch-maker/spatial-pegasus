export type MemoryRunStatus =
  | 'recording'
  | 'awaiting_user'
  | 'queued'
  | 'processing'
  | 'completed'
  | 'discarded'
  | 'failed'

export type CandidateStatus =
  | 'pending'
  | 'claimed'
  | 'promoted'
  | 'ignored'
  | 'conflict'
  | 'quota_blocked'
  | 'legacy_review'

export type PreferencePolarity = 'positive' | 'negative' | 'neutral'

export interface MemoryEvidenceRef {
  evidence_id: string
  role: 'user' | 'assistant' | 'tool' | 'workspace' | 'completion'
  excerpt: string
  message_index?: number
  tool_name?: string
  created_at: Date
}

export interface AtomicPreference {
  preference_id: string
  source_candidate_id?: string
  category: string
  subject: string
  statement: string
  scope: string
  polarity: PreferencePolarity
  status: 'active' | 'conflict'
  evidence_refs: MemoryEvidenceRef[]
  created_at: Date
  updated_at: Date
}

export interface HistoryArtifactRef {
  path?: string
  asset_id?: string
  url?: string
  mime_type?: string
  label?: string
}

export interface HistoryEventInput {
  title: string
  summary: string
  detail?: string
  project?: string
  decisions?: string[]
  artifacts?: HistoryArtifactRef[]
  tags?: string[]
  search_terms?: string[]
}

export interface PreferenceCandidateInput {
  category: string
  subject: string
  statement: string
  scope?: string
  polarity?: PreferencePolarity
  evidence_ids: string[]
}

export interface MemoryRuntimeContext {
  userId: string
  profileText: string
  profileVersion: number
  historyReminder: string
}

export interface FirstTurnHistorySnapshot {
  status: 'pending' | 'injected' | 'consumed' | 'disabled'
  reminder: string
  event_ids: string[]
  profile_version: number
  injected_at?: Date
  consumed_at?: Date
}

export interface ConversationMemoryContext {
  active_run_id?: string
  first_turn_history?: FirstTurnHistorySnapshot
}

export interface RecallHistoryArgs {
  query?: string
  refs?: string[]
  depth?: 'summary' | 'detail'
  limit?: number
}
