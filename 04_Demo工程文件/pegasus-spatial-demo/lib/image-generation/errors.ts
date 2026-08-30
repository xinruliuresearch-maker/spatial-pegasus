export class ImageGenerationProviderError extends Error {
  readonly requestMayHaveBeenAccepted: boolean
  readonly code: string

  constructor(
    message: string,
    options: { code: string; requestMayHaveBeenAccepted: boolean; cause?: unknown },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ImageGenerationProviderError'
    this.code = options.code
    this.requestMayHaveBeenAccepted = options.requestMayHaveBeenAccepted
  }
}

export class ImageGenerationReceiptConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImageGenerationReceiptConflictError'
  }
}

export function boundedErrorMessage(error: unknown, maxLength = 2_000): string {
  const cause = error instanceof Error ? error.cause : undefined
  const errorMessage = error instanceof Error ? error.message : String(error)
  const causeCode = typeof (cause as { code?: unknown } | null)?.code === 'string'
    ? ` [cause=${(cause as { code: string }).code}]`
    : ''
  const causeMessage = cause instanceof Error && cause.message !== errorMessage
    ? `: ${cause.message}`
    : ''
  const raw = `${errorMessage}${causeCode}${causeMessage}`
  let sanitized = raw
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/gi, 'data:image/[REDACTED]')
    .replace(
      /\b(api[_-]?key|authorization|access[_-]?token|token|secret)(\s*["']?\s*[:=]\s*["']?)([^"'\s,;}\]]+)/gi,
      '$1$2[REDACTED]',
    )
  for (const configured of [
    process.env.LLM_API_KEY_TOOLS,
    process.env.AHOLO_API_KEY,
    process.env.AHOLO_API_TOKEN,
    process.env.LUX3D_API_KEY,
    process.env.LUX3D_API_TOKEN,
  ]) {
    const secret = configured?.trim()
    if (secret && secret.length >= 4) sanitized = sanitized.split(secret).join('[REDACTED]')
  }
  return sanitized.slice(0, maxLength)
}
