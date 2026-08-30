'use client'
/** @jsxRuntime automatic */

import { Children, isValidElement, type ReactNode } from 'react'
import ReactMarkdown, { type Components, type UrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeRaw from 'rehype-raw'
import rehypeKatex from 'rehype-katex'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import {
  classifyScientificImageSource,
  safeHttpUrl,
} from './literature-paper-model'
import {
  ScientificFigureCluster,
  ScientificFigureImage,
  isScientificFigureCluster,
} from './ScientificFigure'
import { rehypeScientificFigures } from './rehype-scientific-figures'

interface ScientificMarkdownProps {
  content: string
  conversationId: string | null
  sourcePath: string
  variant?: 'article' | 'front-matter'
}

/*
 * Raw publisher tables are useful, but their HTML is untrusted. Sanitize it
 * before KaTeX runs; KaTeX then turns only remark-math nodes into its own
 * deterministic HTML/MathML tree. The code class allow-list is the documented
 * rehype-sanitize bridge for remark-math → rehype-katex.
 */
export const scientificMarkdownSanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), 'figure', 'figcaption'],
  attributes: {
    ...defaultSchema.attributes,
    code: [
      ...(defaultSchema.attributes?.code ?? []),
      ['className', /^language-./, 'math-inline', 'math-display'],
    ],
    table: [
      ...(defaultSchema.attributes?.table ?? []),
      ['className', 'table', 'table-striped'],
    ],
    td: [
      ...(defaultSchema.attributes?.td ?? []),
      'rowSpan',
      'colSpan',
      ['align', 'left', 'center', 'right', 'justify', 'char'],
    ],
    th: [
      ...(defaultSchema.attributes?.th ?? []),
      'rowSpan',
      'colSpan',
      ['align', 'left', 'center', 'right', 'justify', 'char'],
    ],
    figure: [
      ...(defaultSchema.attributes?.figure ?? []),
      ['className', 'figure', 'image'],
    ],
    figcaption: [...(defaultSchema.attributes?.figcaption ?? [])],
  },
}

function scientificLink(rawHref: string | undefined): string | undefined {
  if (!rawHref) return undefined
  if (rawHref.startsWith('#') && !rawHref.startsWith('#/')) return rawHref
  return safeHttpUrl(rawHref)
}

function ExternalImageNotice({ source, alt }: { source: string; alt?: string }) {
  return (
    <span className="my-5 flex min-h-20 flex-col items-center justify-center rounded-lg border border-dashed border-outline-variant/25 bg-surface-low/55 px-4 py-3 text-center not-prose">
      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-surface-lowest text-ink-faint" aria-hidden="true">
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="m2.25 15.75 5.16-5.16a2.25 2.25 0 0 1 3.18 0l5.16 5.16m-1.5-1.5 1.41-1.41a2.25 2.25 0 0 1 3.18 0l2.91 2.91M3.75 19.5h16.5A1.5 1.5 0 0 0 21.75 18V6A1.5 1.5 0 0 0 20.25 4.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-10.125h.008v.008h-.008v-.008Z" />
        </svg>
      </span>
      <span className="mt-2 text-xs font-medium text-ink-secondary">外部图像未自动加载</span>
      {alt && <span className="mt-1 max-w-xl text-[11px] leading-5 text-ink-muted">{alt}</span>}
      <a
        href={source}
        target="_blank"
        rel="noreferrer"
        className="mt-2 text-[11px] font-semibold text-primary underline decoration-primary/25 underline-offset-4 hover:decoration-primary"
      >
        在来源站点打开图像
      </a>
    </span>
  )
}

function BlockedImageNotice({ alt }: { alt?: string }) {
  return (
    <span className="my-5 block rounded-lg border border-dashed border-outline-variant/25 bg-surface-low/45 px-4 py-3 text-center text-[11px] leading-5 text-ink-muted not-prose">
      {alt ? `图像：${alt}` : '该图像引用无法安全加载'}
    </span>
  )
}

function plainNodeText(value: ReactNode): string {
  return Children.toArray(value).map(child => {
    if (typeof child === 'string' || typeof child === 'number') return String(child)
    if (isValidElement<{ children?: ReactNode }>(child)) return plainNodeText(child.props.children)
    return ''
  }).join('').replace(/\s+/g, ' ').trim()
}

