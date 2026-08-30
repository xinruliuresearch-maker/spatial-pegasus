'use client'

import { useState, useEffect, useRef } from 'react'

interface FeedbackDialogProps {
  open: boolean
  onClose: () => void
}

export function FeedbackDialog({ open, onClose }: FeedbackDialogProps) {
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (open) {
      setContent('')
      setSubmitted(false)
      setTimeout(() => textareaRef.current?.focus(), 100)
    }
  }, [open])

  // Close on Escape
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, onClose])

  const handleSubmit = async () => {
    if (!content.trim() || loading) return
    setLoading(true)
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: content.trim(),
          page_url: window.location.pathname,
        }),
      })
      if (res.ok) {
        setSubmitted(true)
        setTimeout(onClose, 1500)
      }
    } catch { /* ignore */ } finally {
      setLoading(false)
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />

      {/* Dialog */}
      <div className="relative w-full max-w-md mx-4 rounded-glass bg-[var(--glass-panel-bg)] backdrop-blur-[24px] backdrop-saturate-150 border border-[var(--glass-panel-border)] shadow-[var(--shadow-glass)] p-6 animate-fade-in">
        {submitted ? (
          <div className="text-center py-8">
            <div className="w-12 h-12 rounded-full bg-success/10 flex items-center justify-center mx-auto mb-4">
              <svg className="w-6 h-6 text-success" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
              </svg>
            </div>
            <p className="text-ink font-medium">感谢你的反馈！</p>
          </div>
        ) : (
          <>
            <h2 className="text-lg font-semibold text-ink mb-4">发送反馈</h2>
            <textarea
              ref={textareaRef}
              value={content}
              onChange={e => setContent(e.target.value)}
              placeholder="告诉我们你的想法、建议或遇到的问题..."
              rows={5}
              className="w-full rounded-card bg-surface-low px-4 py-3 text-sm text-ink placeholder-ink-muted focus:outline-none ghost-border pmo-field-focus transition-all resize-none"
            />
            <div className="flex justify-end gap-3 mt-4">
              <button
                onClick={onClose}
                className="px-4 py-2 rounded-ctrl text-sm text-ink-secondary hover:text-ink hover:bg-surface-low transition-all"
              >
                取消
              </button>
              <button
                onClick={handleSubmit}
                disabled={loading || !content.trim()}
                className="px-5 py-2 rounded-ctrl text-sm font-medium text-on-primary disabled:opacity-40 transition-all"
                style={{ background: 'linear-gradient(135deg, var(--primary), var(--primary-container))' }}
              >
                {loading ? '提交中...' : '提交'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
