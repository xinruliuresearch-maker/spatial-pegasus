import { createHash } from 'node:crypto'
import { connectDB } from '../db/mongodb'
import {
  ImageGenerationReceiptModel,
  reconcileImageGenerationPaidSlots,
} from '../image-generation/receipt-store'
import { canonicalSpatialJson } from './identity'
import {
  SpatialBuildJobModel,
  SpatialOperatorProviderSubmissionGuardModel,
  SpatialOperatorSmokeIntentModel,
} from './models'
import { recoverAmbiguousSpatialSubmissions } from './repository'
import type {
  SpatialOperatorSmokeIntentRecord,
  SpatialOperatorSmokeProvider,
  SpatialOperatorSmokeState,
} from './types'

export const OPERATOR_PAID_CONFIRMATION = 'AUTHORIZE_ONE_PAID_SUBMISSION'
export const OPERATOR_UNKNOWN_RECONCILIATION_CONFIRMATION =
  'RECONCILE_UNKNOWN_AFTER_PROVIDER_ACCOUNTING'

export function operatorSmokeCliHelp(): string {
  return [
    'Pegasus Spatial Operator smoke（默认零供应商提交）',
    '',
    '六个互斥动作：',
    '  --dry-run',
    '  --prepare --project-id <id> --phase <phase> --purpose <purpose>',
    `  --submit --smoke-id <id> --confirm ${OPERATOR_PAID_CONFIRMATION}`,
    '  --status --smoke-id <id>',
    '  --resume --smoke-id <id>  # 只恢复已知 external id，绝不跨越首次提交',
    '  --reconcile-unknown --smoke-id <id>',
    `    --confirm ${OPERATOR_UNKNOWN_RECONCILIATION_CONFIRMATION}`,
    '    --actor <operator> --reason <provider-accounting-evidence>',
    '',
    '三个 npm 入口已经预置供应商，不要再传 --provider：',
    '  npm run spatial:smoke:aholo -- --help',
    '  npm run spatial:smoke:lux -- --help',
    '  npm run spatial:smoke:image -- --help',
    'image edit 需要 --mode edit --project-id <id> --input-path <Workspace path>。',
    'unknown 核销仅写入不可覆盖的审计事实；原 intent 永远保持 unknown，后续使用新 phase/purpose。',
  ].join('\n')
}

export interface PrepareSpatialOperatorSmokeIntentInput {
  projectId: string
  userId: string
  conversationId: string
  provider: SpatialOperatorSmokeProvider
  imageMode?: 'text' | 'edit' | null
  phase: string
  purpose: string
  request: Record<string, unknown>
}

export interface OperatorSmokeBackingStatus {
  targetId?: string | null
  state: SpatialOperatorSmokeState
  submissionCount: number
  artifactHostnames?: readonly string[]
  lastError?: string | null
  finishedAt?: Date | null
}

function requireBoundedText(label: string, value: string, maximum = 160): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > maximum || /\p{Cc}/u.test(normalized)) {
    throw new TypeError(`${label} 必须是 1–${maximum} 个无控制字符的文本。`)
  }
  return normalized
}

