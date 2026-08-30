export const DEFAULT_TOOL_OUTPUT_LIMIT = 24_000

/** Serialize valid JSON while reducing the named result array to a hard character ceiling. */
export function boundedToolJson(
  value: Record<string, unknown>,
  arrayField?: string,
  maxChars = DEFAULT_TOOL_OUTPUT_LIMIT,
): string {
  let candidate = value
  let rendered = JSON.stringify(candidate, null, 2)
  if (rendered.length <= maxChars) return rendered

  const items = arrayField && Array.isArray(value[arrayField])
    ? value[arrayField] as unknown[]
    : null
  if (items) {
    let low = 0
    let high = items.length
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      const test = {
        ...value,
        [arrayField!]: items.slice(0, middle),
        tool_result_truncated: middle < items.length,
        total_items: items.length,
      }
      if (JSON.stringify(test, null, 2).length <= maxChars) low = middle
      else high = middle - 1
    }
    candidate = {
      ...value,
      [arrayField!]: items.slice(0, low),
      tool_result_truncated: true,
      total_items: items.length,
    }
    rendered = JSON.stringify(candidate, null, 2)
    if (rendered.length <= maxChars) return rendered
  }

  return JSON.stringify({
    status: 'completed',
    tool_result_truncated: true,
    recovery: 'The complete result was saved in the referenced workspace audit/artifact paths.',
    references: extractReferences(value),
  }, null, 2)
}

function extractReferences(value: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const key of [
    'search_id',
    'record_path',
    'directory',
    'metadata_path',
    'provenance_path',
    'source_content_path',
    'full_text_path',
    'blocks_path',
    'parser_provenance_path',
  ]) {
    const item = value[key]
    if (typeof item === 'string') result[key] = item
  }
  return result
}
