import assert from 'node:assert/strict'
import {
  buildCommandKey,
  defaultTeamPolicy,
  isAgentPrivatePath,
  isBudgetWithin,
  isToolAllowlistSubset,
  memberDelegationGrant,
  normalizeAgentTeamToolNameForExecution,
  normalizeAgentName,
  privateWorkspacePrefix,
  rootDelegationGrant,
  shouldWakeForMessage,
  taskWaitSatisfied,
  toolAllowlistNeedsReferencePublishing,
  visibleAgentTeamTools,
} from '../policy'
import {
  assertCanDelegatePrivatePaths,
  normalizeWorkspaceReferences,
  privatePathsFromReferences,
} from '../path-grants'
import { AgentPermissionError, InvalidAgentTeamOperationError } from '../errors'
import {
  compactPendingWorkspaceChanges,
  compactRecentTurnResults,
  isAgentTeamTool,
} from '../tool-adapter'
import {
  rootCanAcceptTeamUpdate,
  rootMailboxModelBody,
  routineSupervisionEvents,
} from '../orchestrator'
import type {
  AgentResultRecord,
  TeamAgentRecord,
  TeamEventRecord,
  WorkspaceProposalRecord,
} from '../types'

function testDefaults(): void {
  const policy = defaultTeamPolicy()
  assert.equal(policy.max_active_agents, 8)
  assert.equal(policy.max_total_agents, 32)
  assert.equal(policy.supervision_interval_ms, 120_000)

  const root = rootDelegationGrant()
  assert.deepEqual(visibleAgentTeamTools(root), [
    'Agent',
    'SendMessage',
    'TaskCreate',
    'TaskUpdate',
    'TaskList',
    'TaskGet',
    'ReviewWorkspaceChanges',
    'ManageAgent',
  ])

  const member = memberDelegationGrant()
  assert.deepEqual(visibleAgentTeamTools(member), [
    'SendMessage',
    'TaskUpdate',
    'TaskList',
    'TaskGet',
  ])
}

function testRootOnlyCapabilitiesCannotLeak(): void {
  const grant = memberDelegationGrant({
    capabilities: {
      is_coordinator: true,
      can_create_agents: true,
      can_review_results: true,
      can_manage_agents: true,
      can_ask_user: true,
      can_delegate_tasks: true,
    },
  })
  assert.equal(grant.capabilities.is_coordinator, false)
  assert.equal(grant.capabilities.can_create_agents, false)
  assert.equal(grant.capabilities.can_review_results, false)
  assert.equal(grant.capabilities.can_manage_agents, false)
  assert.equal(grant.capabilities.can_ask_user, false)
  assert.equal(grant.capabilities.can_delegate_tasks, true)
}

function testGrantSubset(): void {
  assert.equal(isToolAllowlistSubset(['SearchDocument'], ['*']), true)
  assert.equal(isToolAllowlistSubset(['SearchDocument'], ['SearchDocument', 'Read']), true)
  assert.equal(isToolAllowlistSubset(['Write'], ['SearchDocument', 'Read']), false)
  assert.equal(isToolAllowlistSubset(['*'], ['SearchDocument', 'Read']), false)
  assert.equal(isBudgetWithin({ max_tokens: 50 }, { max_tokens: 100 }), true)
  assert.equal(isBudgetWithin({ max_tokens: 101 }, { max_tokens: 100 }), false)
  assert.equal(isBudgetWithin({ max_tokens: 101 }, undefined), true)
  assert.equal(toolAllowlistNeedsReferencePublishing(['Read', 'SearchDocument']), false)
  assert.equal(toolAllowlistNeedsReferencePublishing(['ArxivFetchPaper']), true)
  assert.equal(toolAllowlistNeedsReferencePublishing(['SciverseSearchEvidence']), true)
  assert.equal(toolAllowlistNeedsReferencePublishing(['*']), true)
}

function testWakeSemantics(): void {
  assert.equal(shouldWakeForMessage('info', false), true)
  assert.equal(shouldWakeForMessage('progress', false), true)
  assert.equal(shouldWakeForMessage('request', false), true)
  assert.equal(shouldWakeForMessage('review', false), true)
  assert.equal(shouldWakeForMessage('blocker', false), true)
  assert.equal(shouldWakeForMessage('blocker', true), true)
  assert.equal(shouldWakeForMessage('error', true), true)
  assert.equal(shouldWakeForMessage('request', true), false)
}

