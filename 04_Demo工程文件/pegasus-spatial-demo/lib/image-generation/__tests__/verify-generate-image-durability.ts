import assert from 'node:assert/strict'
import type { AgentExecutionContext, ToolExecutionInvocation } from '../../agent/execution-context'
import type { RasterAssetRef } from '../../types'
import { createInMemoryWorkspace } from '../../tools/__test-utils__/in-memory-workspace'
import { executeGenerateImage, type GenerateImageInput } from '../../tools/generate-image'
import {
  executeInspectSpatialArtifact,
  type SpatialToolDependencies,
} from '../../tools/spatial'
import { ImageGenerationProviderError } from '../errors'
import { NewApiChatImageAdapter } from '../providers/newapi-chat-image'
import { imagePaidSlotDisposition } from '../receipt-store'
import {
  SpatialPaidCapacityError,
  parseSpatialToolResult,
  type RegisterPublishedSpatialArtifactInput,
  type SpatialArtifactNodeRecord,
  type SpatialPaidHolderType,
  type SpatialPaidSlotClaim,
} from '../../spatial'
import type {
  GenerateImageDependencies,
  ImageGenerationReceipt,
  ImageGenerationReceiptKey,
  ImageGenerationProviderSnapshot,
  ImageGenerationReceiptStore,
  NewImageGenerationReceipt,
} from '../types'

function keyString(key: ImageGenerationReceiptKey): string {
  return `${key.projectId}:${key.runId}:${key.toolUseId}`
}

function clone(receipt: ImageGenerationReceipt): ImageGenerationReceipt {
  return structuredClone(receipt)
}

class MemoryReceiptStore implements ImageGenerationReceiptStore {
  readonly values = new Map<string, ImageGenerationReceipt>()

  async get(key: ImageGenerationReceiptKey): Promise<ImageGenerationReceipt | null> {
    const value = this.values.get(keyString(key))
    return value ? clone(value) : null
  }

  async createOrGet(input: NewImageGenerationReceipt) {
    const key = keyString(input)
    const current = this.values.get(key)
    if (current) return { receipt: clone(current), created: false }
    const now = new Date('2026-08-25T00:00:00.000Z')
    const receipt: ImageGenerationReceipt = {
      ...input,
      provider: input.providerSnapshot.provider,
      model: input.providerSnapshot.model,
      status: 'prepared',
      createdAt: now,
      updatedAt: now,
    }
    this.values.set(key, receipt)
    return { receipt: clone(receipt), created: true }
  }

  async claimSubmission(
    key: ImageGenerationReceiptKey,
    owner: string,
    now: Date,
    providerSnapshot: ImageGenerationProviderSnapshot,
  ) {
    const receipt = this.values.get(keyString(key))
    if (!receipt || receipt.status !== 'prepared') return null
    if (
      receipt.providerSnapshot?.provider !== providerSnapshot.provider
      || receipt.providerSnapshot.model !== providerSnapshot.model
      || receipt.providerSnapshot.configurationFingerprint
        !== providerSnapshot.configurationFingerprint
    ) return null
    receipt.status = 'submitting'
    receipt.submissionOwner = owner
    receipt.submissionStartedAt = now
    receipt.updatedAt = now
    return clone(receipt)
  }

  async markAssetStored(
    key: ImageGenerationReceiptKey,
    owner: string,
    asset: RasterAssetRef,
    assetSha256: string,
    providerRequestId: string | undefined,
    now: Date,
  ) {
    const receipt = this.required(key)
    assert.equal(receipt.status, 'submitting')
    assert.equal(receipt.submissionOwner, owner)
    receipt.status = 'asset_stored'
    receipt.asset = structuredClone(asset)
    receipt.assetSha256 = assetSha256
    receipt.providerRequestId = providerRequestId
    receipt.updatedAt = now
    return clone(receipt)
  }

  async adoptClaimedAsset(
    key: ImageGenerationReceipt,
    expectedAssetId: string,
    asset: RasterAssetRef,
    assetSha256: string,
    now: Date,
  ) {
    const receipt = this.required(key)
    assert.equal(receipt.status, 'asset_stored')
    assert.equal(receipt.asset?.assetId, expectedAssetId)
    receipt.asset = structuredClone(asset)
    receipt.assetSha256 = assetSha256
    receipt.updatedAt = now
    return clone(receipt)
  }

  async markPublished(
    key: ImageGenerationReceiptKey,
    asset: RasterAssetRef,
    resultContent: string,
    now: Date,
  ) {
    const receipt = this.required(key)
    assert.equal(receipt.status, 'asset_stored')
    assert.equal(receipt.asset?.assetId, asset.assetId)
    receipt.status = 'published'
    receipt.resultContent = resultContent
    receipt.updatedAt = now
    return clone(receipt)
  }

  async markFailed(
    key: ImageGenerationReceiptKey,
    owner: string,
    code: string,
    message: string,
    now: Date,
  ) {
    const receipt = this.required(key)
    assert.equal(receipt.submissionOwner, owner)
    receipt.status = 'failed'
    receipt.errorCode = code
    receipt.errorMessage = message
    receipt.updatedAt = now
    return clone(receipt)
  }

