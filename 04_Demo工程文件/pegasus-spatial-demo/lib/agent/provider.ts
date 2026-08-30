// Workspace Provider — bridges Agent Loop with LLM API + Workspace Instance

import type { AgentProvider } from './loop'
import type { ConversationMessage, ContentBlock, ToolResult, ToolCallSummary, LLMResponse, SkillDefinition, ImageSource } from '../types'
import { WorkspaceInstance } from '../workspace/types'
import { getToolSchemasForCapabilities } from '../tools/schemas'
import {
  buildSystemPromptBlocks,
  type SystemPromptAgentContext,
} from './system-prompt'
import { buildSkillReminder } from './system-reminder'
import {
  buildProjectContextReminder,
  planFirstMessageReminders,
  projectContextReminderMatchesHash,
  type FrozenProjectContext,
} from './project-context'
import type { MemoryRuntimeContext } from '../memory-v2/types'
import { memoryV2Flags } from '../memory-v2/flags'
import { callAnthropicAPIStream, StreamResult } from './llm-api'
import { buildMediaPublicUrl } from '../media/public-url'
import type { AgentExecutionContext, ToolExecutionInvocation } from './execution-context'
import { canExecuteTool } from './execution-context'
import { canAgentWriteWorkspacePath } from '../workspace/agent-scope'
import {
  executeAgentTeamTool,
  isAgentTeamTool,
} from '../agent-team/tool-adapter'

function toProviderImageSource(source: ImageSource) {
  if (source.type === 'asset') {
    return {
      type: 'url' as const,
      url: buildMediaPublicUrl(source.asset_id, source.storage_driver),
    }
  }
  return source
}

/** Convert raw stream result to internal LLMResponse format */
function convertStreamResult(response: StreamResult): LLMResponse {
  const content: ContentBlock[] = []
  for (const block of response.content || []) {
    if (block.type === 'text') {
      content.push({ type: 'text', text: block.text })
    } else if (block.type === 'tool_use') {
      content.push({
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.input as Record<string, unknown>,
      })
    } else if (block.type === 'thinking') {
      content.push({ type: 'thinking', thinking: block.thinking, signature: block.signature || '' })
    } else if (block.type === 'redacted_thinking') {
      if (block.data && !(typeof block.data === 'string' && block.data.startsWith('openrouter.reasoning:'))) {
        content.push({ type: 'redacted_thinking', data: block.data })
      }
    }
  }
  return {
    content,
    stop_reason: response.stop_reason || 'end_turn',
    usage: response.usage,
  }
}

// Tool implementations
import { executRead } from '../tools/read'
import { executeWrite } from '../tools/write'
import { executeEdit } from '../tools/edit'
import { executeGlob } from '../tools/glob'
import { executeGrep } from '../tools/grep'
import { executeSkill } from '../tools/skill'
import { executeWebSearch } from '../tools/web-search'
import { executeRecallHistory } from '../tools/recall-history'
import {
  executeArxivSearchPapers,
  type ArxivSearchPapersInput,
} from '../tools/arxiv-search-papers'
import {
  executeArxivFetchPaper,
  type ArxivFetchPaperInput,
} from '../tools/arxiv-fetch-paper'
import {
  executeSciverseSearchPapers,
  type SciverseSearchPapersInput,
} from '../tools/sciverse-search-papers'
import {
  executeSciverseSearchEvidence,
  type SciverseSearchEvidenceInput,
} from '../tools/sciverse-search-evidence'
import {
  executeSciverseFetchPaper,
  type SciverseFetchPaperInput,
} from '../tools/sciverse-fetch-paper'
import {
  executeSciverseListRelations,
  type SciverseListRelationsInput,
} from '../tools/sciverse-list-relations'
import {
  executeSearchDocument,
  type SearchDocumentInput,
} from '../tools/search-document'
import { executeGenerateImage } from '../tools/generate-image'
import {
  executeSpatialTool,
  type SpatialToolName,
} from '../tools/spatial'
import { executeSpatialSceneTool, type SpatialSceneToolName } from '../tools/spatial-scene'

// ==================== Provider Factory ====================