function duplicateKey(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === 11000
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function sameFrozenIntent(
  existing: SpatialOperatorSmokeIntentRecord,
  input: PrepareSpatialOperatorSmokeIntentInput,
  requestHash: string,
  phase: string,
  purpose: string,
): boolean {
  return existing.project_id === input.projectId.trim()
    && existing.user_id === input.userId.trim()
    && existing.conversation_id === input.conversationId.trim()
    && existing.provider === input.provider
    && existing.image_mode === (input.provider === 'image' ? input.imageMode ?? 'text' : null)
    && existing.phase === phase
    && existing.purpose === purpose
    && existing.request_hash === requestHash
}

export function operatorSmokeBudgetKey(
  provider: SpatialOperatorSmokeProvider,
  imageMode?: 'text' | 'edit' | null,
): string {
  // Text generation and editing are two explicitly authorized H0 outputs, so
  // each gets one independent slot per phase. Provider-wide uncertainty is
  // deliberately enforced by a separate key below.
  return provider === 'image' ? `${provider}:${imageMode ?? 'text'}` : provider
}

export function operatorSmokeProviderFenceKey(
  provider: SpatialOperatorSmokeProvider,
): string {
  return provider
}

export function operatorSmokeBudgetSlotFilter(input: {
  projectId: string
  phase: string
  provider: SpatialOperatorSmokeProvider
  imageMode?: 'text' | 'edit' | null
}): Record<string, unknown> {
  const budgetKey = operatorSmokeBudgetKey(input.provider, input.imageMode)
  return {
    project_id: input.projectId.trim(),
    phase: input.phase.trim(),
    ...(input.provider === 'image'
      ? {
          $or: [
            { budget_key: budgetKey },
            // Compatibility for image slots written when both modes used the
            // legacy `image` budget key.
            {
              budget_key: 'image',
              provider: 'image',
              image_mode: input.imageMode ?? 'text',
            },
          ],
        }
      : { budget_key: budgetKey }),
  }
}

export function operatorSmokeUnknownFenceFilter(input: {
  projectId: string
  providerFenceKey: string
}): Record<string, unknown> {
  const providerFenceKey = input.providerFenceKey.trim()
  return {
    project_id: input.projectId.trim(),
    state: 'unknown',
    unknown_reconciled_at: null,
    $or: [
      { provider_fence_key: providerFenceKey },
      // Compatibility for intents prepared before provider_fence_key existed.
      { provider_fence_key: { $exists: false }, provider: providerFenceKey },
      { provider_fence_key: null, provider: providerFenceKey },
    ],
  }
}

const GUARDED_OPERATOR_STATES = [
  'authorized',
  'submitting',
  'submitted',
  'running',
  'materializing',
  'configuration_blocked',
] as const

function providerFenceKeyForIntent(intent: SpatialOperatorSmokeIntentRecord): string {
  return intent.provider_fence_key || operatorSmokeProviderFenceKey(intent.provider)
}

function operatorGuardMayBeReleased(intent: SpatialOperatorSmokeIntentRecord): boolean {
  return intent.state === 'published'
    || intent.state === 'failed'
    || (intent.state === 'unknown' && Boolean(intent.unknown_reconciled_at))
}

async function settleOperatorProviderSubmissionGuard(
  intent: SpatialOperatorSmokeIntentRecord,
): Promise<SpatialOperatorSmokeIntentRecord> {
  if (!operatorGuardMayBeReleased(intent)) return intent
  await SpatialOperatorProviderSubmissionGuardModel.deleteOne({
    project_id: intent.project_id,
    provider_fence_key: providerFenceKeyForIntent(intent),
    smoke_id: intent.smoke_id,
  })
  return intent
}

async function ensureGuardForBlockingIntent(
  projectId: string,
  provider: SpatialOperatorSmokeProvider,
): Promise<void> {
  const providerFenceKey = operatorSmokeProviderFenceKey(provider)
  const existing = await SpatialOperatorProviderSubmissionGuardModel.findOne({
    project_id: projectId,
    provider_fence_key: providerFenceKey,
  }).lean<{ smoke_id: string }>()
  if (existing) {
    const holder = await SpatialOperatorSmokeIntentModel.findOne({
      smoke_id: existing.smoke_id,
    }).lean<SpatialOperatorSmokeIntentRecord>()
    if (!holder || !operatorGuardMayBeReleased(holder)) return
    await settleOperatorProviderSubmissionGuard(holder)
  }

  const blocker = await SpatialOperatorSmokeIntentModel.findOne({
    project_id: projectId,
    provider,
    $or: [
      { state: { $in: GUARDED_OPERATOR_STATES } },
      { state: 'unknown', unknown_reconciled_at: null },
    ],
  }).sort({ created_at: 1, smoke_id: 1 }).lean<SpatialOperatorSmokeIntentRecord>()
  if (!blocker) return
  try {
    await SpatialOperatorProviderSubmissionGuardModel.create({
      project_id: projectId,
      provider_fence_key: providerFenceKey,
      smoke_id: blocker.smoke_id,
    })
  } catch (error) {
    if (!duplicateKey(error)) throw error
  }
}

interface OperatorImageBackingDocument {
  status: 'prepared' | 'submitting' | 'asset_stored' | 'published' | 'failed' | 'unknown'
  error_message?: string
  updated_at: Date
}

/**
 * Recover ambiguous provider boundaries before an Operator budget decision,
 * then project the authoritative backing state into every matching intent.
 * This closes the crash window where a Job/receipt was already unknown but a
 * stale intent still appeared authorized to a different phase or image mode.
 */
export async function reconcileSpatialOperatorSmokeProviderBackings(input: {
  projectId: string
  provider: SpatialOperatorSmokeProvider
  now?: Date
}): Promise<void> {
  await connectDB()
  const projectId = requireBoundedText('projectId', input.projectId, 256)
  const now = input.now ?? new Date()
  await recoverAmbiguousSpatialSubmissions(now)
  await reconcileImageGenerationPaidSlots(now)

  const intents = await SpatialOperatorSmokeIntentModel.find({
    project_id: projectId,
    provider: input.provider,
  }).sort({ created_at: 1, smoke_id: 1 }).lean<SpatialOperatorSmokeIntentRecord[]>()

  for (const intent of intents) {
    if (intent.provider === 'image') {
      const receipt = await ImageGenerationReceiptModel.findOne({
        project_id: intent.project_id,
        run_id: intent.run_id,
        tool_use_id: intent.tool_use_id,
      }).select('status error_message updated_at').lean<OperatorImageBackingDocument>()
      if (!receipt) {
        await settleOperatorProviderSubmissionGuard(intent)
        continue
      }
      const state: SpatialOperatorSmokeState = receipt.status === 'asset_stored'
        ? 'materializing'
        : receipt.status === 'prepared' && intent.authorized_at
          ? 'authorized'
          : receipt.status
      await syncSpatialOperatorSmokeIntent(intent.smoke_id, {
        state,
        submissionCount: receipt.status === 'prepared' ? 0 : 1,
        lastError: receipt.error_message?.trim() || null,
        finishedAt: ['published', 'failed', 'unknown'].includes(receipt.status)
          ? receipt.updated_at
          : null,
      })
      continue
    }

    if (!intent.target_id) {
      await settleOperatorProviderSubmissionGuard(intent)
      continue
    }
    const job = await SpatialBuildJobModel.findOne({
      job_id: intent.target_id,
      project_id: intent.project_id,
      user_id: intent.user_id,
      conversation_id: intent.conversation_id,
      run_id: intent.run_id,
      tool_use_id: intent.tool_use_id,
      provider: intent.provider,
    }).lean()
    if (!job) {
      await settleOperatorProviderSubmissionGuard(intent)
      continue
    }
    const state: SpatialOperatorSmokeState = job.provider_status === 'configuration_blocked'
      ? 'configuration_blocked'
      : job.status === 'prepared' && intent.authorized_at
        ? 'authorized'
        : job.status === 'cancelled'
          ? 'failed'
          : job.status
    await syncSpatialOperatorSmokeIntent(intent.smoke_id, {
      targetId: job.job_id,
      state,
      submissionCount: job.submission_attempts > 0 ? 1 : 0,
      artifactHostnames: job.configuration_blocked_hosts ?? [],
      lastError: job.last_error,
      finishedAt: job.finished_at,
    })
  }

  await ensureGuardForBlockingIntent(projectId, input.provider)
}

async function acquireOperatorProviderSubmissionGuard(
  intent: SpatialOperatorSmokeIntentRecord,
): Promise<void> {
  const providerFenceKey = providerFenceKeyForIntent(intent)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await SpatialOperatorProviderSubmissionGuardModel.create({
        project_id: intent.project_id,
        provider_fence_key: providerFenceKey,
        smoke_id: intent.smoke_id,
      })
      return
    } catch (error) {
      if (!duplicateKey(error)) throw error
    }

    const guard = await SpatialOperatorProviderSubmissionGuardModel.findOne({
      project_id: intent.project_id,
      provider_fence_key: providerFenceKey,
    }).lean<{ smoke_id: string }>()
    if (!guard) continue
    if (guard.smoke_id === intent.smoke_id) return
    const holder = await SpatialOperatorSmokeIntentModel.findOne({
      smoke_id: guard.smoke_id,
    }).lean<SpatialOperatorSmokeIntentRecord>()
    if (holder && operatorGuardMayBeReleased(holder)) {
      await settleOperatorProviderSubmissionGuard(holder)
      continue
    }
    throw new SpatialOperatorSmokeAuthorizationError(
      `项目与供应商已有受保护的 Operator smoke ${guard.smoke_id}；在其完成、失败或 unknown 核销前禁止另一阶段提交。`,
    )
  }
  throw new SpatialOperatorSmokeAuthorizationError('无法原子取得供应商提交保护；本次未提交。')
}

