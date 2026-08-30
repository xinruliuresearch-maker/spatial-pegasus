import type { MemoryHistoryEventDocument } from './models'

export function normalizeSearchText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, ' ')
    .trim()
}
export function buildSearchText(input: {
  title?: string
  summary?: string
  detail?: string
  project?: string
  tags?: string[]
  search_terms?: string[]
}): string {
  return normalizeSearchText(
    [input.title, input.project, input.summary, input.detail, ...(input.tags ?? []), ...(input.search_terms ?? [])]
      .filter(Boolean)
      .join(' ')
  )
}

function terms(value: string): string[] {
  const normalized = normalizeSearchText(value)
  const wordTokens = normalized.split(' ').filter(Boolean)
  const compact = normalized.replace(/\s/g, '')
  const grams = new Set<string>()
  for (const size of [2, 3]) {
    for (let i = 0; i <= compact.length - size; i += 1) grams.add(compact.slice(i, i + size))
  }
  return [...new Set([...wordTokens, ...grams])]
}

export function scoreHistoryEvent(
  event: Pick<MemoryHistoryEventDocument, 'title' | 'project' | 'summary' | 'tags' | 'normalized_search_text' | 'event_at'>,
  query: string,
  now = Date.now()
): number {
  const queryTerms = terms(query)
  if (queryTerms.length === 0) return 0
  const title = normalizeSearchText(event.title)
  const project = normalizeSearchText(event.project)
  const summary = normalizeSearchText(event.summary)
  const tags = normalizeSearchText(event.tags.join(' '))
  const searchable = event.normalized_search_text || [title, project, summary, tags].join(' ')
  let score = 0
  for (const term of queryTerms) {
    if (title.includes(term)) score += 8
    if (project.includes(term)) score += 7
    if (tags.includes(term)) score += 5
    if (summary.includes(term)) score += 3
    else if (searchable.includes(term)) score += 1
  }
  const ageDays = Math.max(0, (now - new Date(event.event_at).getTime()) / 86_400_000)
  return score + Math.max(0, 2 - ageDays / 90)
}
