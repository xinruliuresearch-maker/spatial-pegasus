'use client'

import { useMemo, type ReactNode } from 'react'
import type { WorkspaceArtifact } from '@/hooks/useWorkspaceArtifacts'
import { useGridFSContent } from '@/hooks/useGridFSContent'
import { ShimmerBlock } from '@/components/loading/Skeleton'
import {
  collectLiteratureBundleArtifacts,
  extractDoiFromMarkdown,
  extractFirstMarkdownHeading,
  parseLiteratureArtifactPath,
  parseLiteratureMetadata,
  parseLiteratureProvenance,
  resolvePaperTitle,
  safeHttpUrl,
  splitScientificFrontMatter,
  stripFirstMarkdownHeading,
  type LiteratureArtifactRole,
  type LiteraturePaperMetadata,
  type LiteratureProvenance,
} from './literature-paper-model'
import { ScientificMarkdown, ScientificMarkdownAside } from './ScientificMarkdown'

export interface LiteraturePaperReaderProps {
  activeArtifact: WorkspaceArtifact
  content: string
  allArtifacts: readonly WorkspaceArtifact[]
  conversationId: string | null
  setActivePath: (path: string) => void
  onQuoteSelection?: (selection: { path: string; content: string }) => void
}

interface ReaderTab {
  path: string
  label: string
  role: LiteratureArtifactRole
}

function artifactContent(
  artifact: WorkspaceArtifact | undefined,
  activeArtifact: WorkspaceArtifact,
  activeContent: string,
  lazyContent: string,
): string {
  if (!artifact) return ''
  if (artifact.path === activeArtifact.path) return activeContent
  return artifact.content || lazyContent
}

function formatDate(value: string | undefined): string | undefined {
  if (!value) return undefined
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(date)
}

function formatBytes(value: number | undefined): string | undefined {
  if (value == null || !Number.isFinite(value)) return undefined
  if (value < 1_024) return `${value} B`
  if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(1)} KB`
  return `${(value / (1_024 * 1_024)).toFixed(1)} MB`
}

function doiUrl(doi: string | undefined): string | undefined {
  if (!doi) return undefined
  const direct = safeHttpUrl(doi)
  if (direct) return direct
  const normalized = doi.replace(/^doi:\s*/i, '').trim()
  if (!normalized || /[\u0000-\u001f\u007f]/.test(normalized)) return undefined
  return `https://doi.org/${encodeURI(normalized)}`
}

function sourceUrl(
  metadata: LiteraturePaperMetadata | null,
  provenance: LiteratureProvenance | null,
  artifact: WorkspaceArtifact,
): string | undefined {
  return metadata?.landingUrl
    ?? provenance?.landingUrl
    ?? provenance?.canonicalUrl
    ?? safeHttpUrl(artifact.source?.canonical_url)
}

function readerLabel(role: LiteratureArtifactRole, source: 'sciverse' | 'arxiv'): string {
  if (role === 'original-pdf') return '原始 PDF'
  if (role === 'metadata') return '论文信息'
  if (role === 'provenance') return '来源记录'
  if (role === 'source-fulltext') return source === 'sciverse' ? '论文阅读版' : '全文'
  if (role === 'parsed-fulltext') return '可检索正文'
  return '技术附件'
}

function ReaderTabs({
  tabs,
  activePath,
  onSelect,
}: {
  tabs: readonly ReaderTab[]
  activePath: string
  onSelect: (path: string) => void
}) {
  if (tabs.length <= 1) return null
  return (
    <nav aria-label="文献视图" className="flex flex-wrap items-center gap-1 rounded-xl border border-outline-variant/12 bg-surface-low/70 p-1">
      {tabs.map(tab => {
        const selected = tab.path === activePath
        return (
          <button
            key={tab.path}
            type="button"
            aria-current={selected ? 'page' : undefined}
            onClick={() => onSelect(tab.path)}
            className={`rounded-lg px-3 py-1.5 text-[11px] font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${selected ? 'bg-surface-lowest text-primary shadow-sm' : 'text-ink-muted hover:bg-surface-lowest/70 hover:text-ink'}`}
          >
            {tab.label}
          </button>
        )
      })}
    </nav>
  )
}

