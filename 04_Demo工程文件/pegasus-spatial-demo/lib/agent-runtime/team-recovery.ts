import { wakeAgentRunner } from './runner'
import { AgentRun } from './models'
import {
  getActiveAgentRunForSession,
  queueRecoverableAgentRun,
} from './repository'
import {
  AgentMailboxMessageModel,
  AgentSessionRuntimeModel,
  AgentTaskModel,
  AgentTeamModel,
  TeamAgentModel,
} from '../agent-team/models'
import {
  scheduleReadyAgents,
  wakeMemberForMailbox,
} from '../agent-team/orchestrator'
import { agentTeamRepository } from '../agent-team/repository'
import type { AgentRunDocument } from './models'
import type { AgentMessageKind } from '../agent-team/types'
import { MAX_DISPATCH_ATTEMPTS } from './dispatch-policy'

const RETRYABLE_DISPATCH_FILTER = {
  $or: [
    { dispatch_attempts: { $lt: MAX_DISPATCH_ATTEMPTS } },
    { dispatch_attempts: { $exists: false } },
  ],
}

/**
 * Repair member work after a process/lease crash.
 *
 * AgentRun recovery and Team session recovery are deliberately separate lease
 * fences. Once both sweeps have run, this bridge makes their converged durable
 * state executable again. It also closes the crash window after a completed
 * member Run releases its session but before it schedules the next queued
 * task. Every mutation below is guarded by the existing active-key/status CAS.
 */
