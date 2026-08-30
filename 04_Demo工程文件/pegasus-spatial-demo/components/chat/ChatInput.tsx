'use client'

import { useState, useRef, useEffect, useCallback, KeyboardEvent, ChangeEvent } from 'react'
import { QuotedSelection } from './ChatContainer'
import { ImageAttachment, ModelProvider } from '@/lib/types'
import { useChatContext } from '@/contexts/ChatContext'
import type { ContextUsageState } from '@/hooks/chat-compaction-state'
import { useModels } from '@/hooks/useModels'
import { buildBrowserMediaUrl } from '@/lib/media/browser-url'
import { ProgressiveImage } from '@/components/media/ProgressiveImage'

interface ChatInputProps {
  onSend: (message: string, images?: ImageAttachment[]) => void
  isLoading: boolean
  onStop: () => void
  quotedSelection?: QuotedSelection | null
  onClearQuote?: () => void
  contextUsage?: ContextUsageState | null
}

const APP_VERSION = 'v0.1.0'

const MAX_FILE_SIZE = 20 * 1024 * 1024
const MAX_IMAGES = 5
const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

/**
 * Send-ceremony fly ghost — clones the user's text into a fixed-position
 * floating element at the textarea's current rect, then animates translate
 * from there to wherever the new MessageBubble's `.pmo-msg-body-user`
 * lands once React commits. Falls back gracefully if the destination
 * bubble can't be found within two RAFs.
 */
function flyGhost(srcRect: DOMRect | null, text: string) {
  if (!srcRect || !text) return

  const ghost = document.createElement('div')
  ghost.className = 'pmo-fly-ghost'
  ghost.textContent = text
  ghost.style.left = `${srcRect.left}px`
  ghost.style.top = `${srcRect.top}px`
  ghost.style.width = `${srcRect.width}px`
  document.body.appendChild(ghost)

  requestAnimationFrame(() => requestAnimationFrame(() => {
    const allBubbles = document.querySelectorAll('.pmo-msg-user .pmo-msg-body-user')
    const dst = allBubbles[allBubbles.length - 1] as HTMLElement | undefined
    if (!dst) {
      ghost.remove()
      return
    }
    const dstRect = dst.getBoundingClientRect()
    const dx = dstRect.left - srcRect.left
    const dy = dstRect.top - srcRect.top

    const distance = Math.hypot(dx, dy)
    const duration = Math.max(240, Math.min(520, distance * 0.75))

    const anim = ghost.animate(
      [
        { transform: 'translate(0,0) scale(1)', opacity: 1 },
        { transform: `translate(${dx * 0.5}px, ${dy * 0.5}px) scale(0.98)`, opacity: 0.85, offset: 0.6 },
        { transform: `translate(${dx}px, ${dy}px) scale(0.96)`, opacity: 0 },
      ],
      { duration, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'forwards' },
    )
    anim.onfinish = () => ghost.remove()
    anim.oncancel = () => ghost.remove()
  }))
}

