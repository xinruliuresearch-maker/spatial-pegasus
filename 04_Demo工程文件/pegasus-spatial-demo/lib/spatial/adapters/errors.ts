export class ProviderDefinitelyNotAcceptedError extends Error {
  readonly code = 'PROVIDER_DEFINITELY_NOT_ACCEPTED'

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ProviderDefinitelyNotAcceptedError'
  }
}

export class ProviderSubmissionUnknownError extends Error {
  readonly code = 'PROVIDER_SUBMISSION_UNKNOWN'

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ProviderSubmissionUnknownError'
  }
}

export class ProviderTransientError extends Error {
  readonly code = 'PROVIDER_TRANSIENT'

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ProviderTransientError'
  }
}

/** Existing paid work is recoverable once operator configuration is restored. */
export class ProviderConfigurationBlockedError extends Error {
  readonly code = 'PROVIDER_CONFIGURATION_BLOCKED'

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ProviderConfigurationBlockedError'
  }
}

export class ProviderPermanentError extends Error {
  readonly code = 'PROVIDER_PERMANENT'

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ProviderPermanentError'
  }
}