export async function repairRunnableMemberWork(): Promise<{
  root_runs_queued: number
  recoverable_runs_queued: number
  teams_rescheduled: number
  mailbox_agents_woken: number
}> {
  // Root and members intentionally share crash recovery semantics. Root Runs
  // use the Conversation active key while members use an Agent session key,
  // but both are safe to replay from the last durable action checkpoint once
  // their Team session lease has been released.
  const rootCandidates = process.env.AGENT_RUNTIME_BACKGROUND_RUNNER === '1'
    ? await AgentRun.find({
        status: 'recoverable',
        execution_mode: { $ne: 'agent_session' },
        cancellation_requested: { $ne: true },
        ...RETRYABLE_DISPATCH_FILTER,
        team_id: { $type: 'string' },
        agent_id: { $type: 'string' },
        agent_session_id: { $type: 'string' },
        active_key: { $type: 'string' },
      }).sort({ updated_at: 1 }).limit(500).lean<AgentRunDocument[]>()
    : []
  let rootRunsQueued = 0
  for (const run of rootCandidates) {
    if (!run.team_id || !run.agent_id || !run.agent_session_id) continue
    const [team, rootIdle, sessionReleased] = await Promise.all([
      AgentTeamModel.findOne({
        team_id: run.team_id,
        user_id: run.user_id,
        root_agent_id: run.agent_id,
        status: 'active',
      }).select('root_agent_id').lean<{ root_agent_id: string }>(),
      TeamAgentModel.exists({
        team_id: run.team_id,
        user_id: run.user_id,
        agent_id: run.agent_id,
        is_root: true,
        current_session_id: run.agent_session_id,
        status: 'idle',
      }),
      AgentSessionRuntimeModel.exists({
        team_id: run.team_id,
        user_id: run.user_id,
        agent_id: run.agent_id,
        session_id: run.agent_session_id,
        $or: [
          { active_run_id: null },
          { active_run_id: { $exists: false } },
        ],
      }),
    ])
    if (!team || !rootIdle || !sessionReleased) continue
    if (!await queueRecoverableAgentRun(run.run_id, run.user_id)) continue
    rootRunsQueued += 1
    await agentTeamRepository.appendEvent({
      teamId: run.team_id,
      userId: run.user_id,
      type: 'supervision_due',
      subjectAgentId: run.agent_id,
      runId: run.run_id,
      payload: { reason: 'root_run_recovered' },
      dedupeKey: `root_run_recovered:${run.run_id}:${run.recovery_count}`,
    })
  }

  const candidates = await AgentRun.find({
    status: 'recoverable',
    execution_mode: 'agent_session',
    cancellation_requested: { $ne: true },
    ...RETRYABLE_DISPATCH_FILTER,
    team_id: { $type: 'string' },
    agent_id: { $type: 'string' },
    agent_session_id: { $type: 'string' },
    active_key: { $type: 'string' },
  }).sort({ updated_at: 1 }).limit(500).lean<AgentRunDocument[]>()

  let recoverableRunsQueued = 0
  for (const run of candidates) {
    if (!run.team_id || !run.agent_id || !run.agent_session_id) continue
    const [teamActive, agentIdle, sessionReleased, taskRunnable] = await Promise.all([
      AgentTeamModel.exists({
        team_id: run.team_id,
        user_id: run.user_id,
        status: 'active',
      }),
      TeamAgentModel.exists({
        team_id: run.team_id,
        user_id: run.user_id,
        agent_id: run.agent_id,
        current_session_id: run.agent_session_id,
        status: 'idle',
      }),
      AgentSessionRuntimeModel.exists({
        team_id: run.team_id,
        user_id: run.user_id,
        agent_id: run.agent_id,
        session_id: run.agent_session_id,
        $or: [
          { active_run_id: null },
          { active_run_id: { $exists: false } },
        ],
      }),
      run.task_id
        ? AgentTaskModel.exists({
            team_id: run.team_id,
            user_id: run.user_id,
            task_id: run.task_id,
            assigned_agent_id: run.agent_id,
            status: { $in: ['queued', 'running', 'waiting', 'rework'] },
          })
        : Promise.resolve(true),
    ])
    if (!teamActive || !agentIdle || !sessionReleased || !taskRunnable) continue
    if (await queueRecoverableAgentRun(run.run_id, run.user_id)) {
      recoverableRunsQueued += 1
    }
  }

  const activeTeams = await AgentTeamModel.find({ status: 'active' })
    .select('team_id user_id')
    .lean<Array<{ team_id: string; user_id: string }>>()
  let teamsRescheduled = 0
  for (const team of activeTeams) {
    await scheduleReadyAgents(team.team_id, team.user_id)
    teamsRescheduled += 1
  }

  // If a process died after claiming or targeting a direct message at a Run
  // that then became terminal, the mailbox record remains the durable source
  // of truth. Wake only idle members with no active Run; this avoids periodic
  // duplicate reminders while a queued/running executor is already handling
  // the delivery. Stale claimed records are included so the new executor can
  // reap and reclaim them in claimMailboxMessages().
  const staleClaimBoundary = new Date(Date.now() - 5 * 60_000)
  const attentionMessages = await AgentMailboxMessageModel.find({
    deliveries: {
      $elemMatch: {
        kind: 'primary',
        $or: [
          { status: 'pending' },
          { status: 'claimed', claimed_at: { $lte: staleClaimBoundary } },
        ],
      },
    },
  }).sort({ created_at: 1 }).limit(500).lean<Array<{
    team_id: string
    user_id: string
    recipient_agent_id: string
    message_id: string
    kind: AgentMessageKind
  }>>()
  let mailboxAgentsWoken = 0
  const examinedAgents = new Set<string>()
  for (const message of attentionMessages) {
    const key = `${message.team_id}:${message.recipient_agent_id}`
    if (examinedAgents.has(key)) continue
    examinedAgents.add(key)
    const agent = await TeamAgentModel.findOne({
      team_id: message.team_id,
      user_id: message.user_id,
      agent_id: message.recipient_agent_id,
      is_root: false,
      status: 'idle',
    }).select('current_session_id').lean<{ current_session_id: string }>()
    if (!agent) continue
    if (await getActiveAgentRunForSession(agent.current_session_id, message.user_id)) continue
    const runId = await wakeMemberForMailbox({
      teamId: message.team_id,
      userId: message.user_id,
      agentId: message.recipient_agent_id,
      messageId: message.message_id,
      kind: message.kind,
    })
    if (runId) mailboxAgentsWoken += 1
  }

  if (rootRunsQueued > 0 || recoverableRunsQueued > 0 || mailboxAgentsWoken > 0) {
    wakeAgentRunner()
  }
  return {
    root_runs_queued: rootRunsQueued,
    recoverable_runs_queued: recoverableRunsQueued,
    teams_rescheduled: teamsRescheduled,
    mailbox_agents_woken: mailboxAgentsWoken,
  }
}