  async markUnknown(
    key: ImageGenerationReceiptKey,
    code: string,
    message: string,
    now: Date,
  ) {
    const receipt = this.required(key)
    receipt.status = 'unknown'
    receipt.errorCode = code
    receipt.errorMessage = message
    receipt.updatedAt = now
    return clone(receipt)
  }

  required(key: ImageGenerationReceiptKey): ImageGenerationReceipt {
    const receipt = this.values.get(keyString(key))
    if (!receipt) throw new Error('missing receipt')
    return receipt
  }
}

class HideNextGetReceiptStore extends MemoryReceiptStore {
  hideNext = false

  override async get(key: ImageGenerationReceiptKey): Promise<ImageGenerationReceipt | null> {
    if (this.hideNext) {
      this.hideNext = false
      return null
    }
    return super.get(key)
  }
}

class MemoryPaidCapacity {
  private readonly holders = new Map<string, SpatialPaidSlotClaim>()
  maxOccupied = 0

  readonly imageCoordinator: NonNullable<GenerateImageDependencies['paidSlots']> = {
    acquire: input => this.acquire('image_generation', input),
    bind: claim => this.bind(claim),
    release: input => this.release('image_generation', input),
  }

  async acquire(
    holderType: SpatialPaidHolderType,
    input: { projectId: string; userId: string; holderKey: string },
  ): Promise<SpatialPaidSlotClaim> {
    const identity = `${input.projectId}:${holderType}:${input.holderKey}`
    const existing = this.holders.get(identity)
    if (existing) return structuredClone(existing)
    const occupied = new Set(
      [...this.holders.values()]
        .filter(value => value.projectId === input.projectId && value.holderType === holderType)
        .map(value => value.slot),
    )
    const slot = ([0, 1] as const).find(candidate => !occupied.has(candidate))
    if (slot === undefined) throw new SpatialPaidCapacityError(input.projectId)
    const claim: SpatialPaidSlotClaim = {
      ...input,
      slot,
      holderType,
      reservationToken: `reservation_${holderType}_${input.holderKey}`,
      state: 'reserved',
    }
    this.holders.set(identity, claim)
    this.maxOccupied = Math.max(this.maxOccupied, this.size(input.projectId))
    return structuredClone(claim)
  }

  async bind(claim: SpatialPaidSlotClaim): Promise<SpatialPaidSlotClaim> {
    const identity = `${claim.projectId}:${claim.holderType}:${claim.holderKey}`
    const current = this.holders.get(identity)
    assert.ok(current)
    current.state = 'active'
    return structuredClone(current)
  }

  async release(
    holderType: SpatialPaidHolderType,
    input: { projectId: string; userId: string; holderKey: string; reservationToken?: string },
  ): Promise<boolean> {
    const identity = `${input.projectId}:${holderType}:${input.holderKey}`
    const current = this.holders.get(identity)
    if (!current || current.userId !== input.userId) return false
    if (input.reservationToken && current.reservationToken !== input.reservationToken) return false
    return this.holders.delete(identity)
  }

  size(projectId: string): number {
    return [...this.holders.values()].filter(value => value.projectId === projectId).length
  }

  reconcile(activeHolderKeys: ReadonlySet<string>): number {
    let released = 0
    for (const [identity, claim] of this.holders) {
      if (activeHolderKeys.has(claim.holderKey)) continue
      this.holders.delete(identity)
      released += 1
    }
    return released
  }
}

const executionContext: AgentExecutionContext = {
  userId: 'user_1',
  conversationId: 'conversation_1',
  workspaceId: 'project_1',
  runId: 'run_1',
  isRoot: true,
}

const invocation: ToolExecutionInvocation = {
  toolUseId: 'tool_1',
  actionId: 'action_1',
  turn: 1,
}

const input: GenerateImageInput = {
  prompt: 'A calm reading room',
  output_path: 'output/spatial/images/room.png',
  aspect_ratio: '16:9',
}

const TEST_IMAGE_PROVIDER_IDENTITY = {
  provider: 'test-provider',
  model: 'test-image-model',
  configurationFingerprint: '1'.repeat(64),
}

const SWITCHED_IMAGE_PROVIDER_IDENTITY = {
  provider: 'different-image-contract-v2',
  model: 'different-image-model',
  configurationFingerprint: '2'.repeat(64),
}

function fakeAsset(assetId = 'asset_generated'): RasterAssetRef {
  return {
    assetId,
    mimeType: 'image/png',
    width: 1536,
    height: 1024,
    sizeBytes: 1234,
    urls: {
      original: `/api/media/${assetId}/original`,
      model: `/api/media/${assetId}/model`,
      thumbnail: `/api/media/${assetId}/thumbnail`,
    },
  }
}

