import type {
  SpatialBuildKind,
  SpatialBuildJobRecord,
  SpatialProviderAdapter,
  SpatialProviderPollResult,
  SpatialProviderSubmission,
} from '../types'

export interface FakeSpatialAdapterOptions {
  provider?: string
  supportedKinds?: readonly SpatialBuildKind[]
  externalJobId?: string
  pollResults?: readonly SpatialProviderPollResult[]
  submitErrors?: readonly Error[]
}

/** Deterministic fake for unit/integration tests. It never performs I/O. */
export class FakeSpatialProviderAdapter implements SpatialProviderAdapter {
  readonly provider: string
  readonly submissions: SpatialBuildJobRecord[] = []
  readonly polls: SpatialBuildJobRecord[] = []
  private readonly supportedKinds: readonly SpatialBuildKind[]
  private readonly externalJobId: string
  private readonly pollResults: SpatialProviderPollResult[]
  private readonly submitErrors: Error[]

  constructor(options: FakeSpatialAdapterOptions = {}) {
    this.provider = options.provider ?? 'fake'
    this.supportedKinds = options.supportedKinds ?? ['image', 'object', 'world']
    this.externalJobId = options.externalJobId ?? 'fake_external_job'
    this.pollResults = [...(options.pollResults ?? [{ state: 'running' }])]
    this.submitErrors = [...(options.submitErrors ?? [])]
  }

  supports(kind: SpatialBuildKind): boolean {
    return this.supportedKinds.includes(kind)
  }

  async submit(job: SpatialBuildJobRecord): Promise<SpatialProviderSubmission> {
    this.submissions.push(structuredClone(job))
    const error = this.submitErrors.shift()
    if (error) throw error
    return { externalJobId: this.externalJobId, providerStatus: 'submitted' }
  }

  async poll(job: SpatialBuildJobRecord): Promise<SpatialProviderPollResult> {
    this.polls.push(structuredClone(job))
    return this.pollResults.length > 1
      ? this.pollResults.shift()!
      : this.pollResults[0] ?? { state: 'running' }
  }
}
