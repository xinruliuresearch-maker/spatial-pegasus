import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { getConversation, deleteConversation, updateConversationFields } from '@/lib/db/repository'
import { resolveLocalOwner } from '@/lib/local-owner'
import {
  deleteConversationRuntimeState,
  getActiveAgentRun,
  getLatestAgentRun,
} from '@/lib/agent-runtime/repository'
import { createWorkspaceInstance } from '@/lib/workspace/instance'
import type { FileEntry } from '@/lib/workspace/types'
import { spatialCreationWorkspace } from '@/lib/workspace/definitions/spatial-creation'
import {
  isInternalWorkspacePath,
  isManagedLiteratureArtifactPath,
} from '@/lib/workspace/path-policy'
import { hideInternalWorkspaceState } from '@/lib/workspace/public-view'
import { agentTeamService, deleteAgentTeamState } from '@/lib/agent-team'
import {
  createMultiAgentWorkspaceBridge,
  MultiAgentWorkspaceRepository,
  workspaceFileSnapshotToFileEntry,
} from '@/lib/workspace/multi-agent'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await resolveLocalOwner()
  if (userId instanceof Response) return userId

  try {
    const { id } = await params
    const conversation = await getConversation(id, userId)
    if (!conversation) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }
    const obj = conversation.toObject() as Record<string, unknown>
    const team = await agentTeamService.ensureTeam({
      conversationId: id,
      userId,
      workspaceId: id,
    })
    const output = (obj.output ??= {}) as Record<string, unknown>
    const projectedFiles = {
      ...((output.files as Record<string, FileEntry> | undefined) ?? {}),
    }
    const projectedManifest = {
      ...((output.manifest as Record<string, { current_version: number; versions: never[] }> | undefined) ?? {}),
    }
    const authoritativeFiles = await new MultiAgentWorkspaceRepository().listFiles(
      team.workspace_id,
      {
        teamId: team.team_id,
        agentId: team.root_agent_id,
        rootAgentId: team.root_agent_id,
        role: 'root',
      },
    )
    for (const file of authoritativeFiles) {
      if (file.visibility === 'agent_private') continue
      projectedFiles[file.path] = workspaceFileSnapshotToFileEntry(
        file,
        projectedFiles[file.path],
      )
      projectedManifest[file.path] ??= { current_version: file.revision, versions: [] }
    }
    output.files = projectedFiles
    output.manifest = projectedManifest
    hideInternalWorkspaceState(obj)
    for (const key of ['messages', 'compacted_messages'] as const) {
      if (Array.isArray(obj[key])) {
        obj[key] = (obj[key] as Array<{ visibility?: string }>).filter(
          message => message.visibility !== 'internal',
        )
      }
    }
    const [activeRun, latestRun] = await Promise.all([
      getActiveAgentRun(id, userId),
      getLatestAgentRun(id, userId),
    ])
    obj.is_running = Boolean(activeRun && ['queued', 'running'].includes(activeRun.status))
    if (latestRun) {
      obj._waiting_for_user = activeRun?.status === 'waiting_user'
      obj._last_interrupted = latestRun.status === 'cancelled'
        || latestRun.status === 'recoverable'
    }
    obj.active_run = activeRun
      ? {
          run_id: activeRun.run_id,
          status: activeRun.status,
          pending_interaction: activeRun.pending_interaction ?? null,
        }
      : null
    return NextResponse.json(obj)
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    )
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await resolveLocalOwner()
  if (userId instanceof Response) return userId

  try {
    const { id } = await params
    const body = await req.json()

    // Title-only rename path. Distinct from the file-edit path so renaming
    // doesn't have to spin up a workspace instance or bump user-edit counters.
    if (typeof body.title === 'string') {
      const title = body.title.trim()
      if (!title) {
        return NextResponse.json({ error: 'Title cannot be empty' }, { status: 400 })
      }
      if (title.length > 200) {
        return NextResponse.json({ error: 'Title too long' }, { status: 400 })
      }
      const conv = await getConversation(id, userId)
      if (!conv) {
        return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
      }
      await updateConversationFields(id, userId, { title })
      return NextResponse.json({ success: true })
    }

    // Pin/unpin path — just flips a boolean, no workspace needed.
    if (typeof body.pinned === 'boolean') {
      const conv = await getConversation(id, userId)
      if (!conv) {
        return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
      }
      await updateConversationFields(id, userId, { pinned: body.pinned })
      return NextResponse.json({ success: true })
    }

    // Memory toggle path — persists immediately so refresh + switch-and-back
    // preserve the choice even if the user toggles without sending a message.
    if (typeof body.memory_enabled === 'boolean') {
      const conv = await getConversation(id, userId)
      if (!conv) {
        return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
      }
      await updateConversationFields(id, userId, { 'settings.memory_enabled': body.memory_enabled })
      return NextResponse.json({ success: true })
    }

    const { path, content } = body

    if (!path || typeof content !== 'string') {
      return NextResponse.json({ error: 'Missing path or content' }, { status: 400 })
    }
    if (isInternalWorkspacePath(path)) {
      return NextResponse.json({ error: 'Internal workspace files are managed by the Agent' }, { status: 403 })
    }
    if (isManagedLiteratureArtifactPath(path)) {
      return NextResponse.json({ error: 'Literature source and parser artifacts are read-only' }, { status: 403 })
    }

    const conv = await getConversation(id, userId)
    if (!conv) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }

    const convObj = conv.toObject() as Record<string, unknown>
    const output = (convObj.output || {}) as Record<string, unknown>
    const outputFiles = output.files as Record<string, FileEntry> | undefined
    const outputManifest = output.manifest as Record<string, { current_version: number; versions: { v: number; path: string; note: string; created_at: string }[] }> | undefined
    const team = await agentTeamService.ensureTeam({
      conversationId: id,
      userId,
      workspaceId: id,
    })
    const rootAgent = await agentTeamService.getAgent({
      teamId: team.team_id,
      userId,
      agentId: team.root_agent_id,
    })
    const userEditFence = `user_edit_fence_${randomUUID()}`
    const userEditRunId = `user_edit_${randomUUID()}`
    const workspaceRepository = new MultiAgentWorkspaceRepository({
      // This route has already authenticated ownership and rejects internal or
      // managed-reference paths. The opaque token scopes this one request.
      fenceValidator: ({ writer }) => (
        writer.run_id === userEditRunId
        && writer.execution_fence_token === userEditFence
      ),
    })
    const workspaceBridge = await createMultiAgentWorkspaceBridge({
      repository: workspaceRepository,
      workspaceId: team.workspace_id,
      actor: {
        teamId: team.team_id,
        agentId: rootAgent.agent_id,
        rootAgentId: team.root_agent_id,
        role: 'root',
      },
      writer: {
        team_id: team.team_id,
        agent_id: rootAgent.agent_id,
        run_id: userEditRunId,
        execution_fence_token: userEditFence,
      },
      legacyFiles: outputFiles,
    })

    // Same write path as AI tools — persist to GridFS. `archive: false` overwrites the
    // current gridfs_id in place instead of archiving to _vN, so user micro-edits don't
    // bloat GridFS (versioning is reserved for AI's intentional revisions).
    const workspace = createWorkspaceInstance(spatialCreationWorkspace, workspaceBridge.projectedFiles, outputManifest, {
      conversationId: id,
      ownerUserId: userId,
      onFileMutations: workspaceBridge.onFileMutations,
      onFileSetBegin: workspaceBridge.onFileSetBegin,
      onFileSetFinalize: workspaceBridge.onFileSetFinalize,
      onFileSetAbort: workspaceBridge.onFileSetAbort,
    })
    await workspace.write(path, content, 'user edit', { archive: false })

    return NextResponse.json({ success: true })
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    )
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await resolveLocalOwner()
  if (userId instanceof Response) return userId

  try {
    const { id } = await params
    const activeRun = await getActiveAgentRun(id, userId)
    if (activeRun) {
      return NextResponse.json(
        {
          error: 'Conversation has an active agent run. Stop it before deleting the conversation.',
          run_id: activeRun.run_id,
          status: activeRun.status,
        },
        { status: 409 },
      )
    }
    const deleted = await deleteConversation(id, userId)
    if (!deleted) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }
    await deleteConversationRuntimeState(id, userId)
    await deleteAgentTeamState(id, userId)
    return NextResponse.json({ success: true })
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    )
  }
}