function setup(
  receipts = new MemoryReceiptStore(),
  hooks?: GenerateImageDependencies['hooks'],
) {
  let providerCalls = 0
  let persistedBytes = 0
  const dependencies: GenerateImageDependencies = {
    provider: {
      ...TEST_IMAGE_PROVIDER_IDENTITY,
      async generate(request) {
        providerCalls += 1
        assert.equal(request.prompt, input.prompt)
        return {
          buffer: Buffer.from('server-only-image-bytes'),
          mimeType: 'image/png',
          providerRequestId: 'provider_request_1',
        }
      },
    },
    receipts,
    async storeGeneratedImage({ output }) {
      persistedBytes += output.buffer.length
      return { asset: fakeAsset(), sha256: 'a'.repeat(64) }
    },
    async claimStoredImage({ asset, sha256 }) {
      return { asset: structuredClone(asset), sha256 }
    },
    now: () => new Date('2026-08-25T00:00:10.000Z'),
    randomId: () => 'execution_1',
    hooks,
  }
  return {
    dependencies,
    providerCalls: () => providerCalls,
    persistedBytes: () => persistedBytes,
  }
}

function assertByteFree(value: unknown): void {
  const visit = (candidate: unknown): void => {
    assert.equal(Buffer.isBuffer(candidate), false, 'ToolResult must not contain Buffer')
    if (typeof candidate === 'string') {
      assert.doesNotMatch(candidate, /base64|data:image/i)
      assert.notEqual(candidate, 'server-only-image-bytes')
      return
    }
    if (!candidate || typeof candidate !== 'object') return
    for (const child of Object.values(candidate)) visit(child)
  }
  visit(value)
}

// Normal execution publishes once; published recovery never calls the provider.
{
  const workspace = createInMemoryWorkspace()
  const state = setup()
  const first = await executeGenerateImage(input, workspace, {
    executionContext,
    invocation,
    dependencies: state.dependencies,
  })
  assert.equal(first.is_error, undefined)
  assert.equal(state.providerCalls(), 1)
  assert.equal(state.persistedBytes(), Buffer.byteLength('server-only-image-bytes'))
  assert.equal(workspace.dumpRasters()[input.output_path].assetId, 'asset_generated')
  const firstEnvelope = parseSpatialToolResult(first.content)
  assert.equal(firstEnvelope?.artifact_id, 'asset_generated')
  assert.equal(firstEnvelope?.created_at, '2026-08-25T00:00:00.000Z')
  assert.equal(firstEnvelope?.elapsed_ms, 10_000)
  assertByteFree(first)

  let switchedProviderCalls = 0
  state.dependencies.provider = {
    ...SWITCHED_IMAGE_PROVIDER_IDENTITY,
    async generate() {
      switchedProviderCalls += 1
      throw new Error('published recovery must not call the current provider')
    },
  }
  const recovered = await executeGenerateImage(input, workspace, {
    executionContext,
    invocation,
    dependencies: state.dependencies,
  })
  assert.equal(recovered.is_error, undefined)
  assert.deepEqual(recovered, first)
  assert.equal(state.providerCalls(), 1)
  assert.equal(switchedProviderCalls, 0)
  assertByteFree(recovered)
}

// A true process loss after private staging but before receipt linkage never
// claims an active media capability. The submitting receipt ages to unknown,
// so recovery cannot silently pay for a second provider call; normal staged
// media TTL cleanup owns the unreferenced bytes.
{
  const workspace = createInMemoryWorkspace()
  const receipts = new MemoryReceiptStore()
  let claimCalls = 0
  const crashing = setup(receipts, {
    afterAssetStagedBeforeReceipt() {
      throw new Error('simulated process loss after private media staging')
    },
  })
  crashing.dependencies.claimStoredImage = async input => {
    claimCalls += 1
    return { asset: structuredClone(input.asset), sha256: input.sha256 }
  }
  const context = { ...executionContext, runId: 'run_private_stage_crash' }
  const first = await executeGenerateImage(input, workspace, {
    executionContext: context,
    invocation,
    dependencies: crashing.dependencies,
  })
  assert.equal(first.is_error, true)
  assert.equal(crashing.providerCalls(), 1)
  assert.equal(claimCalls, 0, 'private bytes must not become an active capability before receipt linkage')
  assert.equal(workspace.exists(input.output_path), false)

  const recovery = setup(receipts)
  recovery.dependencies.now = () => new Date('2026-08-25T00:20:00.000Z')
  recovery.dependencies.submissionLeaseMs = 100
  const second = await executeGenerateImage(input, workspace, {
    executionContext: context,
    invocation,
    dependencies: recovery.dependencies,
  })
  assert.equal(second.is_error, true)
  assert.match(second.content, /状态未知/)
  assert.equal(recovery.providerCalls(), 0)
}

// Crash after asset receipt: recovery publishes the stored asset without paying again.
{
  const workspace = createInMemoryWorkspace()
  const receipts = new MemoryReceiptStore()
  const capacity = new MemoryPaidCapacity()
  const crashing = setup(receipts, {
    afterAssetStored() { throw new Error('simulated crash after asset receipt') },
  })
  crashing.dependencies.paidSlots = capacity.imageCoordinator
  const first = await executeGenerateImage(input, workspace, {
    executionContext: { ...executionContext, runId: 'run_asset_crash' },
    invocation,
    dependencies: crashing.dependencies,
  })
  assert.equal(first.is_error, true)
  assert.equal(workspace.exists(input.output_path), false)
  assert.equal(crashing.providerCalls(), 1)
  assert.equal(capacity.size('project_1'), 0, 'asset_stored must release paid capacity')

  const recovery = setup(receipts)
  recovery.dependencies.paidSlots = capacity.imageCoordinator
  let switchedProviderCalls = 0
  recovery.dependencies.provider = {
    ...SWITCHED_IMAGE_PROVIDER_IDENTITY,
    async generate() {
      switchedProviderCalls += 1
      throw new Error('asset_stored recovery must not call the current provider')
    },
  }
  const second = await executeGenerateImage(input, workspace, {
    executionContext: { ...executionContext, runId: 'run_asset_crash' },
    invocation,
    dependencies: recovery.dependencies,
  })
  assert.equal(second.is_error, undefined)
  assert.equal(recovery.providerCalls(), 0)
  assert.equal(switchedProviderCalls, 0)
  assert.equal(workspace.dumpRasters()[input.output_path].assetId, 'asset_generated')
  assert.equal(capacity.size('project_1'), 0)
  assertByteFree(second)
}

