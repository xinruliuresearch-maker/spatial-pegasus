import type {
  AgentTeamSnapshot,
  TeamAgentRecord,
  TeamAgentStatus,
  TeamEventRecord,
} from './types'
import type { AgentRunStatus } from '../agent-runtime/types'

export interface PublicAgentTeamMember {
  agent_id: string
  alias: string
  role: string
  is_root: boolean
  status: TeamAgentStatus
  last_transition_at: string
}

export interface PublicAgentTeamSnapshot {
  team: {
    team_id: string
    status: 'active' | 'completed'
    created_at: string
    updated_at: string
  }
  agents: PublicAgentTeamMember[]
  counts: {
    total: number
    running: number
    standby: number
    completed: number
    failed: number
  }
  /**
   * Reconnect hint for the public Root transcript. This carries no member
   * content; it closes the snapshot -> EventSource establishment race when a
   * short supervision Run starts (or even finishes) between the two requests.
   */
  latest_root_run: {
    run_id: string
    status: AgentRunStatus
  } | null
  latest_event_seq: number
}

export class InvalidTeamCursorError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidTeamCursorError'
  }
}

export function toPublicTeamSnapshot(
  snapshot: AgentTeamSnapshot,
  options?: {
    latestRootRun?: { run_id: string; status: AgentRunStatus } | null
  },
): PublicAgentTeamSnapshot {
  const agents = [...snapshot.agents]
    .sort((left, right) => Number(right.is_root) - Number(left.is_root) || left.slot - right.slot)
    .map(toPublicAgent)

  return {
    team: {
      team_id: snapshot.team.team_id,
      status: snapshot.team.status,
      created_at: toIsoString(snapshot.team.created_at),
      updated_at: toIsoString(snapshot.team.updated_at),
    },
    agents,
    counts: {
      total: agents.length,
      running: agents.filter(agent => agent.status === 'running').length,
      standby: agents.filter(agent => agent.status === 'idle' || agent.status === 'paused').length,
      completed: agents.filter(agent => agent.status === 'completed').length,
      failed: agents.filter(agent => agent.status === 'failed').length,
    },
    latest_root_run: options?.latestRootRun ?? null,
    latest_event_seq: snapshot.latest_event_seq,
  }
}

export function resolveTeamEventCursor(
  queryValue: string | null,
  lastEventId: string | null,
): number {
  const queryCursor = parseCursor(queryValue, 'after_seq')
  const reconnectCursor = parseCursor(lastEventId, 'Last-Event-ID')
  return Math.max(queryCursor ?? 0, reconnectCursor ?? 0)
}

/**
 * Serialize the intentionally narrow public TeamEvent envelope. `payload`,
 * message bodies and evidence/file references are supervision state and must
 * never be copied into the status-panel stream.
 */
export function serializePublicTeamEvent(event: TeamEventRecord): string {
  return [
    `id: ${event.seq}`,
    'event: team_event',
    `data: ${JSON.stringify({
      seq: event.seq,
      type: event.type,
      actor_agent_id: event.actor_agent_id ?? null,
      subject_agent_id: event.subject_agent_id ?? null,
      task_id: event.task_id ?? null,
      // `supervision_due` is the explicit public Root reconnect signal. Other
      // event Run ids may belong to private member sessions and are not needed
      // by the read-only Team panel.
      run_id: event.type === 'supervision_due' ? event.run_id ?? null : null,
      created_at: toIsoString(event.created_at),
    })}`,
    '',
    '',
  ].join('\n')
}

function toPublicAgent(agent: TeamAgentRecord): PublicAgentTeamMember {
  return {
    agent_id: agent.agent_id,
    alias: agent.display_name.slice(0, 160),
    role: agent.role.slice(0, 240),
    is_root: agent.is_root,
    status: agent.status,
    last_transition_at: toIsoString(agent.last_transition_at),
  }
}

function parseCursor(value: string | null, label: string): number | null {
  if (value === null || value === '') return null
  if (!/^\d+$/.test(value)) throw new InvalidTeamCursorError(`${label} must be a non-negative integer`)
  const cursor = Number(value)
  if (!Number.isSafeInteger(cursor)) throw new InvalidTeamCursorError(`${label} is too large`)
  return cursor
}

function toIsoString(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date(0).toISOString()
}