function testLegacyExecutionAliases(): void {
  assert.equal(normalizeAgentTeamToolNameForExecution('CreateAgent'), 'Agent')
  assert.equal(normalizeAgentTeamToolNameForExecution('SendAgentMessage'), 'SendMessage')
  assert.equal(normalizeAgentTeamToolNameForExecution('WaitForAgents'), 'TaskList')
  assert.equal(normalizeAgentTeamToolNameForExecution('SubmitAgentResult'), 'TaskUpdate')
  assert.equal(normalizeAgentTeamToolNameForExecution('Read'), 'Read')
  assert.equal(isAgentTeamTool('Agent'), true)
  assert.equal(isAgentTeamTool('SendMessage'), true)
  assert.equal(isAgentTeamTool('WaitForAgents'), true)
  assert.equal(isAgentTeamTool('SubmitAgentResult'), true)
  assert.equal(isAgentTeamTool('UnknownTeamTool'), false)
}

function testTaskWaitSemantics(): void {
  assert.equal(taskWaitSatisfied(['submitted', 'accepted'], 'all'), true)
  assert.equal(taskWaitSatisfied(['submitted', 'running'], 'all'), false)
  assert.equal(taskWaitSatisfied(['running', 'failed'], 'any'), true)
  assert.equal(taskWaitSatisfied(['queued', 'running'], 'any'), false)
  assert.equal(taskWaitSatisfied([], 'all'), true)
}

function testNamesAndPrivatePaths(): void {
  assert.equal(normalizeAgentName('  Evidence   Scout '), 'evidence scout')
  assert.equal(privateWorkspacePrefix('agent_1'), '.sci-pegasus/agents/agent_1/')
  assert.equal(isAgentPrivatePath('agent_1', '.sci-pegasus/agents/agent_1/note.md'), true)
  assert.equal(isAgentPrivatePath('agent_1', '/.sci-pegasus/agents/agent_1/note.md'), true)
  assert.equal(isAgentPrivatePath('agent_1', '.sci-pegasus/agents/agent_2/note.md'), false)
  assert.equal(isAgentPrivatePath('agent_1', '.sci-pegasus/agents/agent_1/../agent_2/note.md'), false)
  assert.equal(buildCommandKey('run_1', 'tool_1', 'CreateAgent'), 'run_1:tool_1:CreateAgent')
}

function testReferenceDerivedPrivateGrants(): void {
  const refs = normalizeWorkspaceReferences([
    { kind: 'workspace_path' as const, value: '.sci-pegasus/agents/agent_1/evidence.md' },
    { kind: 'url' as const, value: 'https://example.test/paper' },
  ])
  const paths = privatePathsFromReferences(refs)
  assert.deepEqual(paths, ['.sci-pegasus/agents/agent_1/evidence.md'])
  assert.doesNotThrow(() => assertCanDelegatePrivatePaths({
    actorAgentId: 'agent_1',
    actorIsRoot: false,
    actorAllowedReadPaths: [],
    paths,
  }))
  assert.doesNotThrow(() => assertCanDelegatePrivatePaths({
    actorAgentId: 'agent_2',
    actorIsRoot: false,
    actorAllowedReadPaths: paths,
    paths,
  }))
  assert.throws(() => assertCanDelegatePrivatePaths({
    actorAgentId: 'agent_2',
    actorIsRoot: false,
    actorAllowedReadPaths: [],
    paths,
  }), AgentPermissionError)
  assert.throws(() => privatePathsFromReferences([
    { kind: 'workspace_path', value: '.sci-pegasus/versions/private/v1.md' },
  ]), InvalidAgentTeamOperationError)
}

