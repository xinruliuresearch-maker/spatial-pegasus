import assert from 'node:assert/strict'
import type { AgentTeamRecord } from '../../agent-team'
import {
  deliverPendingSpatialJobNotifications,
  formatSpatialCompletionUpdate,
  type SpatialBuildJobRecord,
  type SpatialCompletionDeliveryDependencies,
} from '..'

function job(
  id: string,
  status: 'published' | 'failed' | 'unknown' | 'cancelled' = 'published',
): SpatialBuildJobRecord {
  const now = new Date('2026-08-27T12:00:00.000Z')
  return {
    job_id: id,
    idempotency_key: `project\0run\0${id}`,
    project_id: 'project',
    run_id: 'run_origin',
    tool_use_id: `tool_${id}`,
    user_id: 'user',
    conversation_id: 'conversation',
    kind: 'object',
    provider: 'lux3d',
    model_snapshot: 'G1',
    request_hash: 'hash',
    request_snapshot: { output_path_prefix: `output/spatial/objects/${id}` },
    status,
    status_revision: 4,
    execution_attempts: 2,
    submission_attempts: 1,
    poll_attempts: 3,
    lease: null,
    external_job_id: 'external',
    provider_status: status,
    published_artifact_ids: status === 'published' ? [`artifact_${id}`] : [],
    published_workspace_paths: status === 'published'
      ? [`output/spatial/objects/${id}/model.glb`]
      : [],
    publication_token: status === 'published' ? `publication_${id}` : null,
    available_at: null,
    last_error: status === 'failed' ? 'fixture failed' : null,
    unknown_reason: status === 'unknown' ? 'provider acceptance is unknown' : null,
    completion_notification_requested: true,
    completion_notified_at: null,
    completion_notification_last_error: null,
    created_at: new Date('2026-08-27T11:55:00.000Z'),
    updated_at: now,
    finished_at: now,
  }
}

async function verifyReminderContract(): Promise<void> {
  const published = formatSpatialCompletionUpdate(job('published'))
  assert.match(published, /"event":"spatial_job_update"/)
  assert.match(published, /"status":"published"/)
  assert.match(published, /artifact_published/)
  assert.match(published, /不是原 tool_use 的第二个结果/)

  const unknown = formatSpatialCompletionUpdate(job('unknown', 'unknown'))
  assert.match(unknown, /禁止自动重新付费提交/)
  assert.throws(
    () => formatSpatialCompletionUpdate({ ...job('running'), status: 'running' }),
    /requires a terminal Job/,
  )
}

async function verifyCrashSafeSweepUsesStableDeliveryKeys(): Promise<void> {
  const pending = [job('one'), job('two', 'unknown')]
  const wakeCalls: Array<{ deliveryKey: string; content: string }> = []
  const failures: string[] = []
  const team = {
    team_id: 'team',
    conversation_id: 'conversation',
    user_id: 'user',
    root_agent_id: 'root',
    workspace_id: 'conversation',
    status: 'active',
  } as AgentTeamRecord

  const dependencies: SpatialCompletionDeliveryDependencies = {
    async findActiveTeam() { return team },
    async wakeRoot(input) {
      wakeCalls.push({ deliveryKey: input.deliveryKey, content: input.content })
      return 'run_delivery'
    },
    async markDispatched(target, dispatchedAt) {
      const current = pending.find(value => value.job_id === target.job_id)
      if (!current || current.completion_notified_at) return false
      current.completion_notified_at = dispatchedAt
      return true
    },
    async markFailure(_target, errorCode) { failures.push(errorCode) },
    async listPending(limit) {
      return pending.filter(value => !value.completion_notified_at).slice(0, limit)
    },
    now() { return new Date('2026-08-27T12:01:00.000Z') },
  }

  assert.deepEqual(
    await deliverPendingSpatialJobNotifications({ dependencies }),
    { dispatched: 2, failed: 0 },
  )
  assert.deepEqual(wakeCalls.map(value => value.deliveryKey), [
    'spatial-job-terminal:v1:one:4',
    'spatial-job-terminal:v1:two:4',
  ])
  assert.equal(failures.length, 0)
  assert.deepEqual(
    await deliverPendingSpatialJobNotifications({ dependencies }),
    { dispatched: 0, failed: 0 },
    'a recovery sweep must not enqueue a second terminal update',
  )
}

async function main(): Promise<void> {
  await verifyReminderContract()
  await verifyCrashSafeSweepUsesStableDeliveryKeys()
  console.log('✓ Spatial completion notification verification passed')
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
