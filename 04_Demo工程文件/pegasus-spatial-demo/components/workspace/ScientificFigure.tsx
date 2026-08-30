'use client'
/** @jsxRuntime automatic */

import {
  Children,
  createContext,
  isValidElement,
  useContext,
  useState,
  type ReactNode,
  type SyntheticEvent,
} from 'react'
import { SCIENTIFIC_FIGURE_CLUSTER_CLASS } from './rehype-scientific-figures'

type IntrinsicShape = 'pending' | 'narrow' | 'portrait' | 'balanced' | 'wide'

const FigureDensityContext = createContext<'single' | 'cluster'>('single')

export function isScientificFigureCluster(className: string | undefined): boolean {
  return className?.split(/\s+/).includes(SCIENTIFIC_FIGURE_CLUSTER_CLASS) ?? false
}

export function classifyScientificFigureShape(width: number, height: number): IntrinsicShape {
  if (!(width > 0) || !(height > 0)) return 'pending'
  const ratio = width / height
  if (ratio <= 0.42) return 'narrow'
  if (ratio < 0.8) return 'portrait'
  if (ratio >= 2.6) return 'wide'
  return 'balanced'
}

function visibleCaption(alt: string | undefined): string | undefined {
  const caption = alt?.replace(/\s+/g, ' ').trim()
  if (!caption) return undefined
  if (/^(?:https?:\/\/|\/?[^\s]+\/)[^\s]+\.(?:avif|gif|jpe?g|png|webp)(?:[?#][^\s]*)?$/i.test(caption)) return undefined
  return caption
}

export function ScientificFigureCluster({ children }: { children: ReactNode }) {
  const count = Children.toArray(children).filter(isValidElement).length
  const clustered = count > 1
  return (
    <FigureDensityContext.Provider value={clustered ? 'cluster' : 'single'}>
      <figure
        className={`my-6 grid min-w-0 grid-cols-1 items-start justify-items-center gap-x-4 gap-y-5 not-prose sm:my-7 ${clustered ? 'sm:grid-cols-2' : 'mx-auto max-w-[46rem]'} ${clustered && count % 2 === 1 ? '[&>[data-scientific-figure-panel]:last-child]:sm:col-span-2' : ''}`}
        data-scientific-figure-cluster=""
        data-scientific-figure-count={count}
        aria-label={clustered ? `论文组合图，共 ${count} 个图版` : undefined}
      >
        {children}
      </figure>
    </FigureDensityContext.Provider>
  )
}

export function ScientificFigureImage({ src, alt }: { src: string; alt?: string }) {
  const density = useContext(FigureDensityContext)
  const [shape, setShape] = useState<IntrinsicShape>('pending')
  const caption = visibleCaption(alt)
  const onLoad = (event: SyntheticEvent<HTMLImageElement>) => {
    const image = event.currentTarget
    setShape(classifyScientificFigureShape(image.naturalWidth, image.naturalHeight))
  }

  return (
    <span
      className="flex min-w-0 max-w-full flex-col items-center justify-self-center data-[shape=narrow]:w-fit data-[shape=narrow]:max-w-[10rem] data-[shape=wide]:w-full data-[shape=wide]:sm:col-span-2"
      data-scientific-figure-panel=""
      data-shape={shape}
    >
      {/* Dynamic literature resources are integrity-checked by the same-origin proxy. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={caption ?? '论文图像'}
        loading="lazy"
        decoding="async"
        onLoad={onLoad}
        data-scientific-image=""
        className={`block h-auto w-auto max-w-full rounded-[2px] border border-outline-variant/12 bg-white object-contain ${density === 'cluster' ? 'max-h-[min(58svh,28rem)]' : 'max-h-[min(68svh,36rem)]'}`}
      />
      {caption && (
        <span className="mt-2 block max-w-[64ch] text-left font-sans text-[10.5px] leading-[1.5] text-ink-muted">
          {caption}
        </span>
      )}
    </span>
  )
}