function PaperHeader({
  source,
  role,
  title,
  metadata,
  provenance,
  sourceHref,
  tabs,
  activePath,
  onSelect,
}: {
  source: 'sciverse' | 'arxiv'
  role: LiteratureArtifactRole
  title: string
  metadata: LiteraturePaperMetadata | null
  provenance: LiteratureProvenance | null
  sourceHref?: string
  tabs: readonly ReaderTab[]
  activePath: string
  onSelect: (path: string) => void
}) {
  const year = metadata?.publishedYear
    ?? (metadata?.publishedAt ? new Date(metadata.publishedAt).getUTCFullYear() : undefined)
  const publication = [metadata?.venue, Number.isFinite(year) ? year : undefined]
    .filter(Boolean)
    .join(' · ')
  const safeDoiHref = doiUrl(metadata?.doi)
  const renderedRole = role === 'source-fulltext'
    ? 'STRUCTURED FULL TEXT'
    : role === 'parsed-fulltext'
      ? 'PARSED FULL TEXT'
      : role === 'original-pdf'
        ? 'ORIGINAL PDF'
        : 'PAPER RECORD'
  const visibleAuthors = metadata?.authors.slice(0, 8) ?? []
  const remainingAuthorRecords = Math.max(0, (metadata?.authors.length ?? 0) - visibleAuthors.length)

  return (
    <header className="border-b border-outline-variant/15 bg-[color-mix(in_srgb,var(--surface-container-lowest)_92%,var(--primary)_2%)] px-5 py-5 sm:px-8 sm:py-6">
      <div className="mx-auto max-w-[820px]">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-primary/9 px-2.5 py-1 font-mono text-[9px] font-bold tracking-[0.12em] text-primary">
              {source.toUpperCase()}
            </span>
            <span className="font-mono text-[9px] font-semibold tracking-[0.1em] text-ink-faint">{renderedRole}</span>
          </div>
          {sourceHref && (
            <a
              href={sourceHref}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg border border-outline-variant/18 px-3 py-1.5 text-[11px] font-semibold text-ink-muted transition hover:bg-surface-low hover:text-ink"
            >
              查看出版来源
              <svg className="h-3 w-3" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6.25 3.25h-3v9.5h9.5v-3m-5-6.5h5v5m0-5-6 6" />
              </svg>
            </a>
          )}
        </div>

        <h1 className="mt-4 max-w-[44ch] text-balance text-[clamp(1.3rem,2.2vw,1.85rem)] font-semibold leading-[1.26] tracking-[-0.022em] text-ink">
          {title}
        </h1>
        {metadata?.authors.length ? (
          <p className="mt-3 max-w-[90ch] text-[12px] leading-6 text-ink-secondary">
            {visibleAuthors.join(' · ')}
            {remainingAuthorRecords > 0 && <span className="text-ink-muted"> · 另有 {remainingAuthorRecords} 条作者记录</span>}
          </p>
        ) : null}
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-ink-muted">
          {publication && <span>{publication}</span>}
          {metadata?.doi && (safeDoiHref ? (
            <a href={safeDoiHref} target="_blank" rel="noreferrer" className="font-mono text-primary hover:underline">DOI {metadata.doi}</a>
          ) : (
            <span className="font-mono">DOI {metadata.doi}</span>
          ))}
          {metadata?.citationCount != null && <span>被引 {metadata.citationCount.toLocaleString()}</span>}
          {metadata?.influentialCitationCount != null && <span>高影响力被引 {metadata.influentialCitationCount.toLocaleString()}</span>}
          {provenance?.retrievedAt && <span>获取于 {formatDate(provenance.retrievedAt)}</span>}
        </div>

        <div className="mt-5">
          <ReaderTabs tabs={tabs} activePath={activePath} onSelect={onSelect} />
        </div>
      </div>
    </header>
  )
}

