import type { ToolResult } from '../types'
import { safeError } from '../literature/http'
import {
  FetchPaperMaterializationError,
  LiteratureService,
} from '../literature/service'
import {
  boundedToolJson,
  DEFAULT_TOOL_OUTPUT_LIMIT,
} from '../literature/tool-output'
import type { LiteratureSource, LiteratureToolRuntime } from '../literature/types'

const TRUNCATED_TEXT_NEXT_ACTION =
  'Use SearchDocument to locate passages, then Read the relevant section from full_text_path.'

export interface FetchPaperInput {
  source: LiteratureSource
  source_id: string
  version?: string
  search_record_path?: string
}

interface FetchPaperFacadeOptions {
  /** Public, source-specific identifier field returned to the Agent. */
  idField?: 'source_id' | 'arxiv_id' | 'doc_id'
}

export async function executeFetchPaper(
  input: FetchPaperInput,
  runtime: LiteratureToolRuntime,
  options: FetchPaperFacadeOptions = {},
): Promise<ToolResult> {
  const idField = options.idField ?? 'source_id'
  try {
    const service = new LiteratureService(runtime.workspace, runtime.providers, {
      signal: runtime.signal,
      now: runtime.now,
      randomId: runtime.randomId,
      pdfParser: runtime.pdfParser,
    })
    const receipt = await service.fetchPaper({
      source: input.source,
      sourceId: input.source_id,
      version: input.version,
      searchRecordPath: input.search_record_path,
    })
    return {
      content: serializeReadyReceipt({
        status: 'ready',
        source: receipt.source,
        [idField]: receipt.sourceId,
        directory: receipt.directory,
        metadata_path: receipt.metadataPath,
        provenance_path: receipt.provenancePath,
        source_content_path: receipt.sourceContentPath,
        full_text_path: receipt.fullTextPath,
        blocks_path: receipt.blocksPath,
        parser_provenance_path: receipt.parserProvenancePath,
        text_origin: receipt.textOrigin,
        parser: receipt.parser,
        full_text_chars: receipt.fullTextChars,
        already_present: receipt.alreadyPresent,
      }, receipt.fullText),
      telemetry: { download_bytes: receipt.downloadBytes },
    }
  } catch (error) {
    if (error instanceof FetchPaperMaterializationError) {
      return {
        content: boundedToolJson({
          status: error.partial.sourceArtifactSaved ? 'partial' : 'error',
          source: error.partial.source,
          [idField]: error.partial.sourceId,
          directory: error.partial.directory,
          metadata_path: error.partial.metadataPath,
          provenance_path: error.partial.provenancePath,
          source_content_path: error.partial.sourceContentPath,
          error: error.message,
          retry: error.partial.sourceArtifactSaved
            ? `Call the same source-specific fetch tool again with the same ${idField}; it will reuse the saved source artifact and retry only local materialization.`
            : `Call the same source-specific fetch tool again with the same ${idField}; the source artifact was not saved and will be downloaded again.`,
        }),
        is_error: true,
        telemetry: { download_bytes: error.partial.downloadBytes },
      }
    }
    const detail = safeError(error)
    return { content: `${detail.name}: ${detail.message}`, is_error: true }
  }
}

/**
 * Fit the inline paper text against the final serialized JSON size. Measuring the
 * source string alone is unsafe because quotes, slashes, control characters, and
 * unpaired surrogates expand when JSON encoded.
 */
function serializeReadyReceipt(
  fields: Record<string, unknown>,
  fullText: string,
  maxChars = DEFAULT_TOOL_OUTPUT_LIMIT,
): string {
  const totalChars = typeof fields.full_text_chars === 'number'
    ? fields.full_text_chars
    : fullText.length
  const candidate = (text: string): Record<string, unknown> => {
    const truncated = text.length < totalChars
    return {
      ...fields,
      full_text: text,
      full_text_returned_chars: text.length,
      full_text_truncated: truncated,
      next_action: truncated ? TRUNCATED_TEXT_NEXT_ACTION : undefined,
    }
  }

  // Preserve the existing readable formatting whenever the complete result fits.
  const complete = candidate(fullText)
  const prettyComplete = JSON.stringify(complete, null, 2)
  if (prettyComplete.length <= maxChars) return prettyComplete

  // Compact JSON has less structural overhead and leaves the largest possible
  // share of the fixed output budget for useful paper text.
  const compactComplete = JSON.stringify(complete)
  if (compactComplete.length <= maxChars) return compactComplete

  let low = 0
  let high = Math.max(0, fullText.length - 1)
  let best = JSON.stringify(candidate(''))
  if (best.length > maxChars) {
    throw new RangeError(
      `Paper fetch result exceeds the ${maxChars}-character tool output limit even without inline full text`,
    )
  }

  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const prefix = unicodeSafePrefix(fullText, middle)
    const rendered = JSON.stringify(candidate(prefix))
    if (rendered.length <= maxChars) {
      best = rendered
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return best
}

/** Avoid ending the returned prefix between a UTF-16 surrogate pair. */
function unicodeSafePrefix(value: string, requestedLength: number): string {
  let end = Math.min(Math.max(requestedLength, 0), value.length)
  if (
    end > 0
    && end < value.length
    && isHighSurrogate(value.charCodeAt(end - 1))
    && isLowSurrogate(value.charCodeAt(end))
  ) {
    end -= 1
  }
  return value.slice(0, end)
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xD800 && code <= 0xDBFF
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xDC00 && code <= 0xDFFF
}
