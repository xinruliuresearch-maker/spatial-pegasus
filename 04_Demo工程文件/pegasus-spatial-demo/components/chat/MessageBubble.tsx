'use client'

import { useState, useEffect, useRef, Fragment, ReactNode } from 'react'
import ReactMarkdown, { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ChatMessage } from '@/hooks/useChat'
import { AskUserQuestionItem, DisplayPart } from '@/lib/types'
import { buildBrowserMediaUrl } from '@/lib/media/browser-url'
import { ProgressiveImage } from '@/components/media/ProgressiveImage'
import { isSpatialTool, SpatialJobCard } from './SpatialJobCard'

// ============================================================
// Sci-Pegasus · Editorial Timeline MessageBubble
// ------------------------------------------------------------
// Three rendering paths (decided by message.role + parts shape):
//
//   1. UserMessage      — role === 'user'            → plain, no container
//   2. ProcessBubble    — role === 'assistant' AND at least one tool_call
//                          → .pmo-bubble wraps narration + tool call rows
//   3. FinalResponse    — role === 'assistant' AND no tool_call
//                          → plain, mirrors user structure (fresh meta + body)
//
// The data contract (DisplayPart / ChatMessage) is unchanged.
// ============================================================

// ============================================================
// Tool verb mapping — present/past pairs shown via opacity swap
// Exported so tests / debug panels can reuse.
// ============================================================
export const TOOL_VERB_MAP: Record<string, { pres: string; past: string }> = {
  Read:           { pres: '读取中',     past: '已读取' },
  Write:          { pres: '写入中',     past: '已写入' },
  Edit:           { pres: '编辑中',     past: '已编辑' },
  WebSearch:      { pres: '检索中',     past: '已检索' },
  Skill:          { pres: '加载中',     past: '已加载' },
  Glob:           { pres: '查找中',     past: '已查找' },
  Grep:           { pres: '查找中',     past: '已查找' },
  GenerateImage:  { pres: '生成中',     past: '已生成' },
  CreateObject3D: { pres: '创建中',     past: '已发起' },
  CreateWorld3D:  { pres: '创建中',     past: '已发起' },
  GetSpatialJob:  { pres: '查询中',     past: '已查询' },
  WaitSpatialJob: { pres: '等待中',     past: '已等待' },
  InspectSpatialArtifact: { pres: '检查中', past: '已检查' },
}

function verbFor(tool: string): { pres: string; past: string } {
  return TOOL_VERB_MAP[tool] ?? { pres: '调用中', past: '已调用' }
}

// ============================================================
// Authority tokenizer — numbers / citations / model terms
// ============================================================

const MODEL_TERMS = [
  'Transformer', 'BERT', 'GPT-4', 'GPT-5', 'GPT-3.5',
  'Claude', 'Claude Opus 4.6', 'Claude Opus 4.7', 'Claude Sonnet',
  'Gemini', 'Gemini-3.1-pro', 'Gemini 3.1 Pro', 'Gemini Pro',
  'Nano Banana', 'ResNet', 'ResNet-50', 'CLIP', 'LLaMA', 'Llama',
  'Mistral', 'Mixtral', 'DALL-E', 'Stable Diffusion',
  'base64',
]

const MODEL_RE = new RegExp(
  '\\b(' +
    MODEL_TERMS
      .slice()
      .sort((a, b) => b.length - a.length)
      .map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|') +
    ')\\b',
  'g'
)

const CITATION_RE = /\[(?:\d+(?:\s*,\s*\d+)*|(?:Nature|Science|PRL|arXiv|arxiv|ICLR|NeurIPS|ICML|CVPR)[^\]]{0,40})\]/g
const NUMBER_RE = /\b\d+(?:\.\d+)?(?:e[-+]?\d+)?(?:%|px|ms|s|MB|KB|GB|mm|cm|em|heads|层|epochs?|steps?)?\b/g

interface Token {
  kind: 'text' | 'number' | 'citation' | 'term'
  value: string
}

