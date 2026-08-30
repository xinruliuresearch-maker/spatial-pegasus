import type { BackgroundCompactionHandoffDescriptor } from '../agent/loop'
import type { ModelAlias } from '../llm-registry'
import { resolveAuthoritativeModelSnapshot } from '../llm-registry'
import {
  enqueueDurableCompaction,
  hashCompactionMessages,
  hashCompactionValue,
} from './repository'
import type {
  CompactionContextOwner,
  DurableCompactionJobRecord,
  EnqueueCompactionInput,
} from './types'
import { compactionOwnerKey } from './types'

type EnqueueCompaction = (
  input: EnqueueCompactionInput,
) => Promise<DurableCompactionJobRecord>

function modelResolutionIdentity(value: DurableCompactionJobRecord['model_resolution_snapshot']): string {
  if (!value) return ''
  const identity = { ...value } as Partial<typeof value>
  delete identity.resolved_at
  return hashCompactionValue(identity)
}

export interface BackgroundCompactionHandoffInput {
  owner: CompactionContextOwner
  sourceRunId: string
  /** The frozen registry alias, never the provider's resolved model ID. */
  modelAliasSnapshot: ModelAlias
  descriptor: BackgroundCompactionHandoffDescriptor
  /** Future deadline for a hard-crash shadow intent; omit for immediate handoff. */
  notBefore?: Date
  enqueue?: EnqueueCompaction
}

/**
 * Transfer one already-running local summary to the context-scoped durable
 * worker. The callback only resolves after Mongo accepts the exact frozen
 * prefix. Any validation or write failure is deliberately thrown so
 * Hippocampus keeps ownership and drains the local summary safely.
 */
export async function handoffBackgroundCompaction(
  input: BackgroundCompactionHandoffInput,
): Promise<{ jobId: string }> {
  const { descriptor } = input
  if (!input.sourceRunId.trim()) {
    throw new Error('Durable compaction handoff requires a source Run ID.')
  }
  if (
    descriptor.sourceRunId
    && descriptor.sourceRunId !== input.sourceRunId
  ) {
    throw new Error('Durable compaction handoff source Run does not match the active Run.')
  }
  if (!input.modelAliasSnapshot.trim()) {
    throw new Error('Durable compaction handoff requires a frozen registry model alias.')
  }
  if (
    descriptor.modelAliasSnapshot
    && descriptor.modelAliasSnapshot !== input.modelAliasSnapshot
  ) {
    throw new Error('Durable compaction handoff registry alias does not match the active Run.')
  }
  if (
    descriptor.prefixLength <= 0
    || descriptor.prefixMessages.length !== descriptor.prefixLength
  ) {
    throw new Error('Durable compaction handoff has an invalid frozen prefix length.')
  }
  if (hashCompactionMessages(descriptor.prefixMessages) !== descriptor.prefixHash) {
    throw new Error('Durable compaction handoff prefix hash does not match its messages.')
  }
  const actualBoundary = descriptor.prefixMessages.at(-1)?.message_id
  if (
    descriptor.boundaryMessageId
    && descriptor.boundaryMessageId !== actualBoundary
  ) {
    throw new Error('Durable compaction handoff boundary does not match its frozen prefix.')
  }
  const projectContextSnapshot = descriptor.projectContextSnapshot
  if (!projectContextSnapshot) {
    throw new Error('Durable compaction handoff requires the frozen Project Context epoch.')
  }

  const modelResolutionSnapshot = await resolveAuthoritativeModelSnapshot(
    input.modelAliasSnapshot,
  )
  if (
    descriptor.modelIdSnapshot
    && descriptor.modelIdSnapshot !== modelResolutionSnapshot.real_model
  ) {
    throw new Error(
      'Durable compaction handoff model mapping changed after the active Run was frozen.',
    )
  }

  const enqueue = input.enqueue ?? enqueueDurableCompaction
  const job = await enqueue({
    owner: input.owner,
    idempotencyKey: descriptor.idempotencyKey,
    sourceRunId: input.sourceRunId,
    modelAliasSnapshot: input.modelAliasSnapshot,
    modelResolutionSnapshot,
    ...(input.notBefore ? { initialAvailableAt: input.notBefore } : {}),
    prefixMessages: descriptor.prefixMessages,
    projectContextSnapshot,
    workspaceProjection: projectContextSnapshot.workspace_projection,
  })
  const exactFrozenIntent = (
    job.owner_key === compactionOwnerKey(input.owner)
    && job.source_run_id === input.sourceRunId
    && job.idempotency_key === descriptor.idempotencyKey
    && job.idempotency_keys.includes(descriptor.idempotencyKey)
    && job.model_alias_snapshot === input.modelAliasSnapshot
    && modelResolutionIdentity(job.model_resolution_snapshot)
      === modelResolutionIdentity(modelResolutionSnapshot)
    && job.frozen_prefix.prefix_length === descriptor.prefixLength
    && job.frozen_prefix.prefix_hash === descriptor.prefixHash
    && job.frozen_prefix.boundary_message_id === actualBoundary
    && hashCompactionValue(job.project_context_snapshot)
      === hashCompactionValue(projectContextSnapshot)
    && hashCompactionValue(job.workspace_projection)
      === hashCompactionValue(projectContextSnapshot.workspace_projection)
  )
  if (!exactFrozenIntent) {
    throw new Error(
      `Durable compaction Job ${job.job_id} does not own this exact frozen intent; retain local ownership.`,
    )
  }
  if (
    job.status === 'failed'
    || job.status === 'cancelled'
    || job.status === 'superseded'
  ) {
    throw new Error(
      `Durable compaction Job ${job.job_id} is terminal (${job.status}); retain local ownership.`,
    )
  }
  if (input.notBefore) {
    const availableAt = job.available_at?.getTime()
    if (
      job.status !== 'queued'
      || job.lease
      || availableAt !== input.notBefore.getTime()
    ) {
      throw new Error(
        `Durable compaction Job ${job.job_id} is not the unclaimed delayed shadow for this execution.`,
      )
    }
  }
  return { jobId: job.job_id }
}
