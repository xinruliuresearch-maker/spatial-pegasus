import { createHash, randomUUID } from 'crypto'
import type { ConversationMessage } from '../types'
import type { WorkspaceInstance } from '../workspace/types'
import {
  buildAsyncCompactionMessage,
  buildWorkspaceProjection,
} from '../agent/compaction'
import type {
  CompactionCheckpoint,
  FrozenProjectContextSnapshot,
  FrozenWorkspaceProjection,
} from './types'

export interface CompactionRecoveryResult {
  action: 'none' | 'retry' | 'merged' | 'invalid'
  messages: ConversationMessage[]
  reason?: string
  /** Must be persisted before messages are replaced. */
  checkpointUpgrade?: CompactionCheckpoint
}

function hashMessages(messages: ConversationMessage[]): string {
  return createHash('sha256')
    .update(JSON.stringify(messages))
    .digest('hex')
}

function cloneReplacement(message: ConversationMessage): ConversationMessage {
  const clone = structuredClone(message)
  if (message.timestamp) clone.timestamp = new Date(message.timestamp)
  return clone
}

function samePersistedMessage(
  message: ConversationMessage | undefined,
  replacement: ConversationMessage,
): boolean {
  if (!message) return false
  if (replacement.message_id && message.message_id) {
    return replacement.message_id === message.message_id
  }
  return hashMessages([message]) === hashMessages([replacement])
}

function projectContextWithProjection(
  context: FrozenProjectContextSnapshot | undefined,
  projection: FrozenWorkspaceProjection,
  advanceEpoch = false,
): FrozenProjectContextSnapshot | undefined {
  if (!context) return undefined
  return {
    ...context,
    epoch: context.epoch + (advanceEpoch ? 1 : 0),
    parameters: context.parameters ? { ...context.parameters } : undefined,
    workspace_projection: projection,
  }
}

function upgradePersistedReplacementCheckpoint(
  checkpoint: CompactionCheckpoint,
  projectContext?: FrozenProjectContextSnapshot,
): CompactionCheckpoint | undefined {
  const backfilledProjectContext = checkpoint.project_context_snapshot
    ?? (projectContext
      ? projectContextWithProjection(
          projectContext,
          checkpoint.workspace_projection ?? projectContext.workspace_projection,
          true,
        )
      : undefined)
  const needsStatusUpgrade = checkpoint.status === 'summary_ready'
  const needsProjectContextBackfill = !checkpoint.project_context_snapshot
    && Boolean(backfilledProjectContext)

  if (!needsStatusUpgrade && !needsProjectContextBackfill) return undefined

  return {
    ...checkpoint,
    status: 'merged',
    ...(backfilledProjectContext
      ? {
          project_context_snapshot: backfilledProjectContext,
          workspace_projection:
            checkpoint.workspace_projection ?? backfilledProjectContext.workspace_projection,
        }
      : {}),
    updated_at: new Date(),
  }
}

/**
 * Recover a persisted asynchronous compaction checkpoint.
 *
 * A completed summary is safe to merge only when the exact frozen prefix can
 * still be reconstructed. A started-but-incomplete summary is retried by the
 * normal Hippocampus admission path. No stale summary is ever applied to a
 * changed prefix.
 */
export async function recoverCompactionCheckpoint(
  checkpoint: CompactionCheckpoint | null | undefined,
  messages: ConversationMessage[],
  workspace: WorkspaceInstance,
  runId?: string,
  projectContext?: FrozenProjectContextSnapshot,
): Promise<CompactionRecoveryResult> {
  if (!checkpoint) return { action: 'none', messages }
  if (checkpoint.status === 'started') {
    return { action: 'retry', messages }
  }
  if (
    (checkpoint.status !== 'summary_ready' && checkpoint.status !== 'merged')
    || !checkpoint.summary?.trim()
  ) {
    return {
      action: 'invalid',
      messages,
      reason: 'Compaction checkpoint has no reusable summary.',
    }
  }

  // A crash can happen after compacted_messages is committed but before the
  // checkpoint is cleared. Exact replacement identity makes this idempotent.
  if (
    checkpoint.replacement_message
    && samePersistedMessage(messages[0], checkpoint.replacement_message)
  ) {
    const checkpointUpgrade = upgradePersistedReplacementCheckpoint(
      checkpoint,
      projectContext,
    )
    return {
      action: 'merged',
      messages,
      reason: 'Persisted compaction replacement was already applied.',
      ...(checkpointUpgrade ? { checkpointUpgrade } : {}),
    }
  }

  const boundary = checkpoint.prefix_message_id
    ? messages.findIndex(message => message.message_id === checkpoint.prefix_message_id)
    : messages.length - 1
  if (boundary < 0) {
    return {
      action: 'invalid',
      messages,
      reason: 'Frozen compaction prefix boundary no longer exists.',
    }
  }

  const prefix = messages.slice(0, boundary + 1)
  if (checkpoint.prefix_hash && hashMessages(prefix) !== checkpoint.prefix_hash) {
    return {
      action: 'invalid',
      messages,
      reason: 'Frozen compaction prefix hash does not match persisted messages.',
    }
  }

  if (checkpoint.replacement_message) {
    const replacement = cloneReplacement(checkpoint.replacement_message)
    const checkpointUpgrade = upgradePersistedReplacementCheckpoint(
      checkpoint,
      projectContext,
    )
    return {
      action: 'merged',
      messages: [replacement, ...messages.slice(boundary + 1)],
      ...(checkpointUpgrade ? { checkpointUpgrade } : {}),
    }
  }

  // Legacy checkpoint: capture live workspace metadata exactly once, compose
  // one replacement, and return the upgraded checkpoint. The caller must save
  // this upgrade before swapping compacted_messages; subsequent recovery then
  // uses only the persisted projection and replacement.
  const workspaceProjection = checkpoint.project_context_snapshot?.workspace_projection
    ?? checkpoint.workspace_projection
    ?? await buildWorkspaceProjection(workspace)
  const checkpointProjectContext = checkpoint.project_context_snapshot
  const effectiveProjectContext = projectContextWithProjection(
    checkpointProjectContext ?? projectContext,
    workspaceProjection,
    // A legacy summary-ready checkpoint has not materialized its replacement
    // epoch yet. Capturing the live projection during recovery is the actual
    // merge boundary, so it must advance the frozen context version exactly
    // once. Checkpoints that already persisted a project snapshot keep that
    // exact epoch and are never re-versioned during retries.
    !checkpointProjectContext,
  )
  const replacement = await buildAsyncCompactionMessage(checkpoint.summary, {
    workspaceProjection,
    projectContext: effectiveProjectContext,
    messageId: `msg_${randomUUID()}`,
    runId,
  })
  const checkpointUpgrade: CompactionCheckpoint = {
    ...checkpoint,
    status: 'merged',
    workspace_projection: workspaceProjection,
    ...(effectiveProjectContext
      ? { project_context_snapshot: effectiveProjectContext }
      : {}),
    replacement_message: cloneReplacement(replacement),
    updated_at: new Date(),
  }
  return {
    action: 'merged',
    messages: [replacement, ...messages.slice(boundary + 1)],
    checkpointUpgrade,
  }
}
