'use client'

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
} from 'react'

interface FlowingLightFrameProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode
}

const SEGMENTS = 33

/** A resize-aware light ribbon that follows the composer perimeter. */
export function FlowingLightFrame({ children, className = '', ...props }: FlowingLightFrameProps) {
  const frameRef = useRef<HTMLDivElement>(null)
  const [metrics, setMetrics] = useState({ width: 1, height: 1, perimeter: 1 })

  useEffect(() => {
    const frame = frameRef.current
    if (!frame) return

    const update = () => {
      const { width, height } = frame.getBoundingClientRect()
      const radius = Math.min(16, width / 2, height / 2)
      const perimeter = Math.max(1, 2 * (width + height - 4 * radius) + 2 * Math.PI * radius)
      frame.style.setProperty('--pmo-flow-duration', `${Math.min(15, Math.max(10, perimeter / 230)).toFixed(2)}s`)
      setMetrics(current => {
        const next = { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)), perimeter }
        return current.width === next.width && current.height === next.height && Math.abs(current.perimeter - perimeter) < 0.5
          ? current
          : next
      })
    }

    update()
    const observer = new ResizeObserver(update)
    observer.observe(frame)
    return () => observer.disconnect()
  }, [])

  const inset = 3
  const width = Math.max(0, metrics.width - inset * 2)
  const height = Math.max(0, metrics.height - inset * 2)
  const radius = Math.min(14, width / 2, height / 2)
  const ribbonLength = Math.min(820, Math.max(360, metrics.perimeter * 0.38))
  const stride = ribbonLength / (SEGMENTS - 1)

  return (
    <div ref={frameRef} className={`pmo-flowing-light ${className}`} {...props}>
      <svg className="pmo-flowing-light__path" viewBox={`0 0 ${metrics.width} ${metrics.height}`} preserveAspectRatio="none" aria-hidden="true">
        {Array.from({ length: SEGMENTS }, (_, index) => {
          const axis = Math.floor(SEGMENTS / 2)
          const falloff = Math.max(0, 1 - Math.abs(index - axis) / axis)
          const segmentLength = Math.min(metrics.perimeter, Math.max(4, stride * 2.5))
          const style = {
            '--pmo-flow-offset': `${-(index * stride).toFixed(2)}px`,
            '--pmo-flow-end': `${-(index * stride + metrics.perimeter).toFixed(2)}px`,
            '--pmo-flow-dash': `${segmentLength.toFixed(2)}px`,
            '--pmo-flow-gap': `${Math.max(1, metrics.perimeter - segmentLength).toFixed(2)}px`,
            '--pmo-flow-opacity': (0.72 * falloff).toFixed(4),
            '--pmo-flow-width': `${(1.5 + falloff * 1.8).toFixed(2)}px`,
          } as CSSProperties

          return (
            <rect
              key={index}
              className="pmo-flowing-light__segment"
              x={inset}
              y={inset}
              width={width}
              height={height}
              rx={radius}
              pathLength={metrics.perimeter}
              style={style}
            />
          )
        })}
      </svg>
      {children}
    </div>
  )
}