// Crash after Workspace publication: recovery recognizes the same head and only seals receipt.
{
  const workspace = createInMemoryWorkspace()
  const receipts = new MemoryReceiptStore()
  const crashing = setup(receipts, {
    afterWorkspacePublished() { throw new Error('simulated crash after Workspace publish') },
  })
  const context = { ...executionContext, runId: 'run_workspace_crash' }
  const first = await executeGenerateImage(input, workspace, {
    executionContext: context,
    invocation,
    dependencies: crashing.dependencies,
  })
  assert.equal(first.is_error, true)
  assert.equal(workspace.dumpRasters()[input.output_path].assetId, 'asset_generated')

  const recovery = setup(receipts)
  const second = await executeGenerateImage(input, workspace, {
    executionContext: context,
    invocation,
    dependencies: recovery.dependencies,
  })
  assert.equal(second.is_error, undefined)
  assert.equal(recovery.providerCalls(), 0)
  assertByteFree(second)
}

// A process loss after claiming submission ages into unknown, never a second paid call.
{
  const workspace = createInMemoryWorkspace()
  const receipts = new MemoryReceiptStore()
  const crashing = setup(receipts, {
    afterSubmissionClaimed() { throw new Error('simulated process loss before provider call') },
  })
  const context = { ...executionContext, runId: 'run_submission_crash' }
  const first = await executeGenerateImage(input, workspace, {
    executionContext: context,
    invocation,
    dependencies: crashing.dependencies,
  })
  assert.equal(first.is_error, true)
  assert.equal(crashing.providerCalls(), 0)

  const recovery = setup(receipts)
  recovery.dependencies.now = () => new Date('2026-08-25T00:20:00.000Z')
  recovery.dependencies.submissionLeaseMs = 100
  const second = await executeGenerateImage(input, workspace, {
    executionContext: context,
    invocation,
    dependencies: recovery.dependencies,
  })
  assert.equal(second.is_error, true)
  assert.match(second.content, /状态未知/)
  assert.equal(recovery.providerCalls(), 0)
  const receipt = await receipts.get({
    projectId: executionContext.workspaceId!,
    runId: context.runId,
    toolUseId: invocation.toolUseId,
  })
  assert.equal(receipt?.status, 'unknown')
}

// Single-image editing freezes the Workspace parent asset in durable lineage.
{
  const workspace = createInMemoryWorkspace()
  const parent = fakeAsset('asset_parent')
  await workspace.writeRaster('output/spatial/images/source.png', parent)
  workspace.readRasterBuffer = async path => path === 'output/spatial/images/source.png'
    ? Buffer.from('workspace-parent-bytes')
    : null
  const receipts = new MemoryReceiptStore()
  const state = setup(receipts)
  let receivedParent = ''
  let registeredInput: RegisterPublishedSpatialArtifactInput | undefined
  let registeredArtifact: SpatialArtifactNodeRecord | undefined
  state.dependencies.registerPublishedArtifact = async candidate => {
    registeredInput = structuredClone(candidate)
    const now = new Date('2026-08-25T00:00:10.000Z')
    registeredArtifact = {
      artifact_id: candidate.artifactId,
      job_id: candidate.jobId,
      project_id: candidate.projectId,
      user_id: candidate.userId,
      provider: candidate.provider,
      kind: candidate.kind,
      state: 'published',
      publication_token: candidate.publicationToken,
      provider_asset_key: candidate.providerAssetKey,
      filename: candidate.filename,
      workspace_path: candidate.workspacePath,
      storage_uri: candidate.storageUri,
      mime_type: candidate.mimeType,
      size_bytes: candidate.sizeBytes,
      sha256: candidate.sha256,
      relations: structuredClone(candidate.relations ?? []),
      metadata: structuredClone(candidate.metadata ?? {}),
      created_at: now,
      updated_at: now,
    }
    return registeredArtifact
  }
  state.dependencies.provider = {
    ...TEST_IMAGE_PROVIDER_IDENTITY,
    async generate(request) {
      receivedParent = request.source?.assetId || ''
      assert.equal(request.source?.buffer.toString(), 'workspace-parent-bytes')
      return {
        buffer: Buffer.from('server-only-image-bytes'),
        mimeType: 'image/png',
      }
    },
  }
  const editInput: GenerateImageInput = {
    prompt: 'Move the chair closer to the window',
    input_image_path: 'output/spatial/images/source.png',
    output_path: 'output/spatial/images/revision.png',
  }
  const context = { ...executionContext, runId: 'run_edit_lineage' }
  const result = await executeGenerateImage(editInput, workspace, {
    executionContext: context,
    invocation,
    dependencies: state.dependencies,
  })
  assert.equal(result.is_error, undefined)
  assert.equal(receivedParent, 'asset_parent')
  assert.match(result.content, /asset_parent/)
  const receipt = await receipts.get({
    projectId: executionContext.workspaceId!,
    runId: context.runId,
    toolUseId: invocation.toolUseId,
  })
  assert.equal(receipt?.parentAssetId, 'asset_parent')
  assert.equal(registeredInput?.artifactId, 'asset_generated')
  assert.equal(registeredInput?.storageUri, 'asset:asset_generated')
  assert.deepEqual(registeredInput?.relations, [{
    kind: 'revision_of',
    artifact_id: 'asset_parent',
  }])
  const resultEnvelope = JSON.parse(result.content) as { artifact_id?: string }
  assert.equal(resultEnvelope.artifact_id, registeredArtifact?.artifact_id)

  const inspectDependencies = {
    now: () => new Date('2026-08-25T00:00:10.000Z'),
    async inspectSpatialArtifactResult({ artifactId }: { artifactId: string }) {
      assert.equal(artifactId, registeredArtifact?.artifact_id)
      return {
        schema_version: 1 as const,
        job_id: registeredArtifact!.job_id,
        artifact_id: registeredArtifact!.artifact_id,
        kind: 'artifact' as const,
        status: 'published' as const,
        provider: registeredArtifact!.provider,
        workspace_paths: [registeredArtifact!.workspace_path],
        updated_at: registeredArtifact!.updated_at.toISOString(),
      }
    },
  } as SpatialToolDependencies
  const inspected = await executeInspectSpatialArtifact({
    artifact_id: resultEnvelope.artifact_id,
  }, {
    executionContext: context,
    invocation,
    dependencies: inspectDependencies,
  })
  assert.equal(parseSpatialToolResult(inspected.content)?.artifact_id, 'asset_generated')
  assertByteFree(result)
}