function StructuredFulltextView({
  source,
  content,
  sourcePath,
  conversationId,
  onQuoteSelection,
}: {
  source: 'sciverse' | 'arxiv'
  content: string
  sourcePath: string
  conversationId: string | null
  onQuoteSelection?: (selection: { path: string; content: string }) => void
}) {
  const titleStrippedBody = extractFirstMarkdownHeading(content) ? stripFirstMarkdownHeading(content) : content
  const sections = source === 'sciverse'
    ? splitScientificFrontMatter(titleStrippedBody)
    : { body: titleStrippedBody, frontMatter: undefined }
  const captureSelection = () => {
    const selected = window.getSelection()?.toString().trim()
    if (!selected || !onQuoteSelection) return
    onQuoteSelection({ path: sourcePath, content: selected })
    window.getSelection()?.removeAllRanges()
  }

  return (
    <main className="bg-[color-mix(in_srgb,var(--surface-container-low)_70%,transparent)] px-2 py-3 sm:px-4 sm:py-5 lg:px-6">
      <article className="mx-auto max-w-[820px] rounded-none border-y border-outline-variant/12 bg-surface-lowest px-5 py-5 shadow-none sm:rounded-[6px] sm:border sm:px-8 sm:py-8 sm:shadow-[0_8px_32px_rgba(40,48,64,0.035)] lg:px-12 lg:py-10">
        <div className="mx-auto max-w-[72ch]">
          <ScientificMarkdownAside>
            {source === 'sciverse' ? (
              <><strong className="font-semibold text-ink-secondary">结构化全文 · 重排版</strong>：正文、章节、公式、表格和可用图像由 Sciverse 数据重新组织，便于屏幕阅读与检索；这不是出版商 PDF，也不保留原始分页。</>
            ) : (
              <><strong className="font-semibold text-ink-secondary">PDF 解析正文</strong>：文本由本地解析器生成，适合检索和引用；页码、双栏与视觉布局请以“原始 PDF”为准。</>
            )}
          </ScientificMarkdownAside>
          {sections.frontMatter && (
            <details
              className="group mt-3 border-y border-outline-variant/16 bg-surface-lowest"
              data-testid="publisher-front-matter"
            >
              <summary className="flex cursor-pointer list-none items-center gap-2 py-2 font-sans text-[10.5px] font-semibold tracking-[0.015em] text-ink-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35 [&::-webkit-details-marker]:hidden">
                <svg className="h-3 w-3 shrink-0 transition-transform group-open:rotate-90" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" d="m6 3.5 4 4.5-4 4.5" />
                </svg>
                原文署名与出版信息
                <span className="font-normal text-ink-faint">作者、单位及收稿/出版记录</span>
              </summary>
              <div className="border-t border-outline-variant/12 pb-2 pt-2.5">
                <ScientificMarkdown
                  content={sections.frontMatter}
                  conversationId={conversationId}
                  sourcePath={sourcePath}
                  variant="front-matter"
                />
              </div>
            </details>
          )}
        </div>
        <div className="mt-5 sm:mt-6" onMouseUp={captureSelection}>
          <ScientificMarkdown content={sections.body} conversationId={conversationId} sourcePath={sourcePath} />
        </div>
      </article>
    </main>
  )
}