function tokenizeAuthority(input: string): Token[] {
  if (!input) return [{ kind: 'text', value: input }]
  type Match = { start: number; end: number; kind: Token['kind']; value: string; priority: number }
  const matches: Match[] = []

  for (const re of [
    { re: CITATION_RE, kind: 'citation' as const, priority: 3 },
    { re: MODEL_RE,    kind: 'term'     as const, priority: 2 },
    { re: NUMBER_RE,   kind: 'number'   as const, priority: 1 },
  ]) {
    re.re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.re.exec(input)) !== null) {
      matches.push({
        start: m.index,
        end: m.index + m[0].length,
        kind: re.kind,
        value: m[0],
        priority: re.priority,
      })
    }
  }

  if (matches.length === 0) return [{ kind: 'text', value: input }]
  matches.sort((a, b) => a.start - b.start || b.priority - a.priority)

  const chosen: Match[] = []
  for (const m of matches) {
    const last = chosen[chosen.length - 1]
    if (!last || m.start >= last.end) chosen.push(m)
  }

  let numberCount = 0
  const out: Token[] = []
  let cursor = 0
  for (const m of chosen) {
    if (m.kind === 'number') {
      numberCount += 1
      if (numberCount > 3) continue
    }
    if (m.start > cursor) out.push({ kind: 'text', value: input.slice(cursor, m.start) })
    out.push({ kind: m.kind, value: m.value })
    cursor = m.end
  }
  if (cursor < input.length) out.push({ kind: 'text', value: input.slice(cursor) })
  return out
}

function renderTokens(tokens: Token[], keyPrefix: string): ReactNode {
  return tokens.map((t, i) => {
    const key = `${keyPrefix}-${i}`
    switch (t.kind) {
      case 'citation':
        return <span key={key} className="pmo-authority-chip">{t.value}</span>
      case 'number':
      case 'term':
        return <span key={key} className="pmo-authority">{t.value}</span>
      default:
        return <Fragment key={key}>{t.value}</Fragment>
    }
  })
}

function applyAuthority(children: ReactNode, keyPrefix = 'a'): ReactNode {
  if (children == null || typeof children === 'boolean') return children
  if (typeof children === 'string') return renderTokens(tokenizeAuthority(children), keyPrefix)
  if (typeof children === 'number') return children
  if (Array.isArray(children)) {
    return children.map((child, i) => (
      <Fragment key={`${keyPrefix}-${i}`}>
        {applyAuthority(child, `${keyPrefix}-${i}`)}
      </Fragment>
    ))
  }
  return children
}

const markdownComponents: Components = {
  p: ({ children }) => <p>{applyAuthority(children, 'p')}</p>,
  li: ({ children }) => <li>{applyAuthority(children, 'li')}</li>,
  td: ({ children }) => <td>{applyAuthority(children, 'td')}</td>,
  th: ({ children }) => <th>{applyAuthority(children, 'th')}</th>,
  strong: ({ children }) => <strong>{applyAuthority(children, 'strong')}</strong>,
  em: ({ children }) => <em>{applyAuthority(children, 'em')}</em>,
  code: ({ className, children, ...rest }) => {
    const isBlock = typeof className === 'string' && className.startsWith('language-')
    if (isBlock) return <code className={className} {...rest}>{children}</code>
    return (
      <code
        {...rest}
        style={{
          background: 'var(--primary-tint-weak)',
          color: 'var(--primary)',
          fontFamily: 'var(--font-geist-mono), ui-monospace, monospace',
          padding: '0.1em 0.4em',
          borderRadius: '3px',
          fontSize: '0.87em',
        }}
      >
        {children}
      </code>
    )
  },
}

// ============================================================
// Citation extraction — pulls "## References" section off the
// end of a final-response body, returning the stripped body and
// a parsed list of citation items. Supports either of:
//   ## References
//   ## 参考文献
// followed by a numbered list ("1. Foo" / "- Foo" / "[1] Foo").
// ============================================================

interface CitationItem {
  num: string
  text: string
}

