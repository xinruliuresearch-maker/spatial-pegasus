// ============================================================
// Global Types for Sci-Pegasus
// ============================================================

import type { FileEntry } from './workspace/types'

// --- LLM / Model Types ---

/** Model alias stored in settings (e.g. 'main_standard', 'main_pro'). Backend
 *  resolves to real model ID + API key via lib/llm-registry.ts. Historically this
 *  held raw OpenRouter IDs; legacy values are accepted on read and re-mapped. */
export type ModelProvider = string

// --- Anthropic Content Block Types (Claude API native format) ---

export type TextBlock = {
  type: 'text'
  text: string
  cache_control?: { type: 'ephemeral' }
}

export type ImageSource =
  | {
      /** Legacy compatibility only. New persisted messages must not use this source. */
      type: 'base64'
      media_type: string
      data: string
    }
  | {
      /** External provider-ready URL. */
      type: 'url'
      url: string
    }
  | {
      /** Sci-Pegasus-internal source, resolved to a public URL by the provider adapter. */
      type: 'asset'
      asset_id: string
      media_type: string
      /** Load-only compatibility for assets created by the old single-object writer. */
      storage_driver?: 'gridfs' | 'oss'
      width?: number
      height?: number
      size_bytes?: number
    }

export type ImageBlock = {
  type: 'image'
  source: ImageSource
}

export type ToolUseBlock = {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

/** tool_result content: string for text-only, or array for mixed content (text + images) */
export type ToolResultContent = string | (TextBlock | ImageBlock)[]

export type ToolResultBlock = {
  type: 'tool_result'
  tool_use_id: string
  content: ToolResultContent
  is_error?: boolean
  cache_control?: { type: 'ephemeral' }
}

export type ThinkingBlock = {
  type: 'thinking'
  thinking: string
  signature?: string
}

export type RedactedThinkingBlock = {
  type: 'redacted_thinking'
  data: string
}

export type ContentBlock = TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock | ThinkingBlock | RedactedThinkingBlock

// --- Message Types ---

export interface ConversationMessage {
  role: 'user' | 'assistant'
  content: ContentBlock[]
  timestamp?: Date
  /** Stable identifier used by AgentRun checkpoints. Optional for legacy messages. */
  message_id?: string
  /** Top-level AgentRun that produced this message. Optional for legacy messages. */
  run_id?: string
  /** Monotonic message sequence within one AgentRun. Optional for legacy messages. */
  sequence?: number
  /**
   * Durable source id for a mid-turn queue item. If a process stops after the
   * ConversationMessage is saved but before the queue claim is acknowledged,
   * recovery uses this id to acknowledge—not inject—the same input again.
   */
  source_queue_id?: string
  /**
   * Internal provenance for a durable context-replacement message. This is
   * written by the compaction runtime, never accepted from user input, and
   * lets token accounting distinguish a real replacement prefix from pasted
   * reminder text.
   */
  _context_replacement?: {
    kind: 'async_compaction'
    project_context_hash?: string
  }
  /** Set by agent loop when aborted — signals loadConversation to show interruption marker */
  _interrupted?: boolean
  /** Internal Agent/team input retained for Root context but hidden from the user timeline. */
  visibility?: 'public' | 'internal'
}

// --- Tool Types ---

export interface ToolSchema {
  name: string
  description: string
  input_schema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
    additionalProperties?: boolean
    anyOf?: Array<Record<string, unknown>>
  }
}

/** Persistable user-upload attachment. The binary lives outside the message document. */
export type ImageAttachment =
  | {
      assetId: string
      mimeType: string
      storageDriver?: 'gridfs' | 'oss'
      width?: number
      height?: number
    }
  | {
      /** Load-only compatibility for historical URL/base64 records in the UI. */
      url: string
      mimeType: string
      width?: number
      height?: number
    }

/** Transient image bytes returned by tools before they are stored as an asset. */
export interface InlineImageData {
  base64: string
  mimeType: string
}

export type RasterAssetVariant = 'original' | 'model' | 'thumbnail'

/** Stable runtime reference. No raster bytes are allowed in this object. */
export interface RasterAssetRef {
  assetId: string
  mimeType: string
  width: number
  height: number
  sizeBytes: number
  urls: Record<RasterAssetVariant, string>
}

export interface ToolResult {
  content: string
  is_error?: boolean
  /** Full file content after edit — used by Edit tool for workspace sync */
  updatedContent?: string
  /** URL-backed raster assets produced or read by this tool. */
  media?: RasterAssetRef[]
  /** Legacy transient tool contract. New tools must use `media`. */
  images?: InlineImageData[]
  /** Durable control boundary handled by Agent Loop after this result is checkpointed. */
  control?: 'wait_agents' | 'task_submitted'
  /** Execution telemetry emitted by tools without exposing bookkeeping to the model. */
  telemetry?: {
    /** Newly transferred source bytes. Cache and singleflight reuse report zero. */
    download_bytes?: number
  }
}

// --- Agent Types ---

export interface TokenUsage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

export interface ToolCallRecord {
  tool: string
  input: Record<string, unknown>
  result: ToolResult
}

export interface AgentLoopResult {
  messages: ConversationMessage[]
  text: string
  toolCalls: ToolCallRecord[]
  usage: TokenUsage
  truncated?: boolean
  waitingForUser?: boolean
  waitingForAgents?: boolean
  taskSubmitted?: boolean
  /** True if the agent loop was aborted (user interrupted or disconnected) */
  aborted?: boolean
  /** True if compaction occurred during this agent loop run */
  compacted?: boolean
  /** The compaction summary text (if compacted) */
  compactionSummary?: string
  /** Number of turns (LLM calls) used in this agent loop run */
  turnsUsed: number
}