function OriginalPdfView({ artifact, conversationId }: {
  artifact: WorkspaceArtifact
  conversationId: string | null
}) {
  if (!conversationId || !artifact.sha256) {
    return <ReaderMessage title="原始 PDF 暂时无法打开">文件缺少可验证的版本标识，请重新获取这篇论文。</ReaderMessage>
  }
  const baseUrl = `/api/conversations/${encodeURIComponent(conversationId)}/files/binary?path=${encodeURIComponent(artifact.path)}&v=${encodeURIComponent(artifact.sha256)}`
  return (
    <main className="flex min-h-[700px] flex-1 flex-col bg-[#e8e9eb]">
      <div className="flex shrink-0 items-center justify-between border-b border-black/10 bg-surface-lowest px-5 py-2.5 text-[11px] text-ink-muted">
        <span>原始文件 · {formatBytes(artifact.sizeBytes) ?? '大小未知'}</span>
        <a href={`${baseUrl}&download=1`} className="rounded-lg bg-primary px-3 py-1.5 font-semibold text-on-primary transition hover:opacity-90">下载 PDF</a>
      </div>
      <iframe src={baseUrl} title={artifact.filename ?? artifact.label} className="min-h-[680px] flex-1 border-0 bg-white" />
    </main>
  )
}

function DefinitionList({ children }: { children: ReactNode }) {
  return <dl className="grid gap-x-8 gap-y-0 sm:grid-cols-2">{children}</dl>
}

function Definition({ label, children, wide = false }: {
  label: string
  children: ReactNode
  wide?: boolean
}) {
  return (
    <div className={`border-b border-outline-variant/12 py-4 ${wide ? 'sm:col-span-2' : ''}`}>
      <dt className="font-mono text-[9px] font-bold uppercase tracking-[0.11em] text-ink-faint">{label}</dt>
      <dd className="mt-1.5 break-words text-[13px] leading-6 text-ink-secondary">{children}</dd>
    </div>
  )
}

function ExternalValue({ href, children }: { href: string | undefined; children: ReactNode }) {
  return href ? (
    <a href={href} target="_blank" rel="noreferrer" className="text-primary underline decoration-primary/25 underline-offset-4 hover:decoration-primary">{children}</a>
  ) : <>{children}</>
}

function MetadataView({ metadata, identityLabel }: {
  metadata: LiteraturePaperMetadata | null
  identityLabel: string
}) {
  if (!metadata) return <ReaderMessage title="论文信息无法解析">元数据不存在或格式不受支持。正文文件仍可继续阅读。</ReaderMessage>
  const ref = metadata.ref
  return (
    <RecordPage title="论文信息" description="从保存的文献元数据中整理；字段为空时不会推断或补写。">
      <DefinitionList>
        <Definition label="Title" wide>{metadata.title ?? '未提供'}</Definition>
        <Definition label="Authors" wide>{metadata.authors.length ? metadata.authors.join(' · ') : '未提供'}</Definition>
        <Definition label="Venue">{metadata.venue ?? '未提供'}</Definition>
        <Definition label="Publication">{[metadata.publishedYear, formatDate(metadata.publishedAt)].filter(Boolean).join(' · ') || '未提供'}</Definition>
        <Definition label="DOI"><ExternalValue href={doiUrl(metadata.doi)}>{metadata.doi ?? '未提供'}</ExternalValue></Definition>
        <Definition label="Citations">{metadata.citationCount != null ? metadata.citationCount.toLocaleString() : '未提供'}{metadata.influentialCitationCount != null ? ` · 高影响力 ${metadata.influentialCitationCount.toLocaleString()}` : ''}</Definition>
        <Definition label="Source ID">{ref?.sourceId ?? identityLabel}</Definition>
        <Definition label="Unique / Document ID">{[ref?.uniqueId, ref?.documentId].filter(Boolean).join(' · ') || '未提供'}</Definition>
        <Definition label="Categories" wide>{metadata.categories.length ? metadata.categories.join(' · ') : '未提供'}</Definition>
        {metadata.abstract && <Definition label="Abstract" wide>{metadata.abstract}</Definition>}
        <Definition label="License"><ExternalValue href={metadata.licenseUrl}>{metadata.license ?? '未提供'}</ExternalValue></Definition>
        <Definition label="Stored content">{[metadata.storedContent?.kind, metadata.storedContent?.mimeType].filter(Boolean).join(' · ') || '未提供'}</Definition>
      </DefinitionList>
    </RecordPage>
  )
}

