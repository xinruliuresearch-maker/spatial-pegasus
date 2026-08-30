import { createHash } from 'node:crypto'
import { Conversation } from '../lib/db/models'
import { DEMO_USER_ID } from '../lib/demo-identity'
import { SpatialBuildJobModel } from '../lib/spatial/models'
import { serializeSpatialToolResult } from '../lib/spatial/tool-result'

export interface SpatialUiFixture {
  conversationId: string
  conversationTitle: string
  jobId: string
}

export interface SpatialUiFixtureInput {
  suffix: string
}

/**
 * Seed an authoritative terminal Job plus a deliberately stale historical
 * tool_result. No provider adapter is imported and no runnable Job is created,
 * so the background worker has nothing to submit even if it is enabled.
 */
export async function seedSpatialUiFixture(
  input: SpatialUiFixtureInput,
): Promise<SpatialUiFixture> {
  if (!/^[a-f0-9]{8,32}$/.test(input.suffix)) {
    throw new Error('Spatial UI fixture suffix must be 8-32 lowercase hex characters.')
  }
  const conversationId = `e2e-conversation-${input.suffix}`
  const conversationTitle = `E2E · 零费用空间恢复 ${input.suffix}`
  const jobId = `spjob_e2e_${input.suffix}`
  const toolUseId = `tool_e2e_world_${input.suffix}`
  const runId = `run_e2e_${input.suffix}`
  const createdAt = new Date(Date.now() - 2_500)
  const finishedAt = new Date()

  const job = await SpatialBuildJobModel.create({
    job_id: jobId,
    idempotency_key: `${conversationId}:${runId}:${toolUseId}`,
    project_id: conversationId,
    run_id: runId,
    tool_use_id: toolUseId,
    user_id: DEMO_USER_ID,
    conversation_id: conversationId,
    kind: 'world',
    provider: 'fixture-no-network',
    model_snapshot: 'fixture-v1',
    request_hash: createHash('sha256').update(`fixture:${input.suffix}`).digest('hex'),
    request_snapshot: {
      output_path_prefix: `output/spatial/worlds/e2e-${input.suffix}`,
      prompt: '零费用界面恢复夹具；不得提交供应商。',
    },
    output_path_prefix: `output/spatial/worlds/e2e-${input.suffix}`,
    status: 'published',
    status_revision: 6,
    execution_attempts: 0,
    consecutive_failures: 0,
    submission_attempts: 0,
    poll_attempts: 0,
    lease: null,
    external_job_id: 'fixture-no-provider-job',
    provider_status: 'fixture-published',
    published_artifact_ids: [],
    published_workspace_paths: [],
    publication_token: `fixture-publication-${input.suffix}`,
    available_at: null,
    last_error: null,
    unknown_reason: null,
    finished_at: finishedAt,
    created_at: createdAt,
    updated_at: finishedAt,
  })

  const envelope = serializeSpatialToolResult({
    schema_version: 1,
    job_id: jobId,
    kind: 'world',
    // Deliberately stale historical snapshot. The browser must render this
    // first and then reconcile to the authoritative published Job API record.
    status: 'prepared',
    provider: 'fixture-no-network',
    message: '历史消息中的初始状态；等待持久 Job API 校准。',
    created_at: job.created_at.toISOString(),
    elapsed_ms: 0,
    updated_at: job.created_at.toISOString(),
  })

  await Conversation.create({
    conversation_id: conversationId,
    user_id: DEMO_USER_ID,
    title: conversationTitle,
    settings: {
      orchestrator_model: 'main_standard',
      research_domain: '开放空间创作',
      memory_enabled: false,
    },
    messages: [
      {
        role: 'user',
        message_id: `message_user_${input.suffix}`,
        run_id: runId,
        sequence: 0,
        timestamp: createdAt,
        content: [{ type: 'text', text: '请展示一个可以在刷新和服务重启后恢复的空间世界任务。' }],
      },
      {
        role: 'assistant',
        message_id: `message_tool_use_${input.suffix}`,
        run_id: runId,
        sequence: 1,
        timestamp: createdAt,
        content: [{
          type: 'tool_use',
          id: toolUseId,
          name: 'CreateWorld3D',
          input: {
            prompt: '零费用界面夹具',
            output_path_prefix: `output/spatial/worlds/e2e-${input.suffix}`,
          },
        }],
      },
      {
        role: 'user',
        message_id: `message_tool_result_${input.suffix}`,
        run_id: runId,
        sequence: 2,
        timestamp: finishedAt,
        content: [{
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: envelope,
        }],
      },
      {
        role: 'assistant',
        message_id: `message_final_${input.suffix}`,
        run_id: runId,
        sequence: 3,
        timestamp: finishedAt,
        content: [{
          type: 'text',
          text: '空间任务已经从本地持久记录恢复，并由 Job API 校准到已发布；本测试没有访问 Aholo、Lux3D 或图像供应商。',
        }],
      },
    ],
  })

  return { conversationId, conversationTitle, jobId }
}
