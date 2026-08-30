'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useConversations } from '@/hooks/useConversation'

interface ConversationListProps {
  currentConversationId: string | null
  runningConversationIds: Set<string>
  waitingForUserIds: Set<string>
  onSelectConversation: (id: string) => void
  onDeleteConversation: (id: string) => void
}

function relTime(iso: string): string {
  if (!iso) return ''
  const ts = new Date(iso).getTime()
  if (Number.isNaN(ts)) return ''
  const diffSec = Math.max(0, (Date.now() - ts) / 1000)
  if (diffSec < 60) return 'now'
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m`
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h`
  if (diffSec < 7 * 86400) return `${Math.floor(diffSec / 86400)}d`
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function IconPin() {
  return (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
    </svg>
  )
}
function IconPinFilled() {
  return (
    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
    </svg>
  )
}
function IconPencil() {
  return (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125" />
    </svg>
  )
}
function IconTrash() {
  return (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
    </svg>
  )
}

interface RowMenuProps {
  isPinned: boolean
  onPin: () => void
  onRename: () => void
  onDelete: () => Promise<void>
}

function RowMenu({ isPinned, onPin, onRename, onDelete }: RowMenuProps) {
  const [open, setOpen] = useState(false)
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 })
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const openMenu = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    const rect = btnRef.current?.getBoundingClientRect()
    if (rect) {
      setMenuPos({
        top: rect.top - 4,
        left: rect.right + 8,
      })
    }
    setOpen(v => !v)
  }, [])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (
        menuRef.current && !menuRef.current.contains(e.target as Node) &&
        btnRef.current && !btnRef.current.contains(e.target as Node)
      ) {
        setOpen(false)
      }
    }
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    document.addEventListener('keydown', keyHandler)
    return () => {
      document.removeEventListener('mousedown', handler)
      document.removeEventListener('keydown', keyHandler)
    }
  }, [open])

  return (
    <>
      <button
        ref={btnRef}
        onClick={openMenu}
        className={`p-0.5 rounded-ctrl outline-none transition-all ${
          open
            ? 'opacity-100 text-ink bg-surface-low'
            : 'opacity-0 group-hover:opacity-100 text-ink-muted hover:text-ink hover:bg-surface-low'
        }`}
        title="更多操作"
      >
        {/* Vertical three-dot (meatball) icon */}
        <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 16 16">
          <circle cx="8" cy="3" r="1.2" />
          <circle cx="8" cy="8" r="1.2" />
          <circle cx="8" cy="13" r="1.2" />
        </svg>
      </button>

      {open && typeof document !== 'undefined' && createPortal(
        <div
          ref={menuRef}
          className="fixed w-36 rounded-card bg-surface-lowest shadow-lg border border-outline-variant/20 py-1 z-[9999] animate-fade-in"
          style={{ top: menuPos.top, left: menuPos.left }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => { onPin(); setOpen(false) }}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-[12.5px] text-ink-secondary hover:text-ink hover:bg-surface-low transition-colors"
          >
            {isPinned ? <IconPinFilled /> : <IconPin />}
            <span>{isPinned ? '取消固定' : '固定'}</span>
          </button>
          <button
            onClick={() => { onRename(); setOpen(false) }}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-[12.5px] text-ink-secondary hover:text-ink hover:bg-surface-low transition-colors"
          >
            <IconPencil />
            <span>重命名</span>
          </button>
          <div className="my-1 border-t border-outline-variant/15" />
          <button
            onClick={() => { void onDelete(); setOpen(false) }}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-[12.5px] text-error hover:bg-error/8 transition-colors"
          >
            <IconTrash />
            <span>删除</span>
          </button>
        </div>,
        document.body
      )}
    </>
  )
}