// --- LLM Response (agent loop internal) ---

export interface LLMResponse {
  content: ContentBlock[]
  stop_reason: string
  usage: TokenUsage
}

export interface AskUserQuestionOption {
  label: string
  description?: string
}

export interface AskUserQuestionItem {
  id: string
  header: string
  question: string
  options: AskUserQuestionOption[]
  multi_select: boolean
  required: boolean
  allow_custom: boolean
}

export interface AskUserInteraction {
  interaction_id: string
  questions: AskUserQuestionItem[]
}

// --- Display Types (frontend rendering) ---

export type DisplayPart =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; tool: string; tool_use_id?: string; file_path?: string; action?: string; is_error?: boolean; pending?: boolean; content?: string; target_path?: string }
  | { type: 'thinking'; text: string; pending?: boolean }
  | { type: 'redacted_thinking'; pending?: boolean }
  | {
      type: 'ask_user'
      interaction_id?: string
      questions?: AskUserQuestionItem[]
      /** Legacy single-question payload kept for historical rendering. */
      question?: string
      options?: string[]
      answered?: boolean
    }
  | { type: 'image'; url?: string; base64?: string; mimeType: string }
  | { type: 'interrupted' }

export interface DisplayMessage {
  id: string
  type: 'user' | 'assistant'
  parts: DisplayPart[]
  content: string
  timestamp: Date
}

// --- Tool Call Summary (SSE done event) ---

export interface ToolCallSummary {
  tool: string
  file_path?: string
  action: string
  is_error: boolean
}

// --- Workspace Types ---

export type ResolverType = 'field' | 'static' | 'generated'

export interface FileDeclaration {
  path: string
  description: string
  resolver: ResolverRef
  readOnly?: boolean
}

export interface ResolverRef {
  type: ResolverType
  /** For field resolver: dot-notation path in the conversation document */
  field?: string
  /** For static resolver: the fixed content */
  content?: string
}

export interface WorkspaceDefinition {
  name: string
  description: string
  policy: WorkspacePolicy
  /** Legacy definitions may still provide this during the migration window. */
  files?: FileDeclaration[]
}

export interface WorkspacePolicy {
  /** Top-level namespaces in which Agent tools may create files. */
  allowedRoots: string[]
  /** Agent-visible but user-hidden namespace. */
  internalRoot: string
  /** Suggested or reserved paths. Declarations never imply file existence. */
  reservedPaths: FileDeclaration[]
  /** Root-level files that remain writable outside the namespace list. */
  allowedRootFiles?: string[]
  maxFiles?: number
  maxDepth?: number
  maxPathLength?: number
  maxSegmentLength?: number
}

// --- Conversation / DB Types ---

export type ProjectGuideParameter = string | number | boolean

/**
 * Immutable reference to the task-specific Project Guide selected for a
 * Conversation. The registry owns compilation; persistence stores only the
 * stable template identity and caller-provided scalar parameters.
 */
export interface ProjectGuideRef {
  template_id: string
  version: number
  parameters?: Record<string, ProjectGuideParameter>
}

export interface ConversationDoc {
  conversation_id: string
  user_id: string
  title: string
  settings: ConversationSettings
  /** Task-specific project instructions. Absent on legacy Conversations. */
  project_guide?: ProjectGuideRef
  user_input: string
  /** Structured research state owned by the discovery workflow. */
  analysis?: Record<string, unknown>
  output: {
    // Text/documents stay in GridFS; raster files remain opaque media assets.
    files?: Record<string, FileEntry>
    // Workspace manifest — version tracking
    manifest?: Record<string, { current_version: number; versions: { v: number; path: string; note: string; created_at: string }[] }>
  }
  messages: ConversationMessage[]
  /** Compacted messages — when non-empty, used instead of messages for LLM calls */
  compacted_messages?: ConversationMessage[]
  /** Number of times compaction has been performed */
  compaction_count?: number
  /**
   * Revision of the model-visible active context only. Unlike updated_at it is
   * not changed by title/workspace metadata writes, so durable compaction can
   * CAS a frozen prefix while allowing an append-only tail.
   */
  context_revision?: number
  /** Last durable CompactionJob atomically applied to compacted_messages. */
  last_applied_compaction_id?: string | null
  /** Short-lived worker fence; never tied to an AgentRun lease. */
  context_compaction_fence?: import('./agent-compaction/types').ContextCompactionFence | null
  /** Last successful request that may have created/read the active prompt prefix cache. */
  prompt_cache_last_activity_at?: Date | null
  /** Bounded rolling observations used to derive Hippocampus F/B. */
  hippocampus_telemetry?: {
    mainTps: number[]
    mainOutputs: number[]
    inputGrowth: number[]
    compactionDurations: number[]
    compactionTps: number[]
    previousInputTokens: number | null
    previousLocalInputTokens?: number | null
  }
  /** Account memory V2 state for a conversation. Stored outside message history. */
  memory_context?: import('./memory-v2/types').ConversationMemoryContext
  /** Fallback flag: true when last run was aborted — used when checkpoint-1 abort has no new messages to mark */
  _last_interrupted?: boolean
  /** True when the agent loop exited via AskUserQuestion and is awaiting user response */
  _waiting_for_user?: boolean
  /** Pinned conversations float to the top of the sidebar list. */
  pinned?: boolean
  created_at: Date
  updated_at: Date
}

export interface ConversationSettings {
  orchestrator_model: ModelProvider
  research_domain?: string
  memory_enabled?: boolean
}

// --- Skill Types ---

export interface SkillMetadata {
  name: string
  description: string
}

export interface SkillDefinition extends SkillMetadata {
  /** Full body content of SKILL.md (without frontmatter) */
  body: string
  /** Absolute path to the skill directory */
  dirPath: string
}