function sectionHeadingClass(children: ReactNode): string {
  const label = plainNodeText(children)
  if (/^(abstract|summary)\b/i.test(label)) {
    return 'mb-3 mt-8 border-y border-outline-variant/25 py-2.5 text-[0.94rem] font-semibold uppercase leading-[1.35] tracking-[0.055em] text-ink first:mt-0'
  }
  if (/^\d+(?:\.\d+)+\b/.test(label)) {
    return 'mb-2 mt-6 text-[0.96rem] font-semibold leading-[1.4] tracking-[-0.008em] text-ink first:mt-0'
  }
  return 'mb-3 mt-9 border-b border-outline-variant/18 pb-2 text-[1.12rem] font-semibold leading-[1.34] tracking-[-0.012em] text-ink first:mt-0 sm:text-[1.16rem]'
}

function createComponents(
  conversationId: string | null,
  sourcePath: string,
  variant: 'article' | 'front-matter',
): Components {
  const compact = variant === 'front-matter'
  return {
    // PaperHeader owns the document H1. Provider H1s are article sections.
    h1: ({ children }) => plainNodeText(children)
      ? <h2 className={`font-sans ${compact ? 'mb-2 mt-4 text-[13px] font-semibold leading-5 text-ink' : sectionHeadingClass(children)}`}>{children}</h2>
      : null,
    h2: ({ children }) => plainNodeText(children)
      ? <h3 className={`font-sans ${compact ? 'mb-1.5 mt-3 text-[12px] font-semibold leading-5 text-ink-secondary' : 'mb-2 mt-6 text-[0.96rem] font-semibold leading-[1.4] tracking-[-0.008em] text-ink first:mt-0'}`}>{children}</h3>
      : null,
    h3: ({ children }) => plainNodeText(children)
      ? <h4 className={`font-sans ${compact ? 'mb-1 mt-3 text-[11.5px] font-semibold leading-5 text-ink-secondary' : 'mb-2 mt-5 text-[0.88rem] font-semibold leading-[1.42] text-ink'}`}>{children}</h4>
      : null,
    h4: ({ children }) => plainNodeText(children)
      ? <h5 className="mb-1.5 mt-5 font-sans text-[0.76rem] font-semibold uppercase leading-[1.45] tracking-[0.045em] text-ink-secondary">{children}</h5>
      : null,
    h5: ({ children }) => plainNodeText(children)
      ? <h6 className="mb-1 mt-4 font-sans text-[0.74rem] font-semibold leading-[1.45] text-ink-secondary">{children}</h6>
      : null,
    h6: ({ children }) => plainNodeText(children)
      ? <h6 className="mb-1 mt-4 font-sans text-[0.72rem] font-semibold leading-[1.45] text-ink-secondary">{children}</h6>
      : null,
    p: ({ children }) => compact
      ? <p className="my-1.5 break-words text-[11.5px] leading-[1.58] text-ink-muted">{children}</p>
      : <p className="my-[0.72em] break-words text-[13.5px] leading-[1.7] text-ink sm:text-[14px]">{children}</p>,
    a: ({ href, children }) => {
      const safeHref = scientificLink(href)
      if (!safeHref) return <span className="text-ink-secondary">{children}</span>
      const external = safeHref.startsWith('http://') || safeHref.startsWith('https://')
      return (
        <a
          href={safeHref}
          target={external ? '_blank' : undefined}
          rel={external ? 'noreferrer' : undefined}
          className="font-medium text-primary underline decoration-primary/25 underline-offset-[3px] transition hover:decoration-primary"
        >
          {children}
        </a>
      )
    },
    blockquote: ({ children }) => (
      <blockquote className="my-5 border-l-2 border-primary/40 px-4 py-0.5 text-[13px] leading-[1.7] text-ink-secondary [&>p]:italic">{children}</blockquote>
    ),
    ul: ({ children }) => <ul className="my-3.5 list-disc space-y-1 pl-5 text-[13.5px] leading-[1.65] text-ink-secondary marker:text-primary/55 sm:text-[14px]">{children}</ul>,
    ol: ({ children }) => <ol className="my-3.5 list-decimal space-y-1 pl-5 text-[13.5px] leading-[1.65] text-ink-secondary marker:font-mono marker:text-primary/65 sm:text-[14px]">{children}</ol>,
    li: ({ children }) => <li className="pl-0.5 [&>p]:my-0">{children}</li>,
    hr: () => <hr className="my-7 border-0 border-t border-outline-variant/18" />,
    pre: ({ children }) => <pre className="my-5 overflow-auto rounded-lg border border-outline-variant/15 bg-surface-low px-4 py-3 font-mono text-[11px] leading-5 text-ink-secondary">{children}</pre>,
    code: ({ className, children }) => {
      const isMath = className?.includes('math-') || className?.includes('language-math')
      if (isMath) return <code className={className}>{children}</code>
      return <code className="rounded-md bg-surface-low px-1.5 py-0.5 font-mono text-[0.86em] text-ink">{children}</code>
    },
    table: ({ children }) => (
      <div
        className="my-6 overflow-x-auto border-y border-outline-variant/22 bg-surface-lowest not-prose focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35"
        role="region"
        aria-label="论文表格，可横向滚动"
        tabIndex={0}
      >
        <table className="w-full min-w-[30rem] border-collapse text-left text-[11.5px] leading-[1.48] text-ink-secondary">{children}</table>
      </div>
    ),
    caption: ({ children }) => <caption className="caption-top px-0 pb-2 text-left text-[11.5px] font-medium leading-[1.55] text-ink-secondary">{children}</caption>,
    thead: ({ children }) => <thead className="border-b border-outline-variant/25 bg-surface-low/70 font-semibold text-ink">{children}</thead>,
    tbody: ({ children }) => <tbody className="divide-y divide-outline-variant/12">{children}</tbody>,
    tr: ({ children }) => <tr>{children}</tr>,
    th: ({ children, colSpan, rowSpan }) => <th colSpan={colSpan} rowSpan={rowSpan} className="px-3 py-2.5 align-bottom font-semibold">{children}</th>,
    td: ({ children, colSpan, rowSpan }) => <td colSpan={colSpan} rowSpan={rowSpan} className="px-3 py-2.5 align-top">{children}</td>,
    figure: ({ children, className }) => isScientificFigureCluster(className)
      ? <ScientificFigureCluster>{children}</ScientificFigureCluster>
      : <figure className="my-6 not-prose">{children}</figure>,
    figcaption: ({ children }) => <figcaption className="mx-auto mt-2.5 max-w-[72ch] text-left text-[11px] leading-[1.55] text-ink-muted">{children}</figcaption>,
    img: ({ src, alt }) => {
      const image = classifyScientificImageSource(
        typeof src === 'string' ? src : undefined,
        conversationId,
        sourcePath,
      )
      if (image.kind === 'external') return <ExternalImageNotice source={image.url} alt={alt} />
      if (image.kind === 'blocked') return <BlockedImageNotice alt={alt} />
      return (
        <ScientificFigureImage src={image.url} alt={alt} />
      )
    },
    strong: ({ children }) => <strong className="font-semibold text-ink">{children}</strong>,
    em: ({ children }) => <em className="italic text-ink-secondary">{children}</em>,
    sup: ({ children }) => <sup className="text-[0.72em] leading-none">{children}</sup>,
    sub: ({ children }) => <sub className="text-[0.72em] leading-none">{children}</sub>,
  }
}

