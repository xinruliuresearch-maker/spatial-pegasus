'use client'

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'

interface PanelResizeHandleProps {
  edge: 'left' | 'right'
  label: string
  value: number
  min: number
  max: number
  onChange: (value: number) => void
  onReset: () => void
}

const KEYBOARD_STEP = 12

export function PanelResizeHandle({ edge, label, value, min, max, onChange, onReset }: PanelResizeHandleProps) {
  const dragRef = useRef<{ pointerId: number; startX: number; startValue: number } | null>(null)
  const [active, setActive] = useState(false)
  const direction = edge === 'right' ? 1 : -1

  const finishResize = () => {
    dragRef.current = null
    setActive(false)
    delete document.documentElement.dataset.panelResizing
  }

  useEffect(() => () => { delete document.documentElement.dataset.panelResizing }, [])

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    event.preventDefault()
    event.currentTarget.focus()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startValue: value }
    setActive(true)
    document.documentElement.dataset.panelResizing = 'true'
  }

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    onChange(drag.startValue + (event.clientX - drag.startX) * direction)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    let nextValue: number | null = null
    if (event.key === 'ArrowLeft') nextValue = value - KEYBOARD_STEP * direction
    if (event.key === 'ArrowRight') nextValue = value + KEYBOARD_STEP * direction
    if (event.key === 'Home') nextValue = min
    if (event.key === 'End') nextValue = max
    if (nextValue === null) return
    event.preventDefault()
    onChange(nextValue)
  }

  return (
    <div
      data-resize-edge={edge}
      data-active={active ? 'true' : 'false'}
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      tabIndex={0}
      title={`${label}。拖动或使用方向键调整，双击恢复默认宽度`}
      className="pmo-panel-resize-handle"
      onDoubleClick={onReset}
      onKeyDown={handleKeyDown}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishResize}
      onPointerCancel={finishResize}
      onLostPointerCapture={finishResize}
    ><span aria-hidden="true" /></div>
  )
}