// The durable command key cannot be reused with altered input.
{
  const workspace = createInMemoryWorkspace()
  const state = setup()
  const context = { ...executionContext, runId: 'run_input_conflict' }
  await executeGenerateImage(input, workspace, {
    executionContext: context,
    invocation,
    dependencies: state.dependencies,
  })
  const conflict = await executeGenerateImage({ ...input, prompt: 'A different room' }, workspace, {
    executionContext: context,
    invocation,
    dependencies: state.dependencies,
  })
  assert.equal(conflict.is_error, true)
  assert.match(conflict.content, /不同的 GenerateImage 输入/)
  assert.equal(state.providerCalls(), 1)
}

// New receipts freeze a provider-independent command hash plus a secret-free
// transport snapshot. Even a real adapter configuration cannot leak its base
// URL or API key into Mongo.
{
  const workspace = createInMemoryWorkspace()
  const receipts = new MemoryReceiptStore()
  const capacity = new MemoryPaidCapacity()
  const state = setup(receipts, {
    afterPaidSlotBound() {
      throw new Error('stop after durable provider snapshot')
    },
  })
  state.dependencies.paidSlots = capacity.imageCoordinator
  state.dependencies.provider = new NewApiChatImageAdapter({
    apiKey: 'receipt-secret-must-not-persist',
    apiBase: 'https://private-gateway.example.invalid/v1',
    model: 'GPT-image-2',
  })
  const context = { ...executionContext, runId: 'run_secret_free_snapshot' }
  const result = await executeGenerateImage(input, workspace, {
    executionContext: context,
    invocation,
    dependencies: state.dependencies,
  })
  assert.equal(result.is_error, true)
  assert.equal(state.providerCalls(), 0)
  const receipt = receipts.required({
    projectId: executionContext.workspaceId!,
    runId: context.runId,
    toolUseId: invocation.toolUseId,
  })
  assert.match(receipt.commandHash || '', /^[a-f0-9]{64}$/)
  assert.deepEqual(Object.keys(receipt.providerSnapshot || {}).sort(), [
    'configurationFingerprint',
    'model',
    'provider',
  ])
  assert.match(receipt.providerSnapshot?.configurationFingerprint || '', /^[a-f0-9]{64}$/)
  const serialized = JSON.stringify(receipt)
  assert.doesNotMatch(serialized, /receipt-secret-must-not-persist/)
  assert.doesNotMatch(serialized, /private-gateway\.example\.invalid/)
  assert.equal(capacity.size('project_1'), 0)
}