export function ScientificMarkdown({
  content,
  conversationId,
  sourcePath,
  variant = 'article',
}: ScientificMarkdownProps) {
  const components = createComponents(conversationId, sourcePath, variant)
  const urlTransform: UrlTransform = (url, key) => {
    if (key === 'src') {
      const image = classifyScientificImageSource(url, conversationId, sourcePath)
      // Keep the validated provider-owned ref until the custom image renderer;
      // that renderer replaces it with the same-origin proxy URL. Returning the
      // proxy here would cause it to be classified a second time as user input.
      return image.kind === 'blocked' ? null : url
    }
    if (key === 'href') return scientificLink(url) ?? null
    return null
  }

  return (
    <div
      className={`scientific-markdown mx-auto text-ink [text-rendering:optimizeLegibility] [&_.katex]:text-[0.98em] [&_.katex-display]:my-5 [&_.katex-display]:overflow-x-auto [&_.katex-display]:overflow-y-hidden [&_.katex-display]:py-1 ${variant === 'front-matter' ? 'max-w-none' : 'max-w-[72ch]'}`}
      data-testid="scientific-markdown"
      data-variant={variant}
      style={{
        fontFamily: '"Iowan Old Style", "Palatino Linotype", Palatino, "Noto Serif SC", "Songti SC", STSong, Georgia, serif',
        fontKerning: 'normal',
        fontVariantNumeric: 'lining-nums proportional-nums',
        hyphens: 'auto',
      }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[
          rehypeRaw,
          [rehypeSanitize, scientificMarkdownSanitizeSchema],
          rehypeScientificFigures,
          [rehypeKatex, { strict: false, throwOnError: false, output: 'htmlAndMathml' }],
        ]}
        components={components}
        urlTransform={urlTransform}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}

export function ScientificMarkdownAside({ children }: { children: ReactNode }) {
  return (
    <aside className="rounded-lg border border-outline-variant/15 bg-surface-low/50 px-3.5 py-2.5 text-[11px] leading-[1.65] text-ink-muted">
      {children}
    </aside>
  )
}