export function ChatInput({ onSend, isLoading, onStop, quotedSelection, onClearQuote, contextUsage }: ChatInputProps) {
  const { model, setModel } = useChatContext()
  const [input, setInput] = useState('')
  const [pendingImages, setPendingImages] = useState<ImageAttachment[]>([])
  const [uploadingImages, setUploadingImages] = useState(0)
  const [imageUploadError, setImageUploadError] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Inline model popover (replaces full-screen ModelPickerModal) — uses
  // the same visual language as TaskWorkbench's model picker so the two
  // inputs (empty-state hero + active-state ChatInput) feel like one
  // component with the same affordances.
  const { models, isLoading: modelsLoading } = useModels()
  const [modelOpen, setModelOpen] = useState(false)
  const [modelSearch, setModelSearch] = useState('')
  const modelRef = useRef<HTMLDivElement>(null)
  const modelSearchInputRef = useRef<HTMLInputElement>(null)
  const selectedModel = models.find(m => m.id === model)
  const supportsVision = selectedModel?.supportsVision === true
  const selectedModelName = selectedModel?.name ?? (modelsLoading ? '...' : model)
  const trimmedModelSearch = modelSearch.trim().toLowerCase()
  const filteredModels = trimmedModelSearch
    ? models.filter(m =>
        m.name.toLowerCase().includes(trimmedModelSearch) ||
        m.id.toLowerCase().includes(trimmedModelSearch) ||
        (m.description?.toLowerCase().includes(trimmedModelSearch) ?? false))
    : models

  // Close popover on outside click
  useEffect(() => {
    if (!modelOpen) return
    const handler = (e: MouseEvent) => {
      if (modelRef.current && !modelRef.current.contains(e.target as Node)) {
        setModelOpen(false)
        setModelSearch('')
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [modelOpen])

  // Auto-focus search when popover opens
  useEffect(() => {
    if (modelOpen) modelSearchInputRef.current?.focus()
  }, [modelOpen])

  // Send-fire shimmer pulse on .pmo-send-btn (one-shot via .fire class)
  const [shimmering, setShimmering] = useState(false)
  const triggerShimmer = () => {
    setShimmering(true)
    setTimeout(() => setShimmering(false), 850)
  }

  const handleSend = () => {
    if (uploadingImages > 0 || !(input.trim() || pendingImages.length > 0)) return
    if (pendingImages.length > 0 && !supportsVision) {
      setImageUploadError('当前模型不支持图片。请移除图片，或切换到支持图片的模型。')
      return
    }
    triggerShimmer()

    const userText = input.trim() || '请分析这张图片'
    let message = userText
    if (quotedSelection) {
      const lines = quotedSelection.startLine && quotedSelection.endLine
        ? ` lines="${quotedSelection.startLine}-${quotedSelection.endLine}"`
        : ''
      message = `<quoted-selection path="${quotedSelection.path}"${lines}>\n${quotedSelection.content}\n</quoted-selection>\n\n${userText}`
      onClearQuote?.()
    }

    // Fly ghost ceremony — animate user text from textarea rect to message bubble
    const textarea = textareaRef.current
    const srcRect = textarea?.getBoundingClientRect() ?? null
    const ghostText = userText.length > 200 ? userText.slice(0, 200) + '…' : userText
    flyGhost(srcRect, ghostText)

    onSend(message, pendingImages.length > 0 ? pendingImages : undefined)
    setInput('')
    setPendingImages([])
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleInput = () => {
    const textarea = textareaRef.current
    if (textarea) {
      textarea.style.height = 'auto'
      textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px'
    }
  }

  const processFile = useCallback(async (file: File) => {
    setImageUploadError('')
    if (!supportsVision) {
      setImageUploadError('当前模型不支持图片，请先切换到多模态模型。')
      return
    }
    if (!ACCEPTED_TYPES.includes(file.type)) {
      setImageUploadError('仅支持 PNG、JPEG、GIF 和 WebP')
      return
    }
    if (file.size > MAX_FILE_SIZE) {
      setImageUploadError('单张图片不能超过 20MB')
      return
    }

    setUploadingImages(count => count + 1)
    try {
      const form = new FormData()
      form.append('file', file)
      const response = await fetch('/api/media/upload', { method: 'POST', body: form })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(payload?.error || `图片上传失败 (${response.status})`)
      }
      const image = payload.image as ImageAttachment | undefined
      if (!image || !('assetId' in image)) throw new Error('图片上传返回了无效资产')
      setPendingImages(prev => prev.length >= MAX_IMAGES ? prev : [...prev, image])
    } catch (err) {
      setImageUploadError((err as Error).message)
    } finally {
      setUploadingImages(count => Math.max(0, count - 1))
    }
  }, [supportsVision])

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files) return
    for (const file of Array.from(files).slice(0, MAX_IMAGES)) void processFile(file)
    e.target.value = ''
  }

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (!items) return
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        e.preventDefault()
        if (!supportsVision) {
          setImageUploadError('当前模型不支持图片，请先切换到多模态模型。')
          return
        }
        const file = item.getAsFile()
        if (file) void processFile(file)
      }
    }
  }, [processFile, supportsVision])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    const files = e.dataTransfer?.files
    if (!files) return
    for (const file of Array.from(files)) {
      if (file.type.startsWith('image/')) void processFile(file)
    }
  }, [processFile])

  const removeImage = (index: number) => {
    setPendingImages(prev => prev.filter((_, i) => i !== index))
  }

  const handleModelSelect = (id: string) => {
    setModel(id as ModelProvider)
    setModelOpen(false)
    setModelSearch('')
  }

  const canSend = uploadingImages === 0
    && !!(input.trim() || pendingImages.length > 0)
    && (supportsVision || pendingImages.length === 0)

  useEffect(() => {
    if (!modelsLoading && pendingImages.length > 0 && !supportsVision) {
      setImageUploadError('当前模型不支持图片。附件已保留，请移除图片或切换模型。')
    } else if (supportsVision && imageUploadError.startsWith('当前模型不支持图片')) {
      setImageUploadError('')
    }
  }, [imageUploadError, modelsLoading, pendingImages.length, supportsVision])

  return (
    <div
      className="px-4 pb-4 pt-2"
      onDrop={handleDrop}
      onDragOver={e => e.preventDefault()}
    >
      {/* Unify input column width with messages column (680px) so bubble
          and composer land on the same vertical axis. */}
      <div className="mx-auto" style={{ maxWidth: 680 }}>
        {/* Quoted selection preview — sits above the input shell as a distinct
            stripe so the user sees what context they're quoting before sending */}
        {quotedSelection && (
          <div className="mb-3 rounded-card bg-chip-bg/40 px-4 py-2.5 text-xs">
            <div className="flex items-center justify-between mb-1">
              <span className="font-medium text-primary">
                {quotedSelection.path}
                {quotedSelection.startLine && quotedSelection.endLine && (
                  <span className="text-primary/60 ml-1">
                    :{quotedSelection.startLine}-{quotedSelection.endLine}
                  </span>
                )}
              </span>
              <button onClick={onClearQuote} className="text-ink-muted hover:text-ink transition-colors p-0.5">
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="text-ink-secondary line-clamp-3 whitespace-pre-wrap font-mono text-[11px]">
              {quotedSelection.content}
            </div>
          </div>
        )}

        {/* Pending image previews */}
        {pendingImages.length > 0 && (
          <div className="mb-3 flex gap-2.5 flex-wrap">
            {pendingImages.map((img, i) => (
              <div key={i} className="relative group">
                <ProgressiveImage
                  src={'assetId' in img
                    ? buildBrowserMediaUrl(img.assetId, 'thumbnail', img.storageDriver)
                    : img.url}
                  alt={`上传图片 ${i + 1}`}
                  fit="cover"
                  frameClassName="h-16 w-16 rounded-card"
                  imageClassName="h-16 w-16 object-cover"
                  frameStyle={{ boxShadow: 'var(--shadow-ambient)' }}
                />
                <button
                  onClick={() => removeImage(i)}
                  className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-ink text-on-primary flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}

        {(uploadingImages > 0 || imageUploadError) && (
          <div className="mb-2 text-xs" style={{ color: imageUploadError ? 'var(--danger)' : 'var(--ink-muted)' }}>
            {imageUploadError || `正在上传 ${uploadingImages} 张图片…`}
          </div>
        )}

        {/* Input shell — same `.pmo-input-shell` as TaskWorkbench so empty
            state and active state share one composer visual language. */}
        <div className="pmo-input-shell">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onInput={handleInput}
            onPaste={handlePaste}
            placeholder={
              isLoading ? '输入追加消息…'
              : pendingImages.length > 0 ? '描述你想要的操作…'
              : quotedSelection ? '描述你想要的修改…'
              : '描述你想创造、修订或审阅的空间与 3D 资产…'
            }
            rows={1}
            className="pmo-input-textarea"
          />

          {/* Toolbar — same `.pmo-tool-btn` set as TaskWorkbench. ChatInput-
              specific buttons (image upload) use the same class so they sit
              flush with model / memory controls. */}
          <div className="pmo-input-toolbar">
            {/* Image upload — opens hidden picker restricted to ACCEPTED_TYPES */}
            {supportsVision && (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={isLoading || uploadingImages > 0 || pendingImages.length >= MAX_IMAGES}
                className="pmo-tool-btn"
                title="上传图片"
              >
                <span className="pmo-tool-btn-icon" aria-hidden>
                  <svg width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0 0 22.5 18.75V5.25A2.25 2.25 0 0 0 20.25 3H3.75A2.25 2.25 0 0 0 1.5 5.25v13.5A2.25 2.25 0 0 0 3.75 21Z" />
                  </svg>
                </span>
                图片
              </button>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPTED_TYPES.join(',')}
              multiple
              onChange={handleFileChange}
              className="hidden"
            />

            {/* Model picker — inline popover (same UX as TaskWorkbench) */}
            <div ref={modelRef} style={{ position: 'relative' }}>
              <button
                type="button"
                className={`pmo-tool-btn model ${modelOpen ? 'open' : ''}`}
                onClick={() => setModelOpen(o => !o)}
                title="选择模型"
              >
                <span className="pmo-tool-btn-icon">◐</span>
                <span style={{ maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {selectedModelName}
                </span>
                <span className="pmo-tool-btn-caret">{modelOpen ? '∧' : '⌄'}</span>
              </button>
              {modelOpen && (
                <div className="pmo-popover model-picker">
                  <div className="pmo-popover-search-wrap">
                    <input
                      ref={modelSearchInputRef}
                      type="text"
                      value={modelSearch}
                      onChange={e => setModelSearch(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Escape') {
                          setModelOpen(false)
                          setModelSearch('')
                        }
                      }}
                      placeholder="搜索模型…"
                      className="pmo-popover-search"
                    />
                  </div>
                  <div className="pmo-popover-list">
                    {modelsLoading ? (
                      <div style={{ padding: '14px', fontSize: 12, color: 'var(--ink-muted)', textAlign: 'center' }}>
                        加载中…
                      </div>
                    ) : filteredModels.length === 0 ? (
                      <div style={{ padding: '14px', fontSize: 12, color: 'var(--ink-muted)', textAlign: 'center' }}>
                        无匹配
                      </div>
                    ) : (
                      filteredModels.map(m => (
                        <button
                          key={m.id}
                          type="button"
                          className={`pmo-popover-model-item ${model === m.id ? 'selected' : ''}`}
                          onClick={() => handleModelSelect(m.id)}
                        >
                          <div className="pmo-popover-model-item-body">
                            <div className="pmo-popover-model-item-name">{m.name}</div>
                            {m.description && (
                              <div className="pmo-popover-model-item-desc">{m.description}</div>
                            )}
                          </div>
                          <span className="pmo-popover-model-item-check">✓</span>
                        </button>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>

            <span className="pmo-toolbar-spacer" />

            {/* Right side — send/append/stop trio.
                When isLoading: show "追加" (if input has text) + "停止" (red).
                When idle: single send arrow. */}
            {isLoading ? (
              <>
                {input.trim() && (
                  <button
                    type="button"
                    onClick={handleSend}
                    className={`pmo-send-btn append ${shimmering ? 'fire' : ''}`}
                    title="追加"
                  >
                    追加
                  </button>
                )}
                <button
                  type="button"
                  onClick={onStop}
                  className="pmo-send-btn stop append"
                  title="停止"
                >
                  停止
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={handleSend}
                disabled={!canSend}
                className={`pmo-send-btn ${shimmering ? 'fire' : ''}`}
                title="发送"
              >
                ↑
              </button>
            )}
          </div>
        </div>

        {/* Editorial footer — keyboard hints + token ticker. */}
        <div className="pmo-input-meta">
          <span>
            Press <span className="pmo-kbd">⌘</span>
            <span className="pmo-kbd">↵</span> to send ·{' '}
            <span className="pmo-kbd">/</span> for commands
          </span>
          <span className="pmo-tokens">
            PEGASUS SPATIAL · {APP_VERSION} ·{' '}
            {contextUsage
              ? <><b>{contextUsage.compressible.toLocaleString()}</b>{' '}TOKENS</>
              : <>CONTEXT —</>}
          </span>
        </div>
      </div>
    </div>
  )
}