// A prepared paid command may resume only under its exact frozen provider
// snapshot. A deployment/config switch fails closed, while restoring the
// original snapshot can safely perform the first provider submission.
{
  const workspace = createInMemoryWorkspace()
  const receipts = new MemoryReceiptStore()
  const capacity = new MemoryPaidCapacity()
  const crashing = setup(receipts, {
    afterPaidSlotBound() {
      throw new Error('simulated crash with prepared receipt')
    },
  })
  crashing.dependencies.paidSlots = capacity.imageCoordinator
  const context = { ...executionContext, runId: 'run_prepared_provider_switch' }
  const first = await executeGenerateImage(input, workspace, {
    executionContext: context,
    invocation,
    dependencies: crashing.dependencies,
  })
  assert.equal(first.is_error, true)
  assert.equal(crashing.providerCalls(), 0)

  const switched = setup(receipts)
  switched.dependencies.provider = {
    ...SWITCHED_IMAGE_PROVIDER_IDENTITY,
    async generate() {
      throw new Error('mismatched prepared snapshot must not submit')
    },
  }
  const blocked = await executeGenerateImage(input, workspace, {
    executionContext: context,
    invocation,
    dependencies: switched.dependencies,
  })
  assert.equal(blocked.is_error, true)
  assert.match(blocked.content, /协议或配置已变化/)
  assert.equal(receipts.required({
    projectId: executionContext.workspaceId!,
    runId: context.runId,
    toolUseId: invocation.toolUseId,
  }).status, 'prepared')

  const restored = setup(receipts)
  const completed = await executeGenerateImage(input, workspace, {
    executionContext: context,
    invocation,
    dependencies: restored.dependencies,
  })
  assert.equal(completed.is_error, undefined)
  assert.equal(restored.providerCalls(), 1)
}

// Legacy terminal receipts still validate the exact former provider-bound
// request hash and recover without consulting the newly configured provider.
{
  const workspace = createInMemoryWorkspace()
  const receipts = new MemoryReceiptStore()
  const original = setup(receipts)
  const context = { ...executionContext, runId: 'run_legacy_published' }
  const first = await executeGenerateImage(input, workspace, {
    executionContext: context,
    invocation,
    dependencies: original.dependencies,
  })
  assert.equal(first.is_error, undefined)
  const legacy = receipts.required({
    projectId: executionContext.workspaceId!,
    runId: context.runId,
    toolUseId: invocation.toolUseId,
  })
  delete legacy.commandHash
  delete legacy.providerSnapshot

  let switchedCalls = 0
  const recovery = setup(receipts)
  recovery.dependencies.provider = {
    ...SWITCHED_IMAGE_PROVIDER_IDENTITY,
    async generate() {
      switchedCalls += 1
      throw new Error('legacy published recovery must not submit')
    },
  }
  const recovered = await executeGenerateImage(input, workspace, {
    executionContext: context,
    invocation,
    dependencies: recovery.dependencies,
  })
  assert.deepEqual(recovered, first)
  assert.equal(switchedCalls, 0)

  const conflict = await executeGenerateImage({ ...input, prompt: 'changed legacy command' }, workspace, {
    executionContext: context,
    invocation,
    dependencies: recovery.dependencies,
  })
  assert.equal(conflict.is_error, true)
  assert.match(conflict.content, /不同的 GenerateImage 输入/)
}

// A legacy prepared receipt has no configuration fingerprint proving which
// paid transport would be used. It therefore fails closed even if its old
// provider/model labels happen to match the current process.
{
  const workspace = createInMemoryWorkspace()
  const receipts = new MemoryReceiptStore()
  const capacity = new MemoryPaidCapacity()
  const crashing = setup(receipts, {
    afterPaidSlotBound() {
      throw new Error('simulated legacy prepared crash')
    },
  })
  crashing.dependencies.paidSlots = capacity.imageCoordinator
  const context = { ...executionContext, runId: 'run_legacy_prepared' }
  await executeGenerateImage(input, workspace, {
    executionContext: context,
    invocation,
    dependencies: crashing.dependencies,
  })
  const legacy = receipts.required({
    projectId: executionContext.workspaceId!,
    runId: context.runId,
    toolUseId: invocation.toolUseId,
  })
  delete legacy.commandHash
  delete legacy.providerSnapshot

  const recovery = setup(receipts)
  const blocked = await executeGenerateImage(input, workspace, {
    executionContext: context,
    invocation,
    dependencies: recovery.dependencies,
  })
  assert.equal(blocked.is_error, true)
  assert.match(blocked.content, /prepared receipt 来自旧版/)
  assert.equal(recovery.providerCalls(), 0)
  assert.equal(legacy.status, 'prepared')
}

// A createOrGet race can reveal an exact-input conflict only after this
// process reserved capacity. Release that still-reserved claim immediately.
{
  const workspace = createInMemoryWorkspace()
  const receipts = new HideNextGetReceiptStore()
  const initial = setup(receipts)
  const context = { ...executionContext, runId: 'run_late_input_conflict' }
  await executeGenerateImage(input, workspace, {
    executionContext: context,
    invocation,
    dependencies: initial.dependencies,
  })

  const capacity = new MemoryPaidCapacity()
  const racing = setup(receipts)
  racing.dependencies.paidSlots = capacity.imageCoordinator
  receipts.hideNext = true
  const conflict = await executeGenerateImage({ ...input, prompt: 'Different raced input' }, workspace, {
    executionContext: context,
    invocation,
    dependencies: racing.dependencies,
  })
  assert.equal(conflict.is_error, true)
  assert.match(conflict.content, /durable receipt 与当前输入不一致/)
  assert.equal(capacity.size('project_1'), 0, 'late mismatch must release its reserved slot')
  assert.equal(racing.providerCalls(), 0)
}