function testTasklessWorkspaceChangesRemainReachable(): void {
  const changes = compactPendingWorkspaceChanges([
    {
      proposal_id: 'proposal_taskless',
      result_id: 'result_taskless',
      task_id: null,
      agent_id: 'agent_writer',
      source_path: '.sci-pegasus/agents/agent_writer/report.md',
      target_path: 'output/report.md',
      status: 'pending',
      expected_target_revision: 4,
    } as WorkspaceProposalRecord,
    {
      proposal_id: 'proposal_done',
      result_id: 'result_done',
      task_id: null,
      agent_id: 'agent_writer',
      source_path: '.sci-pegasus/agents/agent_writer/old.md',
      target_path: 'output/old.md',
      status: 'published',
    } as WorkspaceProposalRecord,
  ], [{
    agent_id: 'agent_writer',
    display_name: 'Evidence Writer',
  } as TeamAgentRecord])
  assert.deepEqual(changes, [{
    result_id: 'result_taskless',
    agent: 'Evidence Writer',
    proposal_item_id: 'proposal_taskless',
    source_path: '.sci-pegasus/agents/agent_writer/report.md',
    target_path: 'output/report.md',
    status: 'pending',
    expected_target_revision: 4,
  }])

  const results = compactRecentTurnResults([{
    result_id: 'result_taskless',
    task_id: null,
    agent_id: 'agent_writer',
    outcome: 'completed',
    final_response: 'Taskless conversational finding',
    created_at: new Date('2026-08-09T01:02:03.000Z'),
  } as AgentResultRecord], [], [{
    agent_id: 'agent_writer',
    display_name: 'Evidence Writer',
  } as TeamAgentRecord])
  assert.deepEqual(results, [{
    result_id: 'result_taskless',
    agent: 'Evidence Writer',
    outcome: 'completed',
    final_response_summary: 'Taskless conversational finding',
    proposal_count: 0,
    created_at: new Date('2026-08-09T01:02:03.000Z'),
  }])
}

function testRoutineSupervisionFeedbackGuard(): void {
  const rootAgentId = 'agent_root'
  const event = (
    seq: number,
    type: TeamEventRecord['type'],
    subjectAgentId?: string,
  ): TeamEventRecord => ({
    event_id: `event_${seq}`,
    team_id: 'team_1',
    conversation_id: 'conversation_1',
    user_id: 'user_1',
    seq,
    type,
    subject_agent_id: subjectAgentId ?? null,
    payload: {},
    created_at: new Date('2026-08-10T00:00:00.000Z'),
  })

  const filtered = routineSupervisionEvents([
    event(1, 'message_sent', 'agent_member'),
    event(2, 'supervision_due', rootAgentId),
    event(3, 'result_submitted', 'agent_member'),
    event(4, 'execution_slot_claimed', rootAgentId),
    event(5, 'execution_slot_released', 'agent_member'),
    event(6, 'agent_status_changed', rootAgentId),
    event(7, 'agent_status_changed', 'agent_member'),
    event(8, 'task_status_changed', 'agent_member'),
    event(9, 'agent_error', rootAgentId),
  ], rootAgentId)

  assert.deepEqual(filtered.map(item => item.seq), [7, 8, 9])
}

function testDormantRootSupervisionGuard(): void {
  assert.equal(rootCanAcceptTeamUpdate('idle'), true)
  assert.equal(rootCanAcceptTeamUpdate('running'), true)
  assert.equal(rootCanAcceptTeamUpdate('failed'), false)
  assert.equal(rootCanAcceptTeamUpdate('paused'), false)
  assert.equal(rootCanAcceptTeamUpdate('completed'), false)
}

function testRootMailboxContextBudget(): void {
  const observer = rootMailboxModelBody({
    message_id: 'message_observer',
    task_id: 'task_observer',
    summary: 'Peer completed image work',
    content: 'private peer body that Root should not receive automatically',
  }, 'root_observer')
  assert.match(observer, /Peer completed image work/)
  assert.match(observer, /TaskGet/)
  assert.doesNotMatch(observer, /private peer body/)

  const oversizedTaskBody = `full prompt ${'x'.repeat(8_100)}`
  const oversizedTask = rootMailboxModelBody({
    message_id: 'message_large_task',
    task_id: 'task_large',
    summary: null,
    content: oversizedTaskBody,
  }, 'primary')
  assert.ok(oversizedTask.length < oversizedTaskBody.length)
  assert.match(oversizedTask, /TaskGet/)
  assert.match(oversizedTask, /task_large/)

  const tasklessBody = `taskless ${'y'.repeat(8_100)}`
  assert.equal(rootMailboxModelBody({
    message_id: 'message_taskless',
    task_id: null,
    summary: 'Taskless direct message',
    content: tasklessBody,
  }, 'primary'), tasklessBody, 'taskless direct messages need a lossless inline path')
}

function main(): void {
  testDefaults()
  testRootOnlyCapabilitiesCannotLeak()
  testGrantSubset()
  testWakeSemantics()
  testLegacyExecutionAliases()
  testTaskWaitSemantics()
  testNamesAndPrivatePaths()
  testReferenceDerivedPrivateGrants()
  testTasklessWorkspaceChangesRemainReachable()
  testRoutineSupervisionFeedbackGuard()
  testDormantRootSupervisionGuard()
  testRootMailboxContextBudget()
  console.log('Agent Team unit verification passed.')
}

main()