interface ProviderConfig {
  model: string
  maxTokens: number
  temperature: number
  baseUrl?: string
  apiKey?: string
  thinkingEnabled?: boolean
  thinkingBudgetTokens?: number
  conversationId?: string
  abortSignal?: AbortSignal
  /** Whether the underlying model can read multimodal image content. Models
   *  must declare this explicitly. When `false`, image blocks inside tool_result.content arrays
   *  are stripped (replaced with text placeholder) before sending — required
   *  for text-only models like GLM 5.1 / DeepSeek V4 which silently fail when
   *  fed image content (output token count drops to 0). */
  supportsVision?: boolean
  executionContext?: AgentExecutionContext
  /** Privileged public Workspace used only by explicitly delegated publication tools. */
  publicationWorkspace?: WorkspaceInstance
}

interface ProviderCallbacks {
  onTextChunk?: (chunk: string) => void
  onToolUseStart?: (toolName: string) => void
  onToolStart?: (tool: string, input: Record<string, unknown>) => void
  onToolExecuted?: (tool: string, input: Record<string, unknown>, result: ToolResult) => void
  onThinkingDelta?: (chunk: string) => void
  onRedactedThinking?: () => void
}

export function createAgentProvider(
  workspace: WorkspaceInstance,
  skills: Map<string, SkillDefinition>,
  config: ProviderConfig,
  callbacks?: ProviderCallbacks,
  memoryContext?: MemoryRuntimeContext,
  projectContext?: FrozenProjectContext,
): AgentProvider {
  let activeProjectContext = projectContext
  const skillMetadata = Array.from(skills.values()).map(s => ({
    name: s.name,
    description: s.description,
  }))

  const visibleToolSchemas = getToolSchemasForCapabilities({
    supportsVision: config.supportsVision === true,
    includeRecallHistory: memoryV2Flags.recallTool() && !!memoryContext?.userId,
    allowedTools: config.executionContext?.allowedTools,
    allowAskUser: config.executionContext?.isRoot !== false,
    isRoot: config.executionContext?.isRoot !== false,
    projectTemplateId: activeProjectContext?.guide.template_id,
  })
  const tools = visibleToolSchemas.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }))

  return {
    toolSchemas: visibleToolSchemas,
    buildRequest(messages: ConversationMessage[]) {
      // This exact builder is also used by estimateOverheadTokens. Keeping the
      // optional Agent Team/profile blocks centralized prevents admission from
      // reserving a different prefix than the one sent to the model.
      const system = buildSystemPromptBlocks({
        profileText: memoryContext?.profileText,
        executionContext: config.executionContext,
      })

      // Convert messages — strip all historical cache_control, only add breakpoint on last message's last block
      const rawMessages = messages.map(msg => ({
        role: msg.role,
        content: msg.content.map(block => {
          if (block.type === 'text') {
            return { type: 'text', text: block.text }
          }
          if (block.type === 'image') {
            // Text-only models can't read images. Replace with a Chinese
            // system-reminder explaining the limitation so the model can
            // still respond based on surrounding text.
            if (config.supportsVision === false) {
              return {
                type: 'text',
                text: '<system-reminder>用户上传了一张图片，但你不是多模态模型，无法直接理解图片信息。不要直接去read，使用相应的工具继续做。</system-reminder>',
              }
            }
            return { type: 'image', source: toProviderImageSource(block.source) }
          }
          if (block.type === 'tool_use') {
            return { type: 'tool_use', id: block.id, name: block.name, input: block.input }
          }
          if (block.type === 'thinking') {
            // Skip empty signature (OpenRouter may not forward signature_delta)
            if (!block.signature) return null
            return { type: 'thinking', thinking: block.thinking, signature: block.signature }
          }
          if (block.type === 'redacted_thinking') {
            // Skip empty data and OpenRouter-injected redacted_thinking
            if (!block.data || (typeof block.data === 'string' && block.data.startsWith('openrouter.reasoning:'))) return null
            return { type: 'redacted_thinking', data: block.data }
          }
          // tool_result — content can be string or array (with image blocks).
          // For text-only models strip image payloads they cannot understand,
          // while preserving the tool's textual result and a clear limitation.
          let trContent: typeof block.content = block.content
          if (config.supportsVision === false && Array.isArray(block.content)) {
            const cleaned: typeof block.content = []
            let imageCount = 0
            for (const piece of block.content) {
              if ((piece as { type?: string }).type === 'image') {
                imageCount += 1
                continue
              }
              cleaned.push(piece)
            }
            if (imageCount > 0) {
              // Defensive: if the tool returned ONLY images (no text), keep
              // a minimal marker so cleaned isn't empty.
              if (cleaned.length === 0) {
                cleaned.push({ type: 'text', text: '[工具结果包含图片]' })
              }
              cleaned.push({
                type: 'text',
                text: '<system-reminder>当前模型不具备图片理解能力，因此工具结果中的图片未注入上下文。请依据保留的文字信息继续，或请用户切换到支持视觉的模型。</system-reminder>',
              })
            }
            trContent = cleaned
          }
          if (Array.isArray(trContent)) {
            trContent = trContent.map(piece => piece.type === 'image'
              ? { ...piece, source: toProviderImageSource(piece.source) }
              : piece)
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const tr: any = { type: 'tool_result', tool_use_id: block.tool_use_id, content: trContent }
          if (block.is_error) tr.is_error = true
          return tr
        }).filter(Boolean),
      }))

      // Merge consecutive same-role messages (safety net for Anthropic API's alternating role rule).
      // Normally shouldn't be needed — AskUserQuestion is stripped from messages in the loop —
      // but kept as a defensive guard against edge cases.
      const apiMessages: typeof rawMessages = []
      for (const msg of rawMessages) {
        const prev = apiMessages[apiMessages.length - 1]
        if (prev && prev.role === msg.role) {
          // Merge content blocks into the previous message
          prev.content.push(...msg.content)
        } else {
          apiMessages.push(msg)
        }
      }

      // Inject history + project context + skill reminders into messages[0] (the conversation's first
      // user message) ONCE. After injection the reminder stays in the message for
      // the lifetime of the agent loop and rides for free via prompt caching on
      // subsequent turns. Re-injecting every turn would (a) waste tokens equal to
      // reminder_size × turns, (b) defeat prompt caching by shifting cache breakpoints,
      // and (c) collide with DeepSeek's strict "tool_result must be the first block
      // of the user message" validation when the loop's last user message is a
      // tool_result container.
      //
      // Existing reminders are trusted only when a standalone first-message
      // block exactly equals the canonical reminder compiled for this request.
      // Marker-like phrases inside ordinary user text never suppress formal
      // history, Project Context, or Skills reminders.
      const reminderText = buildSkillReminder(skillMetadata)
      // History is one-shot across the first durable compaction boundary.
      // Trust only the internal replacement provenance; ordinary user text
      // mentioning compaction must not suppress the canonical history block.
      const compactedContext = messages[0]?._context_replacement?.kind === 'async_compaction'
      const historyText = compactedContext ? '' : (memoryContext?.historyReminder ?? '')
      const projectText = buildProjectContextReminder(activeProjectContext)
      const persistedFirstBlock = messages[0]?.content[0]
      const trustedCompactedProjectText = compactedContext
        && persistedFirstBlock?.type === 'text'
        && projectContextReminderMatchesHash(
          persistedFirstBlock.text,
          messages[0]?._context_replacement?.project_context_hash,
        )
        ? persistedFirstBlock.text
        : undefined
      if ((historyText || projectText || reminderText) && apiMessages.length > 0 && apiMessages[0].role === 'user') {
        const first = apiMessages[0]
        const firstBlock = first.content[0]
        // Defensive: messages[0] should never start with tool_result, but skip if it does
        if (firstBlock?.type !== 'tool_result') {
          const textOf = (block: unknown): string => {
            if (!block || typeof block !== 'object') return ''
            const candidate = block as { type?: string; text?: unknown }
            return candidate.type === 'text' && typeof candidate.text === 'string' ? candidate.text : ''
          }
          const textBlockIndexes: number[] = []
          const firstTexts: string[] = []
          first.content.forEach((block, index) => {
            const text = textOf(block)
            if (!text) return
            textBlockIndexes.push(index)
            firstTexts.push(text)
          })
          const plan = planFirstMessageReminders({
            firstTexts,
            historyText,
            projectText,
            skillText: reminderText,
            compactedContext,
            trustedCompactedProjectText,
          })
          const removeContentIndexes = new Set(
            plan.removeFirstTextIndexes.map(index => textBlockIndexes[index]),
          )
          const remaining = first.content.filter((_, index) => !removeContentIndexes.has(index))

          // Each reminder has an independent lifecycle. Canonical order keeps
          // skills last (closest to the actual user input), while a project
          // marker embedded in a compacted replacement suppresses only project
          // reinjection and never suppresses the skill catalog.
          const ordered = plan.ordered.map(text => ({ type: 'text' as const, text }))
          first.content = [...ordered, ...remaining]
        }
      }

      // Add cache_control to last block of last message
      if (apiMessages.length > 0) {
        const lastMsg = apiMessages[apiMessages.length - 1]
        if (lastMsg.content.length > 0) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (lastMsg.content[lastMsg.content.length - 1] as any).cache_control = { type: 'ephemeral' }
        }
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const req: any = {
        model: config.model,
        max_tokens: config.maxTokens,
        temperature: config.temperature,
        system,
        tools,
        messages: apiMessages,
      }

      if (config.thinkingEnabled && config.thinkingBudgetTokens) {
        req.thinking = { type: 'enabled', budget_tokens: config.thinkingBudgetTokens }
        delete req.temperature // Anthropic API requires no temperature when thinking is enabled
      }

      return req
    },

    setProjectContext(context) {
      activeProjectContext = context
    },

    buildCompactionRequest(messages, instruction, maxTokens) {
      // Build the shared prefix through exactly the same conversion path as a
      // main request. buildRequest places the cache breakpoint on the final
      // shared block; the one-shot compaction instruction is appended AFTER
      // that breakpoint and deliberately receives no cache_control.
      const request = this.buildRequest(messages)
      const last = request.messages[request.messages.length - 1]
      const instructionBlock = { type: 'text', text: instruction }
      if (last?.role === 'user') {
        last.content.push(instructionBlock)
      } else {
        request.messages.push({ role: 'user', content: [instructionBlock] })
      }
      request.max_tokens = maxTokens
      // Compaction is a summary-only fork. It must not be able to emit a tool
      // call, even though the main request exposes the current Agent's tools.
      request.tools = []
      return request
    },

    async callLLM(request): Promise<LLMResponse> {
      const response = await callAnthropicAPIStream(
        request,
        config.baseUrl,
        config.apiKey,
        callbacks?.onTextChunk,
        callbacks?.onToolUseStart,
        callbacks?.onThinkingDelta,
        callbacks?.onRedactedThinking,
        config.abortSignal,
      )
      return convertStreamResult(response)
    },

    async callLLMSilent(request, abortSignal): Promise<LLMResponse> {
      // Silent mode — no callbacks, no SSE events to frontend
      const response = await callAnthropicAPIStream(
        request,
        config.baseUrl,
        config.apiKey,
        undefined, // onTextDelta
        undefined, // onToolUseStart
        undefined, // onThinkingDelta
        undefined, // onRedactedThinking
        abortSignal ?? config.abortSignal,
      )
      return convertStreamResult(response)
    },

    async executeTool(name, input, invocation?: ToolExecutionInvocation) {
      // Check abort before starting tool execution
      if (config.abortSignal?.aborted) {
        return { content: 'Tool execution interrupted by user.', is_error: true }
      }
      if (!canExecuteTool(config.executionContext, name)) {
        return { content: `Tool is not granted to this Agent: ${name}`, is_error: true }
      }
      if (isAgentTeamTool(name)) {
        return executeAgentTeamTool(name, input, config.executionContext, invocation)
      }
      switch (name) {
        case 'Read':
          return executRead(
            input as { file_path: string; offset?: number; limit?: number },
            workspace,
            skills
          )
        case 'Write':
          if (config.executionContext && !canAgentWriteWorkspacePath(
            String(input.file_path ?? ''),
            {
              agentId: config.executionContext.agentId ?? '',
              isRoot: config.executionContext.isRoot,
            },
          )) {
            return {
              content: 'Member Agents may only use Write inside their own private scratch directory. Files changed there are automatically proposed at turn end; Root publishes approved changes through ReviewWorkspaceChanges.',
              is_error: true,
            }
          }
          return executeWrite(
            input as { file_path: string; content: string },
            workspace
          )
        case 'Edit':
          if (config.executionContext && !canAgentWriteWorkspacePath(
            String(input.file_path ?? ''),
            {
              agentId: config.executionContext.agentId ?? '',
              isRoot: config.executionContext.isRoot,
            },
          )) {
            return {
              content: 'Member Agents may only use Edit inside their own private scratch directory. Files changed there are automatically proposed at turn end; Root publishes approved changes through ReviewWorkspaceChanges.',
              is_error: true,
            }
          }
          return executeEdit(
            input as { file_path: string; old_string: string; new_string: string; replace_all?: boolean },
            workspace
          )
        case 'Glob':
          return executeGlob(
            input as {
              pattern: string
              root?: 'output' | 'analysis' | 'notes' | 'references' | '.sci-pegasus'
              kind?: 'text' | 'raster' | 'document' | 'all'
              max_results?: number
            },
            workspace
          )
        case 'Grep':
          return executeGrep(
            input as {
              pattern: string
              path?: string
              literal?: boolean
              case_sensitive?: boolean
              context_lines?: number
              max_results?: number
            },
            workspace
          )
        case 'Skill':
          return executeSkill(
            input as { name: string; args?: string },
            skills
          )
        case 'WebSearch':
          return executeWebSearch(input as { query: string })
        case 'ArxivSearchPapers':
          return executeArxivSearchPapers(input as unknown as ArxivSearchPapersInput, {
            workspace,
            signal: config.abortSignal,
          })
        case 'ArxivFetchPaper':
          return executeArxivFetchPaper(input as unknown as ArxivFetchPaperInput, {
            workspace,
            signal: config.abortSignal,
          })
        case 'SciverseSearchPapers':
          return executeSciverseSearchPapers(input as unknown as SciverseSearchPapersInput, {
            workspace,
            signal: config.abortSignal,
          })
        case 'SciverseSearchEvidence':
          return executeSciverseSearchEvidence(input as unknown as SciverseSearchEvidenceInput, {
            workspace,
            signal: config.abortSignal,
          })
        case 'SciverseFetchPaper':
          return executeSciverseFetchPaper(input as unknown as SciverseFetchPaperInput, {
            workspace,
            signal: config.abortSignal,
          })
        case 'SciverseListRelations':
          return executeSciverseListRelations(input as unknown as SciverseListRelationsInput, {
            workspace,
            signal: config.abortSignal,
          })
        case 'SearchDocument':
          return executeSearchDocument(input as unknown as SearchDocumentInput, {
            workspace,
            signal: config.abortSignal,
          })
        case 'GenerateImage':
          return executeGenerateImage(input, workspace, {
            executionContext: config.executionContext!,
            invocation: invocation!,
            signal: config.abortSignal,
            publicationWorkspace: config.publicationWorkspace,
          })
        case 'CreateObject3D':
        case 'CreateWorld3D':
        case 'GetSpatialJob':
        case 'WaitSpatialJob':
        case 'InspectSpatialArtifact':
          return executeSpatialTool(name as SpatialToolName, input, workspace, {
            executionContext: config.executionContext,
            invocation,
            signal: config.abortSignal,
          })
        case 'CreateSpatialScene':
        case 'SetSceneEnvironment':
        case 'SetSceneWorld':
        case 'AddSceneTerrain':
        case 'AddSceneObject':
        case 'TransformSceneObject':
        case 'RemoveSceneObject':
        case 'ApplySceneSpec':
        case 'InspectSpatialScene':
        case 'RestoreSpatialScene':
        case 'SetSceneViewpoint':
        case 'FocusSceneObject':
        case 'CaptureSceneView':
        case 'QuerySceneSurface':
          return executeSpatialSceneTool(name as SpatialSceneToolName, input, {
            executionContext: config.executionContext,
            invocation,
            signal: config.abortSignal,
            workspace,
          })
        case 'RecallHistory':
          if (!memoryContext?.userId || !memoryV2Flags.recallTool()) {
            return { content: 'RecallHistory is not enabled.', is_error: true }
          }
          return executeRecallHistory(input as import('../memory-v2/types').RecallHistoryArgs, memoryContext.userId)
        case 'AskUserQuestion':
          return {
            content: 'AskUserQuestion is an interaction control signal and cannot execute as a normal tool.',
            is_error: true,
          }
        default:
          return { content: `Unknown tool: ${name}`, is_error: true }
      }
    },

    onTextChunk: callbacks?.onTextChunk,
    onToolStart: callbacks?.onToolStart,
    onToolExecuted: callbacks?.onToolExecuted,
  }
}