export function ConversationList({
  currentConversationId,
  runningConversationIds,
  waitingForUserIds,
  onSelectConversation,
  onDeleteConversation,
}: ConversationListProps) {
  const { conversations, deleteConversation, renameConversation, pinConversation, refresh } = useConversations()

  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)

  const prevConvIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (currentConversationId && currentConversationId !== prevConvIdRef.current) {
      prevConvIdRef.current = currentConversationId
      refresh()
    }
  }, [currentConversationId, refresh])

  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus()
      renameInputRef.current.select()
    }
  }, [renamingId])

  const startRename = useCallback((id: string, currentTitle: string) => {
    setRenamingId(id)
    setRenameValue(currentTitle)
  }, [])

  const commitRename = useCallback(async (id: string) => {
    const trimmed = renameValue.trim()
    if (trimmed && trimmed !== conversations.find(c => c.conversation_id === id)?.title) {
      await renameConversation(id, trimmed)
    }
    setRenamingId(null)
  }, [renameValue, renameConversation, conversations])

  const cancelRename = useCallback(() => {
    setRenamingId(null)
  }, [])

  return (
    <div className="pmo-stagger flex flex-col gap-[1px]">
      {deleteError && (
        <div role="alert" className="mx-2 mb-2 flex items-start gap-2 rounded-ctrl border border-error/20 bg-error/8 px-2.5 py-2 text-[11px] leading-relaxed text-error">
          <span className="min-w-0 flex-1">{deleteError}</span>
          <button type="button" aria-label="关闭删除错误" onClick={() => setDeleteError(null)} className="shrink-0 opacity-60 hover:opacity-100">×</button>
        </div>
      )}
      {conversations.map((conv, i) => {
        const isActive = currentConversationId === conv.conversation_id
        const isWaiting = waitingForUserIds.has(conv.conversation_id) || conv._waiting_for_user
        const isRunning = runningConversationIds.has(conv.conversation_id) || conv.is_running
        const isRenaming = renamingId === conv.conversation_id

        return (
          <div
            key={conv.conversation_id}
            data-conversation-id={conv.conversation_id}
            aria-busy={deletingId === conv.conversation_id}
            style={{ '--i': i } as React.CSSProperties}
            className={`pmo-project group ${isActive ? 'current' : ''} ${deletingId === conv.conversation_id ? 'pointer-events-none opacity-50' : ''}`}
            onClick={() => !isRenaming && onSelectConversation(conv.conversation_id)}
          >
            <div className="flex items-center gap-2 min-w-0 flex-1">
              {isWaiting ? (
                <span className="flex-shrink-0 relative flex h-1.5 w-1.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary-container opacity-75" />
                  <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-primary" />
                </span>
              ) : isRunning ? (
                <span className="flex-shrink-0 relative flex h-1.5 w-1.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success/40 opacity-75" />
                  <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-success" />
                </span>
              ) : conv.pinned ? (
                <span className="flex-shrink-0 text-primary/60">
                  <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
                  </svg>
                </span>
              ) : null}

              {isRenaming ? (
                <input
                  ref={renameInputRef}
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onBlur={() => commitRename(conv.conversation_id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); commitRename(conv.conversation_id) }
                    if (e.key === 'Escape') { e.preventDefault(); cancelRename() }
                  }}
                  onClick={(e) => e.stopPropagation()}
                  className="flex-1 min-w-0 bg-surface-low border border-primary/40 rounded-ctrl px-1.5 py-0.5 text-[13px] text-ink outline-none focus:border-primary"
                  style={{ fontFamily: 'var(--font-manrope), Manrope, system-ui', fontVariationSettings: "'wght' 400" }}
                  maxLength={200}
                />
              ) : (
                <span className="pmo-project-name">{conv.title}</span>
              )}
            </div>

            {!isRenaming && (
              <span className="relative flex-shrink-0 inline-flex items-center justify-end" style={{ minWidth: 22 }}>
                <span className="pmo-project-time transition-opacity duration-150 group-hover:opacity-0 pointer-events-none">
                  {relTime(conv.updated_at)}
                </span>
                <span className="absolute right-0 top-1/2 -translate-y-1/2">
                  <RowMenu
                    isPinned={!!conv.pinned}
                    onPin={() => pinConversation(conv.conversation_id, !conv.pinned)}
                    onRename={() => startRename(conv.conversation_id, conv.title)}
                    onDelete={async () => {
                      setDeleteError(null)
                      setDeletingId(conv.conversation_id)
                      const result = await deleteConversation(conv.conversation_id)
                      setDeletingId(null)
                      if (result.ok) onDeleteConversation(conv.conversation_id)
                      else setDeleteError(result.error ?? '删除失败，请重试。')
                    }}
                  />
                </span>
              </span>
            )}
          </div>
        )
      })}
      {conversations.length === 0 && (
        <div className="px-3 py-2 text-[10px] text-ink-muted tracking-wider">
          暂无项目
        </div>
      )}
    </div>
  )
}