export async function assertSpatialOperatorProviderSubmissionGuard(
  smokeId: string,
): Promise<void> {
  const intent = await requireSpatialOperatorSmokeIntent(smokeId)
  const owned = await SpatialOperatorProviderSubmissionGuardModel.exists({
    project_id: intent.project_id,
    provider_fence_key: providerFenceKeyForIntent(intent),
    smoke_id: intent.smoke_id,
  })
  if (!owned) {
    throw new SpatialOperatorSmokeAuthorizationError(
      '供应商提交保护不存在或不属于当前 smoke；本次未跨越付费边界。',
    )
  }
}

async function assertNoUnreconciledUnknown(
  projectId: string,
  providerFenceKey: string,
): Promise<void> {
  const unknown = await SpatialOperatorSmokeIntentModel.findOne(
    operatorSmokeUnknownFenceFilter({ projectId, providerFenceKey }),
  ).select('smoke_id').lean<{ smoke_id: string }>()
  if (unknown) {
    throw new SpatialOperatorSmokeAuthorizationError(
      `项目与供应商预算存在未人工核销的 unknown 任务 ${unknown.smoke_id}；禁止 prepare、authorize 或 submit。`,
    )
  }
}

export function operatorSmokeIdentity(input: {
  projectId: string
  phase: string
  purpose: string
}): { smokeId: string; runId: string; toolUseId: string } {
  const digest = sha256(canonicalSpatialJson({
    project_id: input.projectId.trim(),
    phase: requireBoundedText('phase', input.phase, 80),
    purpose: requireBoundedText('purpose', input.purpose),
  })).slice(0, 32)
  return {
    smokeId: `spsmoke_${digest}`,
    runId: `operator_smoke_${digest}`,
    toolUseId: `operator_paid_${digest}`,
  }
}

