import assert from 'node:assert/strict'
import {
  InvalidTeamCursorError,
  resolveTeamEventCursor,
  serializePublicTeamEvent,
  toPublicTeamSnapshot,
} from '../public-contract'
import type {
  AgentTeamSnapshot,
  TeamAgentRecord,
  TeamEventRecord,
} from '../types'

function agent(input: Partial<TeamAgentRecord> & Pick<TeamAgentRecord, 'agent_id' | 'slot' | 'status'>): TeamAgentRecord {
  return {
    agent_id: input.agent_id,
    team_id: 'team_public_contract',
    conversation_id: 'conversation_public_contract',
    user_id: 'user_public_contract',
    slot: input.slot,
    display_name: input.display_name ?? input.agent_id,
    normalized_name: input.normalized_name ?? input.agent_id,
    role: input.role ?? 'Research member',
    instructions: input.instructions ?? 'PRIVATE AGENT INSTRUCTIONS',
    is_root: input.is_root ?? false,
    created_by_agent_id: input.created_by_agent_id ?? 'agent_root',
    status: input.status,
    generation: input.generation ?? 1,
    current_session_id: input.current_session_id ?? `session_${input.agent_id}`,
    active_grant_id: input.active_grant_id ?? `grant_${input.agent_id}`,
    grant_version: input.grant_version ?? 1,
    private_workspace_prefix: input.private_workspace_prefix
      ?? `.sci-pegasus/agents/${input.agent_id}/`,
    last_transition_at: input.last_transition_at ?? new Date('2026-08-08T00:00:00.000Z'),
    progress_snapshot: input.progress_snapshot ?? {
      summary: 'PRIVATE DETAILED PROGRESS',
      updated_at: new Date('2026-08-08T00:00:00.000Z'),
    },
    created_at: input.created_at ?? new Date('2026-08-08T00:00:00.000Z'),
    updated_at: input.updated_at ?? new Date('2026-08-08T00:00:00.000Z'),
  }
}

function snapshot(): AgentTeamSnapshot {
  const longAlias = `Alias-${'a'.repeat(200)}`
  const longRole = `Role-${'r'.repeat(300)}`
  return {
    team: {
      team_id: 'team_public_contract',
      conversation_id: 'conversation_public_contract',
      user_id: 'user_public_contract',
      root_agent_id: 'agent_root',
      workspace_id: 'workspace_public_contract',
      status: 'active',
      policy: {
        version: 1,
        strategy_version: 1,
        max_active_agents: 8,
        max_total_agents: 32,
        supervision_interval_ms: 120_000,
        global_budget: { max_cost_usd: 999 },
      },
      next_event_seq: 44,
      supervision_cursor: 40,
      created_at: new Date('2026-08-08T00:00:00.000Z'),
      updated_at: new Date('2026-08-08T00:01:00.000Z'),
    },
    agents: [
      agent({ agent_id: 'agent_failed', slot: 4, status: 'failed' }),
      agent({ agent_id: 'agent_idle', slot: 2, status: 'idle' }),
      agent({ agent_id: 'agent_paused', slot: 3, status: 'paused' }),
      agent({ agent_id: 'agent_done', slot: 5, status: 'completed' }),
      agent({
        agent_id: 'agent_root',
        slot: 0,
        status: 'running',
        is_root: true,
        display_name: longAlias,
        role: longRole,
      }),
    ],
    tasks: [{ objective: 'PRIVATE TASK OBJECTIVE' }] as AgentTeamSnapshot['tasks'],
    results: [{ final_response: 'PRIVATE RESULT BODY' }] as AgentTeamSnapshot['results'],
    proposals: [{ source_path: 'PRIVATE PROPOSAL PATH' }] as AgentTeamSnapshot['proposals'],
    messages: [{ content: 'PRIVATE MAILBOX MESSAGE' }] as AgentTeamSnapshot['messages'],
    counts: {
      total_agents: 5,
      running_agents: 1,
      idle_agents: 1,
      completed_agents: 1,
      failed_agents: 1,
      active_tasks: 1,
      pending_results: 1,
    },
    latest_event_seq: 43,
  }
}