function ProvenanceView({ provenance }: { provenance: LiteratureProvenance | null }) {
  if (!provenance) return <ReaderMessage title="来源记录无法解析">溯源文件不存在或格式不受支持。</ReaderMessage>
  return (
    <RecordPage title="来源与溯源" description="该记录描述系统从哪里、何时、以何种内容身份保存了这份文献。">
      <DefinitionList>
        <Definition label="Provider">{provenance.provider ?? '未提供'}</Definition>
        <Definition label="External ID">{provenance.externalId ?? '未提供'}</Definition>
        <Definition label="Retrieved at">{formatDate(provenance.retrievedAt) ?? '未提供'}</Definition>
        <Definition label="Provider version">{provenance.providerVersion ?? provenance.version ?? '未提供'}</Definition>
        <Definition label="Canonical source" wide><ExternalValue href={provenance.canonicalUrl}>{provenance.canonicalUrl ?? '未提供'}</ExternalValue></Definition>
        <Definition label="License"><ExternalValue href={provenance.licenseUrl}>{provenance.license ?? '未提供'}</ExternalValue></Definition>
        <Definition label="Search audit">{provenance.searchRecordPath ?? '未关联'}</Definition>
        <Definition label="Saved path" wide>{provenance.content?.path ?? '未提供'}</Definition>
        <Definition label="Content">{[provenance.content?.kind, provenance.content?.mimeType, formatBytes(provenance.content?.sizeBytes)].filter(Boolean).join(' · ') || '未提供'}</Definition>
        <Definition label="SHA-256"><span className="font-mono text-[11px]">{provenance.content?.sha256 ?? '未提供'}</span></Definition>
      </DefinitionList>
    </RecordPage>
  )
}

function RecordPage({ title, description, children }: {
  title: string
  description: string
  children: ReactNode
}) {
  return (
    <main className="bg-[color-mix(in_srgb,var(--surface-container-low)_70%,transparent)] px-4 py-8 sm:px-8">
      <section className="mx-auto max-w-[860px] rounded-[18px] border border-outline-variant/12 bg-surface-lowest px-7 py-8 shadow-[0_16px_50px_rgba(40,48,64,0.045)] sm:px-10">
        <h2 className="text-xl font-semibold tracking-[-0.018em] text-ink">{title}</h2>
        <p className="mt-2 text-xs leading-5 text-ink-muted">{description}</p>
        <div className="mt-6">{children}</div>
      </section>
    </main>
  )
}

function ReaderMessage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="flex min-h-80 items-center justify-center bg-surface-low/40 p-8 text-center">
      <div className="max-w-md rounded-2xl border border-outline-variant/15 bg-surface-lowest px-8 py-7">
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        <p className="mt-2 text-xs leading-6 text-ink-muted">{children}</p>
      </div>
    </main>
  )
}

function TechnicalView({ role, content }: { role: LiteratureArtifactRole; content: string }) {
  const lines = content ? content.split(/\r?\n/).filter(Boolean).length : 0
  const name = role === 'blocks' ? '页级检索块索引' : '解析器技术记录'
  return (
    <RecordPage title={name} description="这是供检索与可追溯性使用的技术附件，不是论文正文。">
      <DefinitionList>
        <Definition label="Artifact type">{role}</Definition>
        <Definition label="Entries">{lines.toLocaleString()} 行</Definition>
      </DefinitionList>
    </RecordPage>
  )
}