export class SpatialOperatorSmokeConflictError extends Error {
  readonly code = 'SPATIAL_OPERATOR_SMOKE_CONFLICT'

  constructor(message: string) {
    super(message)
    this.name = 'SpatialOperatorSmokeConflictError'
  }
}

export class SpatialOperatorSmokeAuthorizationError extends Error {
  readonly code = 'SPATIAL_OPERATOR_SMOKE_AUTHORIZATION_REJECTED'

  constructor(message: string) {
    super(message)
    this.name = 'SpatialOperatorSmokeAuthorizationError'
  }
}

export async function prepareSpatialOperatorSmokeIntent(
  input: PrepareSpatialOperatorSmokeIntentInput,
): Promise<SpatialOperatorSmokeIntentRecord> {
  await connectDB()
  const projectId = requireBoundedText('projectId', input.projectId, 256)
  const userId = requireBoundedText('userId', input.userId, 256)
  const conversationId = requireBoundedText('conversationId', input.conversationId, 256)
  if (projectId !== conversationId) {
    throw new TypeError('Operator smoke 要求 projectId 与 conversationId 指向同一个 Workspace。')
  }
  const phase = requireBoundedText('phase', input.phase, 80)
  const purpose = requireBoundedText('purpose', input.purpose)
  const imageMode = input.provider === 'image' ? input.imageMode ?? 'text' : null
  const request = clone(input.request)
  const requestHash = sha256(canonicalSpatialJson(request))
  const identity = operatorSmokeIdentity({ projectId, phase, purpose })
  const budgetKey = operatorSmokeBudgetKey(input.provider, imageMode)
  const providerFenceKey = operatorSmokeProviderFenceKey(input.provider)
  await reconcileSpatialOperatorSmokeProviderBackings({
    projectId,
    provider: input.provider,
  })
  await assertNoUnreconciledUnknown(projectId, providerFenceKey)
  const existing = await SpatialOperatorSmokeIntentModel.findOne({
    project_id: projectId,
    phase,
    purpose,
  }).lean<SpatialOperatorSmokeIntentRecord>()
  if (existing) {
    if (!sameFrozenIntent(existing, input, requestHash, phase, purpose)) {
      throw new SpatialOperatorSmokeConflictError(
        `同一 project + phase + purpose 已冻结到不同的 Operator smoke：${existing.smoke_id}`,
      )
    }
    return existing
  }
  const slotOwner = await SpatialOperatorSmokeIntentModel.findOne(
    operatorSmokeBudgetSlotFilter({
      projectId,
      phase,
      provider: input.provider,
      imageMode,
    }),
  ).select('smoke_id').lean<{ smoke_id: string }>()
  if (slotOwner) {
    throw new SpatialOperatorSmokeConflictError(
      `项目 ${projectId} 的 ${phase}/${budgetKey} 已有一个冻结的付费 smoke intent。`,
    )
  }

  try {
    const created = await SpatialOperatorSmokeIntentModel.create({
      smoke_id: identity.smokeId,
      project_id: projectId,
      user_id: userId,
      conversation_id: conversationId,
      provider: input.provider,
      image_mode: imageMode,
      phase,
      purpose,
      budget_key: budgetKey,
      provider_fence_key: providerFenceKey,
      request_hash: requestHash,
      request_snapshot: request,
      run_id: identity.runId,
      tool_use_id: identity.toolUseId,
      target_id: null,
      state: 'prepared',
      authorized_at: null,
      submission_count: 0,
      artifact_hostnames: [],
      last_error: null,
      unknown_reconciled_at: null,
      unknown_reconciled_by: null,
      unknown_reconciliation_reason: null,
      finished_at: null,
    })
    return created.toObject() as SpatialOperatorSmokeIntentRecord
  } catch (error) {
    if (!duplicateKey(error)) throw error
    const winner = await SpatialOperatorSmokeIntentModel.findOne({
      $or: [
        { smoke_id: identity.smokeId },
        { project_id: projectId, phase, purpose },
        { project_id: projectId, phase, budget_key: budgetKey },
      ],
    }).lean<SpatialOperatorSmokeIntentRecord>()
    if (
      winner
      && winner.phase === phase
      && winner.purpose === purpose
      && sameFrozenIntent(winner, input, requestHash, phase, purpose)
    ) return winner
    throw new SpatialOperatorSmokeConflictError(
      `项目 ${projectId} 的 ${phase}/${budgetKey} 已有一个冻结的付费 smoke intent。`,
    )
  }
}