// Ambiguous transport loss is sealed as unknown and cannot trigger a replay.
{
  const workspace = createInMemoryWorkspace()
  const receipts = new MemoryReceiptStore()
  const state = setup(receipts)
  let calls = 0
  state.dependencies.provider = {
    ...TEST_IMAGE_PROVIDER_IDENTITY,
    async generate() {
      calls += 1
      throw new ImageGenerationProviderError('socket closed after upload', {
        code: 'provider_transport_error',
        requestMayHaveBeenAccepted: true,
      })
    },
  }
  const context = { ...executionContext, runId: 'run_unknown_provider_result' }
  const first = await executeGenerateImage(input, workspace, {
    executionContext: context,
    invocation,
    dependencies: state.dependencies,
  })
  assert.equal(first.is_error, true)
  assert.match(first.content, /状态未知/)
  state.dependencies.provider = {
    ...SWITCHED_IMAGE_PROVIDER_IDENTITY,
    async generate() {
      calls += 1
      throw new Error('unknown recovery must not call the current provider')
    },
  }
  const second = await executeGenerateImage(input, workspace, {
    executionContext: context,
    invocation,
    dependencies: state.dependencies,
  })
  assert.equal(second.is_error, true)
  assert.equal(calls, 1)
}

// A definitive provider rejection is durable failed, also without hidden replay.
{
  const workspace = createInMemoryWorkspace()
  const receipts = new MemoryReceiptStore()
  const state = setup(receipts)
  let calls = 0
  state.dependencies.provider = {
    ...TEST_IMAGE_PROVIDER_IDENTITY,
    async generate() {
      calls += 1
      throw new ImageGenerationProviderError('prompt rejected', {
        code: 'provider_http_400',
        requestMayHaveBeenAccepted: false,
      })
    },
  }
  const context = { ...executionContext, runId: 'run_definitive_failure' }
  const first = await executeGenerateImage(input, workspace, {
    executionContext: context,
    invocation,
    dependencies: state.dependencies,
  })
  assert.equal(first.is_error, true)
  assert.match(first.content, /图片生成未完成/)
  state.dependencies.provider = {
    ...SWITCHED_IMAGE_PROVIDER_IDENTITY,
    async generate() {
      calls += 1
      throw new Error('failed recovery must not call the current provider')
    },
  }
  await executeGenerateImage(input, workspace, {
    executionContext: context,
    invocation,
    dependencies: state.dependencies,
  })
  assert.equal(calls, 1)
}

// Explicitly delegated Members use the same durable receipt/provider path.
{
  const workspace = createInMemoryWorkspace()
  const state = setup()
  const memberResult = await executeGenerateImage(input, workspace, {
    executionContext: { ...executionContext, isRoot: false, runId: 'run_member' },
    invocation,
    dependencies: state.dependencies,
  })
  assert.equal(memberResult.is_error, undefined)
  assert.equal(state.providerCalls(), 1)
}

// Operator prepare/resume reuses the production receipt without crossing the
// provider boundary. Only the explicit allow-submit call may claim it.
{
  const workspace = createInMemoryWorkspace()
  const state = setup(new MemoryReceiptStore())
  const capacity = new MemoryPaidCapacity()
  state.dependencies.paidSlots = capacity.imageCoordinator
  const context = { ...executionContext, runId: 'run_operator_prepare_policy' }
  const prepared = await executeGenerateImage(input, workspace, {
    executionContext: context,
    invocation,
    dependencies: state.dependencies,
    submissionPolicy: 'prepare-only',
  })
  assert.equal(prepared.is_error, undefined)
  assert.match(prepared.content, /"status":"prepared"/)
  assert.equal(state.providerCalls(), 0)
  assert.equal(capacity.size('project_1'), 0, 'prepare-only must not retain paid capacity')

  const resumed = await executeGenerateImage(input, workspace, {
    executionContext: context,
    invocation,
    dependencies: state.dependencies,
    submissionPolicy: 'forbid-submit',
  })
  assert.equal(resumed.is_error, undefined)
  assert.match(resumed.content, /"status":"prepared"/)
  assert.equal(state.providerCalls(), 0, 'forbid-submit must not claim a prepared receipt')

  const submitted = await executeGenerateImage(input, workspace, {
    executionContext: context,
    invocation,
    dependencies: state.dependencies,
    submissionPolicy: 'allow-submit',
  })
  assert.equal(submitted.is_error, undefined)
  assert.equal(state.providerCalls(), 1)
  assert.equal(capacity.size('project_1'), 0)
}

