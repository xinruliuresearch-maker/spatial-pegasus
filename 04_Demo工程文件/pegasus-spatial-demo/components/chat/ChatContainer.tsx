'use client'

import { useRef, useEffect } from 'react'
import { ChatMessage } from '@/hooks/useChat'
import { ImageAttachment } from '@/lib/types'
import { MessageBubble } from './MessageBubble'
import { ChatInput } from './ChatInput'
import type { ContextUsageState } from '@/hooks/chat-compaction-state'

export interface QuotedSelection {
  path: string
  content: string
  startLine?: number
  endLine?: number
}

interface ChatContainerProps {
  messages: ChatMessage[]
  isLoading: boolean
  onSend: (message: string, images?: ImageAttachment[]) => void
  onStop: () => void
  onAnswerQuestion?: (answer: string, interactionId?: string) => void
  quotedSelection?: QuotedSelection | null
  onClearQuote?: () => void
  contextUsage?: ContextUsageState | null
}

export function ChatContainer({
  messages,
  isLoading,
  onSend,
  onStop,
  onAnswerQuestion,
  quotedSelection,
  onClearQuote,
  contextUsage,
}: ChatContainerProps) {
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  const usagePercent = contextUsage
    ? Math.min(100, Math.round((contextUsage.compressible / contextUsage.threshold) * 100))
    : 0
  const usageColor = usagePercent > 80
    ? 'bg-warning'
    : usagePercent > 60
      ? 'bg-primary-container'
      : 'bg-surface-high'

  return (
    // .pmo-conversation-bg = same surface as the empty-state hero (transparent
    // + subtle blue radial accent). The chat panel IS the conversation, just
    // at the "in-progress" stage of the same surface — so it must share bg
    // with the hero, not with Chrome panels.
    <div className="flex flex-col h-full pmo-conversation-bg">
      {/* Context usage bar */}
      {contextUsage && contextUsage.compressible > 0 && (
        <div className="flex-shrink-0 px-5 pt-3">
          <div className="flex items-center gap-2.5 text-[10px] text-ink-muted font-medium">
            <span className="whitespace-nowrap uppercase tracking-wider">上下文</span>
            <div className="flex-1 h-1 bg-surface-mid rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ease-out ${usageColor}`}
                style={{ width: `${usagePercent}%` }}
              />
            </div>
            <span className="whitespace-nowrap tabular-nums">
              {Math.round(contextUsage.compressible / 1000)}K / {Math.round(contextUsage.threshold / 1000)}K
            </span>
          </div>
        </div>
      )}

      {/* Messages area — editorial timeline. Side padding reduced from
          demo-C5's 80px because the real chat panel is 560px wide (not a
          full-width reading page). 28px keeps breathing room without
          starving the content column. */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto"
        style={{ padding: '40px 28px 16px' }}
      >
        <div className="mx-auto" style={{ maxWidth: 680 }}>
          {messages.map(msg => (
            <MessageBubble
              key={msg.id}
              message={msg}
              onAnswerQuestion={onAnswerQuestion}
            />
          ))}
        </div>
      </div>

      {/* Input area */}
      <ChatInput
        onSend={onSend}
        isLoading={isLoading}
        onStop={onStop}
        quotedSelection={quotedSelection}
        onClearQuote={onClearQuote}
        contextUsage={contextUsage}
      />
    </div>
  )
}