export async function getSpatialOperatorSmokeIntent(
  smokeId: string,
): Promise<SpatialOperatorSmokeIntentRecord | null> {
  await connectDB()
  return SpatialOperatorSmokeIntentModel.findOne({
    smoke_id: requireBoundedText('smokeId', smokeId, 128),
  }).lean<SpatialOperatorSmokeIntentRecord>()
}

export async function requireSpatialOperatorSmokeIntent(
  smokeId: string,
): Promise<SpatialOperatorSmokeIntentRecord> {
  const intent = await getSpatialOperatorSmokeIntent(smokeId)
  if (!intent) throw new SpatialOperatorSmokeConflictError('找不到对应的 Operator smoke intent。')
  return intent
}

/** Consume the exact human confirmation once; this does not call a provider. */
export async function authorizeSpatialOperatorSmokeIntent(
  smokeId: string,
  confirmation: string,
  now = new Date(),
): Promise<SpatialOperatorSmokeIntentRecord> {
  if (confirmation !== OPERATOR_PAID_CONFIRMATION) {
    throw new SpatialOperatorSmokeAuthorizationError(
      `必须逐字提供 --confirm ${OPERATOR_PAID_CONFIRMATION}`,
    )
  }
  await connectDB()
  let current = await requireSpatialOperatorSmokeIntent(smokeId)
  await reconcileSpatialOperatorSmokeProviderBackings({
    projectId: current.project_id,
    provider: current.provider,
  })
  current = await requireSpatialOperatorSmokeIntent(smokeId)
  if (['failed', 'unknown', 'published'].includes(current.state)) {
    throw new SpatialOperatorSmokeAuthorizationError(`终态 ${current.state} 不允许再次授权提交。`)
  }
  await assertNoUnreconciledUnknown(
    current.project_id,
    current.provider_fence_key || operatorSmokeProviderFenceKey(current.provider),
  )
  await acquireOperatorProviderSubmissionGuard(current)
  if (current.authorized_at) return current
  const updated = await SpatialOperatorSmokeIntentModel.findOneAndUpdate(
    {
      smoke_id: current.smoke_id,
      state: 'prepared',
      authorized_at: null,
      submission_count: 0,
    },
    { $set: { state: 'authorized', authorized_at: now, last_error: null } },
    { returnDocument: 'after' },
  ).lean<SpatialOperatorSmokeIntentRecord>()
  if (updated) return updated
  const winner = await requireSpatialOperatorSmokeIntent(smokeId)
  if (['failed', 'unknown', 'published'].includes(winner.state)) {
    await settleOperatorProviderSubmissionGuard(winner)
    throw new SpatialOperatorSmokeAuthorizationError(`终态 ${winner.state} 不允许再次授权提交。`)
  }
  return winner
}

/**
 * Record an operator's out-of-band provider accounting decision. This never
 * changes or reopens the unknown intent; it only releases the project/provider
 * fence for a separately identified future intent.
 */