function extractCitations(text: string): { body: string; items: CitationItem[] } {
  const RE_HEADER = /\n\s*##\s*(?:References|参考文献|Citations)\s*\n/i
  const match = text.match(RE_HEADER)
  if (!match || match.index === undefined) return { body: text, items: [] }

  const body = text.slice(0, match.index).trimEnd()
  const tail = text.slice(match.index + match[0].length)
  const items: CitationItem[] = []

  tail.split(/\n+/).forEach((raw, idx) => {
    const line = raw.trim()
    if (!line) return
    // formats: "1. Foo" / "- Foo" / "[1] Foo"
    const numbered = line.match(/^(?:\[(\d+)\]|(\d+)[.)])\s+(.+)$/)
    const bulleted = line.match(/^[-*]\s+(.+)$/)
    if (numbered) {
      items.push({ num: (numbered[1] ?? numbered[2]).padStart(2, '0'), text: numbered[3] })
    } else if (bulleted) {
      items.push({ num: String(idx + 1).padStart(2, '0'), text: bulleted[1] })
    } else if (line.length > 8) {
      items.push({ num: String(idx + 1).padStart(2, '0'), text: line })
    }
  })

  return { body, items }
}

// ============================================================
// Helpers
// ============================================================

function formatTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function displayToolName(part: Extract<DisplayPart, { type: 'tool_call' }>): string {
  // Skill tool: try to render as "Skill: <name>" from action field or content
  if (part.tool === 'Skill') {
    // action might look like "加载了 Skill: literature-review"
    const m = part.action?.match(/Skill:\s*([a-zA-Z0-9_-]+)/)
    if (m) return `Skill: ${m[1]}`
    return 'Skill'
  }
  return part.file_path || part.tool
}

// ============================================================
// ThinkingPartView
// ============================================================

function ThinkingPartView({ part }: { part: { type: 'thinking'; text: string; pending?: boolean } }) {
  const [expanded, setExpanded] = useState(false)
  const isOpen = expanded || !!part.pending
  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        className="pmo-thinking-toggle"
      >
        {part.pending ? (
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" className="animate-spin">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" opacity="0.25" />
            <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points={isOpen ? '6 9 12 15 18 9' : '9 18 15 12 9 6'} />
          </svg>
        )}
        <span>{part.pending ? '思考中...' : '思考过程'}</span>
        {!part.pending && (
          <span style={{ color: 'var(--secondary-text)', marginLeft: 4 }}>
            ({part.text.length} chars)
          </span>
        )}
      </button>
      {isOpen && <div className="pmo-thinking-body">{part.text}</div>}
    </div>
  )
}

// ============================================================
// AskUserPartView
// ============================================================