export function LiteraturePaperReader({
  activeArtifact,
  content,
  allArtifacts,
  conversationId,
  setActivePath,
  onQuoteSelection,
}: LiteraturePaperReaderProps) {
  const identity = parseLiteratureArtifactPath(activeArtifact.path)
  const bundle = useMemo(
    () => collectLiteratureBundleArtifacts(activeArtifact.path, allArtifacts),
    [activeArtifact.path, allArtifacts],
  )

  const metadataPath = bundle.metadata?.path ?? ''
  const provenancePath = bundle.provenance?.path ?? ''
  const fulltextArtifact = bundle.sourceFulltext ?? bundle.parsedFulltext
  const metadataLazy = useGridFSContent(
    conversationId,
    metadataPath,
    Boolean(bundle.metadata?.gridfsPending && bundle.metadata.path !== activeArtifact.path),
  )
  const provenanceLazy = useGridFSContent(
    conversationId,
    provenancePath,
    Boolean(bundle.provenance?.gridfsPending && bundle.provenance.path !== activeArtifact.path),
  )
  if (!identity) return <ReaderMessage title="无法识别文献目录">该文件不属于受支持的文献包。</ReaderMessage>

  const metadataRaw = artifactContent(bundle.metadata, activeArtifact, content, metadataLazy.content)
  const provenanceRaw = artifactContent(bundle.provenance, activeArtifact, content, provenanceLazy.content)
  // Never prefetch a sibling full text just to decorate a PDF/record view.
  // Full papers can be megabytes and remain in the shared GridFS content cache;
  // the active full-text path is already loaded by WorkspacePanel when needed.
  const fulltext = artifactContent(fulltextArtifact, activeArtifact, content, '')
  const metadata = parseLiteratureMetadata(metadataRaw)
  const displayMetadata = metadata
    ? { ...metadata, doi: metadata.doi ?? extractDoiFromMarkdown(fulltext) }
    : metadata
  const provenance = parseLiteratureProvenance(provenanceRaw)
  const title = resolvePaperTitle(displayMetadata, fulltext, identity)

  const tabs: ReaderTab[] = []
  if (fulltextArtifact) tabs.push({
    path: fulltextArtifact.path,
    label: readerLabel(parseLiteratureArtifactPath(fulltextArtifact.path)?.role ?? 'other', identity.source),
    role: parseLiteratureArtifactPath(fulltextArtifact.path)?.role ?? 'other',
  })
  if (bundle.originalPdf) tabs.push({ path: bundle.originalPdf.path, label: '原始 PDF', role: 'original-pdf' })
  if (bundle.metadata) tabs.push({ path: bundle.metadata.path, label: '论文信息', role: 'metadata' })
  if (bundle.provenance) tabs.push({ path: bundle.provenance.path, label: '来源记录', role: 'provenance' })

  const href = sourceUrl(displayMetadata, provenance, activeArtifact)
  const waitingForRecord = (metadataLazy.isLoading && !metadataRaw)
    || (provenanceLazy.isLoading && !provenanceRaw)

  return (
    <section className="flex min-h-full flex-col bg-surface-lowest/60" data-testid="literature-paper-reader">
      <PaperHeader
        source={identity.source}
        role={identity.role}
        title={title}
        metadata={displayMetadata}
        provenance={provenance}
        sourceHref={href}
        tabs={tabs}
        activePath={activeArtifact.path}
        onSelect={setActivePath}
      />
      {waitingForRecord && !fulltext && (identity.role === 'source-fulltext' || identity.role === 'parsed-fulltext') ? (
        <div className="mx-auto flex w-full max-w-[900px] flex-col gap-3 p-8"><ShimmerBlock className="w-2/5" h={22} /><ShimmerBlock h={420} /></div>
      ) : identity.role === 'source-fulltext' || identity.role === 'parsed-fulltext' ? (
        fulltext
          ? <StructuredFulltextView source={identity.source} content={fulltext} sourcePath={activeArtifact.path} conversationId={conversationId} onQuoteSelection={onQuoteSelection} />
          : <ReaderMessage title="正文暂时不可用">结构化全文尚未加载完成，请稍后重试。</ReaderMessage>
      ) : identity.role === 'original-pdf' ? (
        <OriginalPdfView artifact={activeArtifact} conversationId={conversationId} />
      ) : identity.role === 'metadata' ? (
        <MetadataView metadata={displayMetadata} identityLabel={identity.shortId} />
      ) : identity.role === 'provenance' ? (
        <ProvenanceView provenance={provenance} />
      ) : (
        <TechnicalView role={identity.role} content={content} />
      )}
    </section>
  )
}