// ==================== Overhead Estimation ====================

/**
 * Estimate request-only token overhead: system prompt, tool schemas, skill
 * index, and selected memories. None of these blocks live in persisted message
 * history, so the compactor cannot reduce them and admission must reserve their
 * real size separately.
 * Uses ~3.5 chars/token for mixed CJK+English content.
 *
 * Baseline (post-2026-05 rewrite):
 *   - Identity + Capability Boundary: ~450 tokens (Block 1,极稳定缓存)
 *   - Behavior + AskUserQuestion guide + Variations culture: ~4000 tokens (Block 2, 稳定缓存)
 *   - Tool schemas: ~2000 tokens
 *   - Total fixed overhead: ~6450 tokens (was ~3850 before rewrite)
 *
 * Cold-start cost increase is ~2600 input tokens (one-time per conversation,
 * ~$0.04 at Opus pricing). All subsequent turns within a conversation hit the
 * ephemeral cache and pay no incremental cost.
 */
export function estimateOverheadTokens(
  tools: { name: string; description: string; input_schema: Record<string, unknown> }[],
  skillMetadata: { name: string; description: string }[] = [],
  memoryContext?: Pick<MemoryRuntimeContext, 'profileText' | 'historyReminder'>,
  projectContext?: FrozenProjectContext,
  executionContext?: SystemPromptAgentContext,
): number {
  const CHARS_PER_TOKEN = 3.5

  // Exact system blocks used by buildRequest, including Agent identity,
  // project-level instructions and the optional account profile.
  const systemChars = buildSystemPromptBlocks({
    profileText: memoryContext?.profileText,
    executionContext,
  }).reduce((sum, block) => sum + block.text.length, 0)

  // Tool schemas
  const toolChars = JSON.stringify(tools).length

  // Transient request reminders. They are injected by buildRequest but never
  // persisted in ConversationMessage[], so they must be counted here.
  const reminderChars = buildSkillReminder(skillMetadata).length
    + (memoryContext?.historyReminder?.length ?? 0)

  const totalChars = systemChars + toolChars + reminderChars
  return Math.round(totalChars / CHARS_PER_TOKEN)
    + estimateProjectContextOverheadTokens(projectContext)
}