// Two concurrent images fill the shared paid capacity atomically; a third
// image cannot enter the provider until one terminal receipt releases a slot.
{
  const workspace = createInMemoryWorkspace()
  const state = setup(new MemoryReceiptStore())
  const capacity = new MemoryPaidCapacity()
  state.dependencies.paidSlots = capacity.imageCoordinator
  let providerStarts = 0
  let releaseProviders!: () => void
  const providerGate = new Promise<void>(resolve => { releaseProviders = resolve })
  state.dependencies.provider = {
    ...TEST_IMAGE_PROVIDER_IDENTITY,
    async generate() {
      providerStarts += 1
      await providerGate
      return { buffer: Buffer.from('server-only-image-bytes'), mimeType: 'image/png' }
    },
  }
  const first = executeGenerateImage({ ...input, output_path: 'output/spatial/images/one.png' }, workspace, {
    executionContext: { ...executionContext, runId: 'run_paid_one' },
    invocation,
    dependencies: state.dependencies,
  })
  const second = executeGenerateImage({ ...input, output_path: 'output/spatial/images/two.png' }, workspace, {
    executionContext: { ...executionContext, runId: 'run_paid_two' },
    invocation,
    dependencies: state.dependencies,
  })
  while (providerStarts < 2) await new Promise(resolve => setTimeout(resolve, 0))
  const third = await executeGenerateImage({ ...input, output_path: 'output/spatial/images/three.png' }, workspace, {
    executionContext: { ...executionContext, runId: 'run_paid_three' },
    invocation,
    dependencies: state.dependencies,
  })
  assert.equal(third.is_error, true)
  assert.match(third.content, /最多允许同时运行 2 个/)
  assert.equal(capacity.size('project_1'), 2)
  assert.equal(capacity.maxOccupied, 2)
  releaseProviders()
  const completed = await Promise.all([first, second])
  assert.ok(completed.every(result => result.is_error === undefined))
  assert.equal(capacity.size('project_1'), 0)
}

// Slow object/world builds and images have independent two-slot lanes. Two
// Lux builds must not prevent Agents from producing the next reference image.
{
  const workspace = createInMemoryWorkspace()
  const state = setup(new MemoryReceiptStore())
  const capacity = new MemoryPaidCapacity()
  state.dependencies.paidSlots = capacity.imageCoordinator
  const object = await capacity.acquire('spatial_build', {
    projectId: 'project_1',
    userId: 'user_1',
    holderKey: 'spjob_object_live',
  })
  await capacity.bind(object)
  let imagesStarted = 0
  let releaseImages!: () => void
  const imageGate = new Promise<void>(resolve => { releaseImages = resolve })
  state.dependencies.provider = {
    ...TEST_IMAGE_PROVIDER_IDENTITY,
    async generate() {
      imagesStarted += 1
      await imageGate
      return { buffer: Buffer.from('server-only-image-bytes'), mimeType: 'image/png' }
    },
  }
  const firstImage = executeGenerateImage({ ...input, output_path: 'output/spatial/images/mixed-one.png' }, workspace, {
    executionContext: { ...executionContext, runId: 'run_mixed_one' },
    invocation,
    dependencies: state.dependencies,
  })
  const secondImage = executeGenerateImage({ ...input, output_path: 'output/spatial/images/mixed-two.png' }, workspace, {
    executionContext: { ...executionContext, runId: 'run_mixed_two' },
    invocation,
    dependencies: state.dependencies,
  })
  while (imagesStarted < 2) await new Promise(resolve => setTimeout(resolve, 0))
  const rejected = await executeGenerateImage({ ...input, output_path: 'output/spatial/images/mixed-three.png' }, workspace, {
    executionContext: { ...executionContext, runId: 'run_mixed_three' },
    invocation,
    dependencies: state.dependencies,
  })
  assert.equal(rejected.is_error, true)
  assert.equal(capacity.maxOccupied, 3)
  await capacity.release('spatial_build', {
    projectId: object.projectId,
    userId: object.userId,
    holderKey: object.holderKey,
  })
  releaseImages()
  await Promise.all([firstImage, secondImage])
  assert.equal(capacity.size('project_1'), 0)
}

// A process can die after reservation and before receipt creation. Startup
// reconciliation treats the missing holder as inactive and returns the slot.
{
  const capacity = new MemoryPaidCapacity()
  const abandoned = await capacity.acquire('image_generation', {
    projectId: 'project_1',
    userId: 'user_1',
    holderKey: 'spimg_crashed_before_receipt',
  })
  assert.equal(abandoned.state, 'reserved')
  assert.equal(capacity.size('project_1'), 1)
  assert.equal(capacity.reconcile(new Set()), 1)
  assert.equal(capacity.size('project_1'), 0)
}

// The production recovery classifier protects a live prepared window, but
// eventually releases a crashed reservation and seals stale submissions.
{
  const now = new Date('2026-08-25T00:02:00.000Z')
  assert.equal(imagePaidSlotDisposition({
    receipt: {
      status: 'prepared',
      updatedAt: new Date('2026-08-25T00:01:30.000Z'),
    },
    now,
  }), 'active')
  assert.equal(imagePaidSlotDisposition({
    receipt: {
      status: 'prepared',
      updatedAt: new Date('2026-08-25T00:00:00.000Z'),
    },
    now,
  }), 'terminal_or_missing')
  assert.equal(imagePaidSlotDisposition({
    receipt: {
      status: 'submitting',
      submissionStartedAt: new Date('2026-08-24T23:50:00.000Z'),
      updatedAt: new Date('2026-08-24T23:50:00.000Z'),
    },
    now,
  }), 'seal_unknown')
  assert.equal(imagePaidSlotDisposition({
    receipt: {
      status: 'asset_stored',
      updatedAt: now,
    },
    now,
  }), 'terminal_or_missing')
}

console.log('GenerateImage durability verification passed.')
