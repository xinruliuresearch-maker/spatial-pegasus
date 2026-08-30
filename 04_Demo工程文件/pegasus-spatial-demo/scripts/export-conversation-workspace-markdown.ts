import mongoose from 'mongoose'
import { AgentTeamModel } from '../lib/agent-team/models'
import { connectDB } from '../lib/db/mongodb'
import { readFileFromGridFSAsBuffer } from '../lib/db/gridfs'
import { Conversation } from '../lib/db/models'
import type { FileEntry } from '../lib/workspace/types'
import {
  buildConversationWorkspaceMarkdownExport,
  writeConversationWorkspaceMarkdownExport,
} from '../lib/workspace/export-markdown'
import {
  WorkspaceFile,
  WorkspaceFileRevision,
} from '../lib/workspace/multi-agent/models'
import type {
  WorkspaceFileSnapshot,
  WorkspaceFileVisibility,
  WorkspaceStorageRef,
  WorkspaceFileMetadata,
  WorkspaceWriterProvenance,
} from '../lib/workspace/multi-agent/types'
import { requireMongoUri } from './runtime-env'

interface CliOptions {
  conversationId: string
  outputDirectory: string
  userId?: string
}

interface ConversationExportDocument {
  conversation_id: string
  user_id: string
  title: string
  output?: { files?: Record<string, FileEntry> }
}

interface WorkspaceHead {
  workspace_id: string
  path: string
  revision: number
  current_version_id: string
  created_at: Date
  updated_at: Date
}

interface WorkspaceRevision {
  version_id: string
  workspace_id: string
  path: string
  revision: number
  visibility: WorkspaceFileVisibility
  owner_agent_id?: string
  storage_ref: WorkspaceStorageRef
  metadata: WorkspaceFileMetadata
  writer: WorkspaceWriterProvenance
  canonical_artifact_key?: string
  publication_key?: string
  publication_source?: WorkspaceFileSnapshot['publication_source']
  capacity_reservation_id?: string
}

function usage(): string {
  return [
    'Export the current Conversation Workspace to a new local Markdown directory.',
    '',
    'Usage:',
    '  npm run workspace:export-markdown -- \\',
    '    --conversation <conversation-id> \\',
    '    --output <new-directory> [--user <user-id>]',
    '',
    'Safety:',
    '  - MongoDB and GridFS access is strictly read-only.',
    '  - The output directory must not already exist.',
    '  - Public and Agent-private UTF-8 text is exported as .md.',
    '  - Managed references and binary objects appear only in MANIFEST.md.',
  ].join('\n')
}

function requiredValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1]?.trim()
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
  return value
}

function parseOptions(args: readonly string[]): CliOptions | null {
  if (args.includes('--help') || args.includes('-h')) return null
  let conversationId = ''
  let outputDirectory = ''
  let userId: string | undefined
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--conversation') conversationId = requiredValue(args, index++, argument)
    else if (argument === '--output') outputDirectory = requiredValue(args, index++, argument)
    else if (argument === '--user') userId = requiredValue(args, index++, argument)
    else throw new Error(`Unknown argument: ${argument}`)
  }
  if (!conversationId) throw new Error('--conversation is required')
  if (!outputDirectory) throw new Error('--output is required')
  return { conversationId, outputDirectory, userId }
}

function headFingerprint(heads: readonly WorkspaceHead[]): string {
  return heads
    .map(head => `${head.path}\u0000${head.revision}\u0000${head.current_version_id}`)
    .sort()
    .join('\u0001')
}

/**
 * Read one stable set of head pointers, then resolve only those immutable
 * revisions. A concurrent head advance retries instead of mixing generations.
 */
async function loadAuthoritativeHeads(workspaceId: string): Promise<WorkspaceFileSnapshot[]> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const heads = await WorkspaceFile.find({ workspace_id: workspaceId })
      .sort({ path: 1 })
      .lean() as unknown as WorkspaceHead[]
    if (heads.length === 0) return []
    const revisions = await WorkspaceFileRevision.find({
      version_id: { $in: heads.map(head => head.current_version_id) },
    }).lean() as unknown as WorkspaceRevision[]
    const confirmingHeads = await WorkspaceFile.find({ workspace_id: workspaceId })
      .sort({ path: 1 })
      .lean() as unknown as WorkspaceHead[]
    if (headFingerprint(heads) !== headFingerprint(confirmingHeads)) continue

    const revisionsById = new Map(revisions.map(revision => [revision.version_id, revision]))
    return heads.map(head => {
      const revision = revisionsById.get(head.current_version_id)
      if (!revision) {
        throw new Error(`Workspace head points to a missing revision: ${head.path}`)
      }
      if (
        revision.workspace_id !== workspaceId
        || revision.path !== head.path
        || revision.revision !== head.revision
      ) {
        throw new Error(`Workspace head/revision identity mismatch: ${head.path}`)
      }
      return {
        workspace_id: workspaceId,
        path: revision.path,
        revision: revision.revision,
        version_id: revision.version_id,
        visibility: revision.visibility,
        owner_agent_id: revision.owner_agent_id,
        storage_ref: structuredClone(revision.storage_ref),
        metadata: structuredClone(revision.metadata),
        writer: structuredClone(revision.writer),
        canonical_artifact_key: revision.canonical_artifact_key,
        publication_key: revision.publication_key,
        publication_source: revision.publication_source
          ? structuredClone(revision.publication_source)
          : undefined,
        capacity_reservation_id: revision.capacity_reservation_id,
        created_at: new Date(head.created_at),
        updated_at: new Date(head.updated_at),
      }
    })
  }
  throw new Error('Workspace heads changed during every read attempt; retry the export')
}

async function run(options: CliOptions): Promise<number> {
  requireMongoUri()
  await connectDB()
  const conversation = await Conversation.findOne({
    conversation_id: options.conversationId,
    ...(options.userId ? { user_id: options.userId } : {}),
  }).select({
    conversation_id: 1,
    user_id: 1,
    title: 1,
    'output.files': 1,
  }).lean() as unknown as ConversationExportDocument | null
  if (!conversation) throw new Error(`Conversation not found: ${options.conversationId}`)

  const team = await AgentTeamModel.findOne({
    conversation_id: conversation.conversation_id,
    user_id: conversation.user_id,
  }).select({ team_id: 1, workspace_id: 1 }).lean<{
    team_id: string
    workspace_id: string
  }>()
  const workspaceId = team?.workspace_id || conversation.conversation_id
  const authoritativeFiles = await loadAuthoritativeHeads(workspaceId)
  const plan = await buildConversationWorkspaceMarkdownExport({
    conversationId: conversation.conversation_id,
    userId: conversation.user_id,
    title: conversation.title,
    workspaceId,
    teamId: team?.team_id,
    authoritativeFiles,
    legacyFiles: conversation.output?.files ?? {},
  }, async request => readFileFromGridFSAsBuffer(request.objectId))

  const destination = await writeConversationWorkspaceMarkdownExport(
    plan,
    options.outputDirectory,
  )
  console.log(`Exported ${plan.files.length} Markdown file(s) to ${destination}`)
  console.log(`Inventory contains ${plan.records.length} source record(s); see MANIFEST.md`)
  if (plan.issue_count > 0) {
    console.error(`Export completed with ${plan.issue_count} read/integrity issue(s) recorded in MANIFEST.md`)
    return 2
  }
  return 0
}

async function main(): Promise<number> {
  const options = parseOptions(process.argv.slice(2))
  if (!options) {
    console.log(usage())
    return 0
  }
  return run(options)
}

main()
  .then(code => { process.exitCode = code })
  .catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
  .finally(async () => {
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect()
  })