function testSnapshotIsNarrowAndStable(): void {
  const value = toPublicTeamSnapshot(snapshot(), {
    latestRootRun: {
      run_id: 'run_root_reconnect',
      status: 'completed',
    },
  })
  assert.deepEqual(Object.keys(value).sort(), [
    'agents',
    'counts',
    'latest_event_seq',
    'latest_root_run',
    'team',
  ])
  assert.deepEqual(Object.keys(value.team).sort(), ['created_at', 'status', 'team_id', 'updated_at'])
  assert.equal(value.agents[0].agent_id, 'agent_root', 'Root must remain first in the status panel')
  assert.equal(value.agents[0].alias.length, 160)
  assert.equal(value.agents[0].role.length, 240)
  assert.deepEqual(value.counts, {
    total: 5,
    running: 1,
    standby: 2,
    completed: 1,
    failed: 1,
  })
  assert.deepEqual(value.latest_root_run, {
    run_id: 'run_root_reconnect',
    status: 'completed',
  })
  assert.equal(value.latest_event_seq, 43)

  const serialized = JSON.stringify(value)
  for (const secret of [
    'PRIVATE AGENT INSTRUCTIONS',
    'PRIVATE DETAILED PROGRESS',
    'PRIVATE TASK OBJECTIVE',
    'PRIVATE RESULT BODY',
    'PRIVATE PROPOSAL PATH',
    'PRIVATE MAILBOX MESSAGE',
    'workspace_public_contract',
    'max_cost_usd',
  ]) {
    assert.ok(!serialized.includes(secret), `public snapshot leaked: ${secret}`)
  }
}

function testReconnectCursorIsMonotonic(): void {
  assert.equal(resolveTeamEventCursor(null, null), 0)
  assert.equal(resolveTeamEventCursor('17', null), 17)
  assert.equal(resolveTeamEventCursor('17', '23'), 23)
  assert.equal(resolveTeamEventCursor('29', '23'), 29)
  assert.equal(resolveTeamEventCursor('', '0007'), 7)
  for (const invalid of ['-1', '1.5', ' 2', '2e3', '9007199254740992']) {
    assert.throws(
      () => resolveTeamEventCursor(invalid, null),
      InvalidTeamCursorError,
    )
    assert.throws(
      () => resolveTeamEventCursor(null, invalid),
      InvalidTeamCursorError,
    )
  }
}

function testTeamEventEnvelopeSupportsRootRunReconnectWithoutLeakingPayload(): void {
  const event: TeamEventRecord = {
    event_id: 'event_43',
    team_id: 'team_public_contract',
    conversation_id: 'conversation_public_contract',
    user_id: 'user_public_contract',
    seq: 43,
    type: 'supervision_due',
    actor_agent_id: null,
    subject_agent_id: 'agent_root',
    task_id: null,
    run_id: 'run_root_supervision_43',
    payload: {
      message: 'PRIVATE ROOT SUPERVISION BODY',
      references: ['.sci-pegasus/agents/agent_member/private.md'],
      source_count: 3,
    },
    dedupe_key: 'PRIVATE DEDUPE KEY',
    created_at: new Date('2026-08-08T00:02:00.000Z'),
  }
  const serialized = serializePublicTeamEvent(event)
  assert.ok(serialized.endsWith('\n\n'))
  const lines = serialized.trimEnd().split('\n')
  assert.equal(lines[0], 'id: 43')
  assert.equal(lines[1], 'event: team_event')
  const data = JSON.parse(lines[2].slice('data: '.length)) as Record<string, unknown>
  assert.deepEqual(data, {
    seq: 43,
    type: 'supervision_due',
    actor_agent_id: null,
    subject_agent_id: 'agent_root',
    task_id: null,
    run_id: 'run_root_supervision_43',
    created_at: '2026-08-08T00:02:00.000Z',
  })
  assert.equal(data.seq, Number(lines[0].slice('id: '.length)))
  assert.ok(!serialized.includes('PRIVATE ROOT SUPERVISION BODY'))
  assert.ok(!serialized.includes('private.md'))
  assert.ok(!serialized.includes('PRIVATE DEDUPE KEY'))
  assert.ok(!Object.hasOwn(data, 'payload'))

  const privateMemberEvent: TeamEventRecord = {
    ...event,
    event_id: 'event_44',
    seq: 44,
    type: 'execution_slot_claimed',
    subject_agent_id: 'agent_member',
    run_id: 'PRIVATE_MEMBER_RUN_ID',
  }
  const memberSerialized = serializePublicTeamEvent(privateMemberEvent)
  const memberData = JSON.parse(
    memberSerialized.trimEnd().split('\n')[2].slice('data: '.length),
  ) as Record<string, unknown>
  assert.equal(memberData.run_id, null)
  assert.ok(!memberSerialized.includes('PRIVATE_MEMBER_RUN_ID'))
}

function main(): void {
  testSnapshotIsNarrowAndStable()
  testReconnectCursorIsMonotonic()
  testTeamEventEnvelopeSupportsRootRunReconnectWithoutLeakingPayload()
  console.log('Agent Team public contract verification passed.')
}

main()