export async function reconcileSpatialOperatorSmokeUnknown(
  smokeId: string,
  input: { confirmation: string; actor: string; reason: string },
  now = new Date(),
): Promise<SpatialOperatorSmokeIntentRecord> {
  if (input.confirmation !== OPERATOR_UNKNOWN_RECONCILIATION_CONFIRMATION) {
    throw new SpatialOperatorSmokeAuthorizationError(
      `必须逐字提供 --confirm ${OPERATOR_UNKNOWN_RECONCILIATION_CONFIRMATION}`,
    )
  }
  await connectDB()
  let current = await requireSpatialOperatorSmokeIntent(smokeId)
  await reconcileSpatialOperatorSmokeProviderBackings({
    projectId: current.project_id,
    provider: current.provider,
  })
  current = await requireSpatialOperatorSmokeIntent(smokeId)
  if (current.state !== 'unknown') {
    throw new SpatialOperatorSmokeConflictError('只有 durable state=unknown 的 intent 可以人工核销。')
  }
  const actor = requireBoundedText('actor', input.actor, 160)
  const reason = requireBoundedText('reason', input.reason, 1_000)
  if (current.unknown_reconciled_at) {
    if (
      current.unknown_reconciled_by === actor
      && current.unknown_reconciliation_reason === reason
    ) return settleOperatorProviderSubmissionGuard(current)
    throw new SpatialOperatorSmokeConflictError('unknown 已有不同的人工核销记录，禁止覆盖审计事实。')
  }
  const updated = await SpatialOperatorSmokeIntentModel.findOneAndUpdate(
    {
      smoke_id: current.smoke_id,
      state: 'unknown',
      unknown_reconciled_at: null,
    },
    {
      $set: {
        unknown_reconciled_at: now,
        unknown_reconciled_by: actor,
        unknown_reconciliation_reason: reason,
      },
    },
    { returnDocument: 'after' },
  ).lean<SpatialOperatorSmokeIntentRecord>()
  if (updated) return settleOperatorProviderSubmissionGuard(updated)
  const winner = await requireSpatialOperatorSmokeIntent(smokeId)
  if (
    winner.unknown_reconciled_at
    && winner.unknown_reconciled_by === actor
    && winner.unknown_reconciliation_reason === reason
  ) return settleOperatorProviderSubmissionGuard(winner)
  throw new SpatialOperatorSmokeConflictError('unknown 核销发生并发冲突；审计事实未被本次操作覆盖。')
}

export async function syncSpatialOperatorSmokeIntent(
  smokeId: string,
  backing: OperatorSmokeBackingStatus,
): Promise<SpatialOperatorSmokeIntentRecord> {
  await connectDB()
  const artifactHostnames = [...new Set(
    (backing.artifactHostnames ?? []).map(host => host.trim().toLowerCase()).filter(Boolean),
  )].filter(host => /^[a-z0-9.-]+$/.test(host)).sort()
  const terminalStates = new Set<SpatialOperatorSmokeState>(['published', 'failed', 'unknown'])
  const rank: Record<SpatialOperatorSmokeState, number> = {
    prepared: 0,
    authorized: 1,
    submitting: 2,
    submitted: 3,
    running: 4,
    materializing: 5,
    configuration_blocked: 6,
    published: 7,
    failed: 7,
    unknown: 7,
  }

  // Compare-and-set makes stale status readers harmless. In particular, once
  // an intent reaches any terminal state it can never be reopened (or changed
  // to a different terminal state) by a delayed sync.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await requireSpatialOperatorSmokeIntent(smokeId)
    if (
      (terminalStates.has(current.state) && backing.state !== current.state)
      || rank[backing.state] < rank[current.state]
    ) return settleOperatorProviderSubmissionGuard(current)

    const submissionCount = Math.max(current.submission_count, Math.min(1, backing.submissionCount))
    const terminal = terminalStates.has(backing.state)
    const updated = await SpatialOperatorSmokeIntentModel.findOneAndUpdate(
      { smoke_id: current.smoke_id, state: current.state },
      {
        $set: {
          ...(backing.targetId !== undefined ? { target_id: backing.targetId } : {}),
          state: backing.state,
          submission_count: submissionCount,
          artifact_hostnames: artifactHostnames,
          last_error: backing.lastError?.trim().slice(0, 4_000) || null,
          finished_at: terminal ? backing.finishedAt ?? current.finished_at ?? new Date() : null,
        },
      },
      { returnDocument: 'after' },
    ).lean<SpatialOperatorSmokeIntentRecord>()
    if (updated) return settleOperatorProviderSubmissionGuard(updated)
  }
  throw new SpatialOperatorSmokeConflictError('Operator smoke intent 在并发同步时持续发生冲突。')
}