function AskUserPartView({
  part,
  onAnswer,
}: {
  part: Extract<DisplayPart, { type: 'ask_user' }>
  onAnswer?: (answer: string, interactionId?: string) => void
}) {
  const questions: AskUserQuestionItem[] = part.questions?.length
    ? part.questions
    : [{
        id: 'legacy_question',
        header: '需要确认',
        question: part.question ?? '请补充你的选择。',
        options: (part.options ?? []).map(label => ({ label })),
        multi_select: false,
        required: true,
        allow_custom: true,
      }]
  const [selected, setSelected] = useState<Record<string, string[]>>({})
  const [customInputs, setCustomInputs] = useState<Record<string, string>>({})

  const toggleOption = (questionId: string, label: string, multiSelect: boolean) => {
    setSelected(prev => {
      const current = prev[questionId] ?? []
      return {
        ...prev,
        [questionId]: multiSelect
          ? current.includes(label)
            ? current.filter(item => item !== label)
            : [...current, label]
          : [label],
      }
    })
  }

  const isComplete = questions.every(question => {
    if (question.required === false) return true
    return (selected[question.id]?.length ?? 0) > 0
      || Boolean(customInputs[question.id]?.trim())
  })

  const submit = () => {
    if (!isComplete) return
    const answer = [
      '我对你刚才问题的回答：',
      '',
      ...questions.flatMap((question, index) => {
        const answers = selected[question.id] ?? []
        const custom = customInputs[question.id]?.trim()
        const rendered = [
          ...answers,
          ...(custom ? [`其他——${custom}`] : []),
        ].join('、') || '未选择'
        return [
          `${index + 1}. ${question.header}`,
          `问题：${question.question}`,
          `回答：${rendered}`,
          '',
        ]
      }),
    ].join('\n').trim()
    onAnswer?.(answer, part.interaction_id)
  }

  if (part.answered) {
    return (
      <div className="pmo-ask-user">
        <div className="pmo-ask-user-q">
          <span style={{ color: 'var(--primary)', marginRight: 6 }}>提问</span>
          {questions.map(question => question.header).join(' · ')}
        </div>
        <div className="pmo-ask-user-answered">已回答</div>
      </div>
    )
  }

  return (
    <div className="pmo-ask-user">
      {questions.map((question, questionIndex) => (
        <fieldset key={question.id} style={{ border: 0, padding: 0, margin: questionIndex ? '18px 0 0' : 0 }}>
          <legend className="pmo-ask-user-q" style={{ width: '100%' }}>
            <span style={{ color: 'var(--primary)', marginRight: 8 }}>{question.header}</span>
            {question.question}
            {question.required === false && <span style={{ color: 'var(--secondary-text)', marginLeft: 6 }}>可选</span>}
          </legend>
          <div style={{ display: 'grid', gap: 7, marginTop: 10 }}>
            {question.options.map(option => {
              const checked = selected[question.id]?.includes(option.label) ?? false
              return (
                <button
                  key={option.label}
                  type="button"
                  className="pmo-ask-user-opt"
                  aria-pressed={checked}
                  onClick={() => toggleOption(question.id, option.label, question.multi_select)}
                  style={{
                    textAlign: 'left',
                    borderColor: checked ? 'var(--primary)' : undefined,
                    background: checked ? 'color-mix(in srgb, var(--primary) 9%, transparent)' : undefined,
                  }}
                >
                  <span style={{ fontWeight: 600 }}>{option.label}</span>
                  {option.description && (
                    <span style={{ display: 'block', marginTop: 3, color: 'var(--secondary-text)', fontSize: 11.5 }}>
                      {option.description}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
          {question.allow_custom !== false && (
            <input
              type="text"
              value={customInputs[question.id] ?? ''}
              onChange={event => setCustomInputs(prev => ({ ...prev, [question.id]: event.target.value }))}
              placeholder="其他（可自行填写）"
              style={{
                width: '100%',
                boxSizing: 'border-box',
                fontSize: 12.5,
                padding: '8px 10px',
                marginTop: 8,
                borderRadius: 5,
                background: 'var(--surface-container-lowest)',
                color: 'var(--on-surface)',
                border: '1px solid color-mix(in srgb, var(--primary) 18%, transparent)',
                outline: 'none',
              }}
            />
          )}
        </fieldset>
      ))}
      <button
        type="button"
        disabled={!isComplete}
        onClick={submit}
        className="pmo-btn-primary"
        style={{
          width: '100%',
          marginTop: 18,
          fontSize: 12.5,
          padding: '9px 14px',
          borderRadius: 5,
          border: 'none',
          cursor: isComplete ? 'pointer' : 'not-allowed',
          opacity: isComplete ? 1 : 0.48,
        }}
      >
        提交回答
      </button>
    </div>
  )
}

// ============================================================
// Interrupted marker
// ============================================================

function InterruptedMarker() {
  return (
    <div className="pmo-interrupted">
      <div className="pmo-interrupted-rule" />
      <span className="pmo-interrupted-label">对话在此处被中断</span>
      <div className="pmo-interrupted-rule" />
    </div>
  )
}

// ============================================================
// ToolCallRow — single row inside ProcessBubble
// ============================================================

function ToolCallRow({
  part,
}: {
  part: Extract<DisplayPart, { type: 'tool_call' }>
}) {
  const { pres, past } = verbFor(part.tool)
  const isLoading = !!part.pending
  const isError = !!part.is_error
  const stateClass = isError ? 'failed' : isLoading ? 'loading' : 'completed'
  const nameText = displayToolName(part)

  return (
    <div className={`pmo-tool ${stateClass}`}>
      <div className="pmo-tool-row">
        <span className="pmo-tool-pip" aria-hidden="true" />
        <span className="pmo-tool-verb">
          {isError ? (
            <span className="past" style={{ position: 'static', opacity: 1 }}>
              FAILED
            </span>
          ) : (
            <>
              <span className="pres">{pres}</span>
              <span className="past">{past}</span>
            </>
          )}
        </span>
        <span className="pmo-tool-sep">·</span>
        <span className="pmo-tool-name">{nameText}</span>
        <span className="pmo-tool-cap" aria-hidden="true" />
        <span className="pmo-tool-live" aria-hidden="true" />
      </div>
      {isError && part.content && (
        <div className="pmo-tool-fail-reason">
          <b>error</b> · {part.content.slice(0, 200)}
        </div>
      )}
      {isSpatialTool(part.tool) && (
        <SpatialJobCard
          tool={part.tool}
          content={part.content}
          pending={part.pending}
          isError={part.is_error}
        />
      )}
    </div>
  )
}

// ============================================================
// Narration text paragraph (inside process bubble)
// ============================================================

function Narration({ text, first }: { text: string; first?: boolean }) {
  return (
    <div className={`pmo-narration${first ? ' pmo-narration-first' : ''}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {text}
      </ReactMarkdown>
    </div>
  )
}

// ============================================================
// ProcessBubble — assistant message with at least one tool_call
// ============================================================

function ProcessBubble({
  message,
  parts,
  isStreaming,
  onAnswerQuestion,
}: {
  message: ChatMessage
  parts: DisplayPart[]
  isStreaming: boolean
  onAnswerQuestion?: (answer: string, interactionId?: string) => void
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const prevStreamingRef = useRef(isStreaming)

  // Terminal outcome — a run ends in FAILURE / INTERRUPTION when its last
  // process event is an interrupted marker or an errored tool call. Scanning
  // from the end skips trailing narration/thinking. Drives the red completion
  // (.pmo-fail): red bloom + red persistent edge-light + red pulse + 已中断.
  let terminalFail = false
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i]
    if (p.type === 'interrupted') { terminalFail = true; break }
    if (p.type === 'tool_call') { terminalFail = !!p.is_error; break }
  }

  // Ceremony: on streaming → complete transition, fire the completion once
  // (bloom + pulse, red when .pmo-fail). ONLY the live transition triggers it —
  // historical cards mount already-.completed, so they get the persistent
  // edge-light but no bloom/pulse flash. The .completed class drives the
  // persistent edge-light and the GENERATING fade via CSS.
  useEffect(() => {
    const el = rootRef.current
    if (prevStreamingRef.current && !isStreaming && el) {
      el.classList.add('pmo-complete-fire')
      const t = setTimeout(() => el.classList.remove('pmo-complete-fire'), 1300)
      prevStreamingRef.current = isStreaming
      return () => clearTimeout(t)
    }
    prevStreamingRef.current = isStreaming
  }, [isStreaming])

  const firstNarrIdx = parts.findIndex(p => p.type === 'text')

  return (
    <div
      ref={rootRef}
      className={`pmo-msg pmo-msg-ai ${isStreaming ? 'generating' : 'completed'}${terminalFail ? ' pmo-fail' : ''}`}
    >
      <div className="pmo-msg-meta">
        PEGASUS SPATIAL{' '}<span className="pmo-time">{formatTime(message.timestamp)}</span>
        {isStreaming && <span className="pmo-generating">· GENERATING</span>}
        {!isStreaming && (
          <span className={`pmo-completed-badge${terminalFail ? ' pmo-badge-fail' : ''}`}>
            {terminalFail ? '· 已中断' : '· 已记录'}
          </span>
        )}
      </div>
      <div className="pmo-bubble">
        {/* 光态 edge 层:巡游心跳 / 完成 bloom / 持久边光留痕(见 globals .pmo-edge*) */}
        <div className="pmo-edge" aria-hidden="true">
          <span className="pmo-edge-travel" />
          <span className="pmo-edge-travel pmo-edge-halo" />
          <span className="pmo-edge-bloom" />
          <span className="pmo-edge-rest pmo-edge-rest-wide" />
          <span className="pmo-edge-rest" />
        </div>
        <div className="pmo-bubble-body">
          {parts.length === 0 && isStreaming && (
            <div className="pmo-waiting">
              <span>等待响应</span>
              <span className="pmo-waiting-dots">
                <span></span><span></span><span></span>
              </span>
            </div>
          )}
          {parts.map((part, i) => {
            switch (part.type) {
              case 'text':
                return part.text.trim()
                  ? <Narration key={i} text={part.text} first={i === firstNarrIdx} />
                  : null
              case 'tool_call':
                return <ToolCallRow key={i} part={part} />
              case 'thinking':
                return <ThinkingPartView key={i} part={part} />
              case 'redacted_thinking':
                return <div key={i} className="pmo-redacted">加密思考内容 (signature)</div>
              case 'ask_user':
                return <AskUserPartView key={i} part={part} onAnswer={onAnswerQuestion} />
              case 'image':
                return (part.url || part.base64) ? (
                  <ProgressiveImage
                    key={i}
                    src={part.url ?? `data:${part.mimeType};base64,${part.base64}`}
                    alt="生成的图片"
                    frameClassName="pmo-inline-image-frame"
                    imageClassName="pmo-inline-image"
                  />
                ) : null
              case 'interrupted':
                return <InterruptedMarker key={i} />
              default:
                return null
            }
          })}
        </div>
      </div>
    </div>
  )
}

// ============================================================
// FinalResponse — assistant message with no tool_call. Mirrors
// user structure: fresh meta row + body, no container.
// ============================================================

function FinalResponse({
  message,
  parts,
  isStreaming,
  onAnswerQuestion,
}: {
  message: ChatMessage
  parts: DisplayPart[]
  isStreaming: boolean
  onAnswerQuestion?: (answer: string, interactionId?: string) => void
}) {
  // Consolidate all `text` parts into one body blob for citation extraction,
  // but keep non-text parts (thinking / interrupted / image / ask_user)
  // rendered individually.
  const textBlob = parts
    .filter(p => p.type === 'text')
    .map(p => (p as Extract<DisplayPart, { type: 'text' }>).text)
    .join('\n\n') || message.content || ''

  const { body, items } = extractCitations(textBlob)

  return (
    <div className="pmo-msg pmo-msg-ai-final">
      <div className="pmo-msg-meta">
        PEGASUS SPATIAL{' '}<span className="pmo-time">{formatTime(message.timestamp)}</span>
      </div>
      <div className="pmo-msg-body">
        {parts.length === 0 && isStreaming && (
          <div className="pmo-waiting">
            <span>等待响应</span>
            <span className="pmo-waiting-dots">
              <span></span><span></span><span></span>
            </span>
          </div>
        )}

        {/* Render non-text parts first (thinking / ask_user / interrupted / image) */}
        {parts.map((part, i) => {
          switch (part.type) {
            case 'thinking':
              return <ThinkingPartView key={i} part={part} />
            case 'redacted_thinking':
              return <div key={i} className="pmo-redacted">加密思考内容 (signature)</div>
            case 'ask_user':
              return <AskUserPartView key={i} part={part} onAnswer={onAnswerQuestion} />
            case 'image':
              return (part.url || part.base64) ? (
                <ProgressiveImage
                  key={i}
                  src={part.url ?? `data:${part.mimeType};base64,${part.base64}`}
                  alt="生成的图片"
                  frameClassName="pmo-inline-image-frame"
                  imageClassName="pmo-inline-image"
                />
              ) : null
            case 'interrupted':
              return <InterruptedMarker key={i} />
            default:
              return null
          }
        })}

        {/* Main text body — markdown with authority coloring */}
        {body && (
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
            {body}
          </ReactMarkdown>
        )}

        {/* Grouped citation cards */}
        {items.length > 0 && (
          <div className="pmo-citations">
            {items.map((c, i) => (
              <div key={i} className="pmo-citation">
                <span className="pmo-citation-num">{c.num}</span>
                <span>{c.text}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ============================================================
// UserMessage — plain, no container, image attachments supported
// ============================================================

function UserMessage({ message }: { message: ChatMessage }) {
  return (
    <div className="pmo-msg pmo-msg-user">
      <div className="pmo-msg-meta">
        YOU{' '}<span className="pmo-time">{formatTime(message.timestamp)}</span>
      </div>
      {message.images && message.images.length > 0 && (
        <div className="pmo-user-images">
          {message.images.map((img, i) => (
            <ProgressiveImage
              key={i}
              src={'assetId' in img
                ? buildBrowserMediaUrl(img.assetId, 'model', img.storageDriver)
                : img.url}
              alt={`用户图片 ${i + 1}`}
              width={img.width}
              height={img.height}
              frameClassName="pmo-user-image-frame"
              frameStyle={img.width && img.height ? { aspectRatio: `${img.width} / ${img.height}` } : undefined}
              imageClassName="object-contain"
            />
          ))}
        </div>
      )}
      <div className="pmo-msg-body pmo-msg-body-user">{message.content}</div>
    </div>
  )
}

// ============================================================
// Top-level dispatcher
// ============================================================

interface MessageBubbleProps {
  message: ChatMessage
  onAnswerQuestion?: (answer: string, interactionId?: string) => void
}

export function MessageBubble({ message, onAnswerQuestion }: MessageBubbleProps) {
  if (message.role === 'user') {
    return <UserMessage message={message} />
  }

  const parts = message.parts ?? []
  const isStreaming = !!message.isStreaming

  // Split the assistant message at the LAST "process" tool_call — any tool
  // that's part of the agent-loop work (Write / Read / Edit /
  // etc.). AskUserQuestion is an interaction at the tail, not a process
  // step, so it does NOT count as a process boundary.
  //
  //   processParts  → rendered inside the bubble (loop transparency)
  //   finalParts    → rendered OUTSIDE the bubble, plain like a user msg
  //                   (the natural-language answer that arrives once the
  //                   loop is over)
  //
  // When both are non-empty (message mixes work + answer), we render BOTH
  // blocks back-to-back: bubble on top, final response below.
  let lastProcessIdx = -1
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i]
    if (p.type === 'tool_call' && p.tool !== 'AskUserQuestion') {
      lastProcessIdx = i
      break
    }
  }

  // ask_user is always pinned to the very end so the user can answer without
  // scrolling back up — we lift every ask_user part out of process/final
  // sections and render them in their own AskUserSection at the bottom.
  const allFinalParts = lastProcessIdx >= 0 ? parts.slice(lastProcessIdx + 1) : parts
  const processPartsRaw = lastProcessIdx >= 0 ? parts.slice(0, lastProcessIdx + 1) : []
  const processParts = processPartsRaw.filter(p => p.type !== 'ask_user')
  const finalParts = allFinalParts.filter(p => p.type !== 'ask_user')
  const askUserParts = parts.filter(p => p.type === 'ask_user') as Extract<DisplayPart, { type: 'ask_user' }>[]
  // Before the first SSE event (and on an HTTP/network failure) an assistant
  // message legitimately has no structured parts. FinalResponse already knows
  // how to render its waiting state and fall back to message.content; do not
  // hide that state behind the parts-length gate.
  const shouldRenderFinal = finalParts.length > 0
    || (parts.length === 0 && (isStreaming || message.content.trim().length > 0))

  return (
    <>
      {processParts.length > 0 && (
        <ProcessBubble
          message={message}
          parts={processParts}
          isStreaming={isStreaming}
          onAnswerQuestion={onAnswerQuestion}
        />
      )}
      {shouldRenderFinal && (
        <FinalResponse
          message={message}
          parts={finalParts}
          isStreaming={isStreaming && processParts.length === 0}
          onAnswerQuestion={onAnswerQuestion}
        />
      )}
      {askUserParts.length > 0 && (
        <div className="pmo-msg pmo-msg-ai-final">
          {askUserParts.map((part, i) => (
            <AskUserPartView key={i} part={part} onAnswer={onAnswerQuestion} />
          ))}
        </div>
      )}
    </>
  )
}