/**
 * Project Context normally lives in the transient first-message reminder, but
 * after a compaction swap the same reminder is materialized in the replacement
 * message. Keep its contribution separate so local admission can count it in
 * exactly one of those two locations.
 */
export function estimateProjectContextOverheadTokens(
  projectContext?: FrozenProjectContext,
): number {
  return Math.round(buildProjectContextReminder(projectContext).length / 3.5)
}

// ==================== Tool Call Summary ====================

export function summarizeToolCall(
  toolName: string,
  input: Record<string, unknown>,
  isError: boolean
): ToolCallSummary {
  const filePath = input.file_path as string | undefined
  const displayPath = filePath?.replace(/^\/workspace\//, '') || ''

  let action: string
  switch (toolName) {
    case 'Read': action = `读取了 ${displayPath}`; break
    case 'Edit': action = `修改了 ${displayPath}`; break
    case 'Write': action = `写入了 ${displayPath}`; break
    case 'Glob': action = `搜索了文件模式 ${input.pattern}`; break
    case 'Grep': action = `搜索了内容 ${input.pattern}`; break
    case 'Skill': action = `加载了 Skill: ${input.name}`; break
    case 'WebSearch': action = `搜索了 "${input.query}"`; break
    case 'ArxivSearchPapers': action = `在 arXiv 检索了论文「${input.query}」`; break
    case 'ArxivFetchPaper': action = `获取并解析了 arXiv 论文 ${input.arxiv_id}`; break
    case 'SciverseSearchPapers': action = `在 Sciverse 检索了论文「${input.query ?? '结构化条件'}」`; break
    case 'SciverseSearchEvidence': action = `在 Sciverse 检索了证据「${input.query}」`; break
    case 'SciverseFetchPaper': action = `获取了 Sciverse 全文 ${input.doc_id}`; break
    case 'SciverseListRelations': action = `查询了 Sciverse 论文关系 ${input.unique_id} (${input.relation})`; break
    case 'SearchDocument': action = `在文献正文中定位了「${input.query}」`; break
    case 'GenerateImage': action = `生成了空间参考图 ${input.output_path ?? ''}`.trim(); break
    case 'CreateObject3D': action = `提交了 3D 物体任务 ${input.output_path_prefix ?? ''}`.trim(); break
    case 'CreateWorld3D': action = `提交了空间世界任务 ${input.output_path_prefix ?? ''}`.trim(); break
    case 'GetSpatialJob': action = `查看了空间任务 ${input.job_id ?? ''}`.trim(); break
    case 'WaitSpatialJob': action = `等待了空间任务 ${input.job_id ?? ''}`.trim(); break
    case 'InspectSpatialArtifact': action = `检查了空间资产 ${input.artifact_id ?? ''}`.trim(); break
    case 'CreateSpatialScene': action = `创建了 Scene「${input.title ?? ''}」`; break
    case 'SetSceneEnvironment': action = `设置了 Scene ${input.scene_id ?? ''} 的全景环境`.trim(); break
    case 'SetSceneWorld': action = `更新了 Scene ${input.scene_id ?? ''} 的整体 World`.trim(); break
    case 'AddSceneTerrain': action = `向 Scene ${input.scene_id ?? ''} 添加了 Lux 地形`.trim(); break
    case 'AddSceneObject': action = `向 Scene ${input.scene_id ?? ''} 添加了物体`.trim(); break
    case 'TransformSceneObject': action = `调整了物体 ${input.instance_id ?? ''} 的绝对变换`.trim(); break
    case 'RemoveSceneObject': action = `从 Scene 移除了物体 ${input.instance_id ?? ''}`.trim(); break
    case 'ApplySceneSpec': action = `应用了 Scene ${input.scene_id ?? ''} 的声明式场景文件 ${input.spec_path ?? ''}`.trim(); break
    case 'InspectSpatialScene': action = `检查了 Scene ${input.scene_id ?? ''}`.trim(); break
    case 'RestoreSpatialScene': action = `将 Scene 恢复为基于 v${input.revision_version ?? ''} 的新版本`.trim(); break
    case 'SetSceneViewpoint': action = `设置了 Scene ${input.scene_id ?? ''} 的 Agent 相机`.trim(); break
    case 'FocusSceneObject': action = `将 Agent 相机聚焦到 ${input.instance_id ?? ''}`.trim(); break
    case 'CaptureSceneView': action = `从 Scene ${input.scene_id ?? ''} 捕获了真实渲染画面`.trim(); break
    case 'QuerySceneSurface': action = `查询了 Scene ${input.scene_id ?? ''} 的真实地形表面`.trim(); break
    case 'Agent': action = `创建了 Agent ${input.name ?? input.description ?? ''}`.trim(); break
    case 'SendMessage': action = `向 ${input.to ?? 'Agent'} 发送了消息`; break
    case 'TaskCreate': action = `创建了任务「${input.subject ?? '未命名任务'}」`; break
    case 'TaskUpdate': action = `更新了任务 ${input.task_id ?? ''}`.trim(); break
    case 'TaskList': action = '查看了团队任务'; break
    case 'TaskGet': action = `查看了任务 ${input.task_id ?? ''}`.trim(); break
    case 'ReviewWorkspaceChanges': action = '审阅了 Agent 的 Workspace 变更'; break
    case 'ManageAgent': action = `${input.action ?? '管理'} Agent ${input.name ?? input.agent ?? input.agent_id ?? ''}`.trim(); break
    case 'AskUserQuestion': action = '向用户提问'; break
    default: action = `调用了 ${toolName}`
  }

  return { tool: toolName, file_path: filePath, action, is_error: isError }
}
