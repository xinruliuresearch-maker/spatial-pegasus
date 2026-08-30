import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { agentLoop, type AgentProvider } from '../../agent/loop'
import {
  canExecuteTool,
  toolCommandKey,
  type AgentExecutionContext,
} from '../../agent/execution-context'
import { tokenTracker, type CallRecord } from '../../agent/token-tracker'
import { getToolSchemasForCapabilities } from '../../tools/schemas'
import { createInMemoryWorkspace } from '../../tools/__test-utils__/in-memory-workspace'
import type { LLMResponse, ToolResult, ToolSchema } from '../../types'
import {
  agentScratchPrefix,
  canAgentReadWorkspacePath,
  canAgentWriteWorkspacePath,
  scopeWorkspaceForAgent,
} from '../../workspace/agent-scope'
import {
  memberDelegationGrant,
  visibleAgentTeamTools,
} from '../policy'

const TEAM_TOOLS = [
  'Agent',
  'SendMessage',
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
  'ReviewWorkspaceChanges',
  'ManageAgent',
] as const

const EMPTY_USAGE = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
}

function response(content: LLMResponse['content']): LLMResponse {
  return {
    content,
    stop_reason: content.some(block => block.type === 'tool_use')
      ? 'tool_use'
      : 'end_turn',
    usage: { ...EMPTY_USAGE },
  }
}

class ScriptedProvider implements AgentProvider {
  readonly executed: Array<{ name: string; input: Record<string, unknown> }> = []
  readonly toolSchemas: readonly ToolSchema[] = [
    ...getToolSchemasForCapabilities({ supportsVision: true }),
    {
      name: 'WaitForAgents',
      description: 'Legacy recovery contract test tool.',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'SubmitAgentResult',
      description: 'Legacy recovery contract test tool.',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'SendAgentMessage',
      description: 'Legacy recovery contract test tool.',
      input_schema: { type: 'object', properties: {} },
    },
  ]

  constructor(
    private readonly responses: LLMResponse[],
    private readonly results: Record<string, ToolResult>,
  ) {}

  buildRequest(): Record<string, never> {
    return {}
  }

  buildCompactionRequest(): Record<string, never> {
    return {}
  }

  async callLLM(): Promise<LLMResponse> {
    const next = this.responses.shift()
    assert.ok(next, 'scripted provider ran out of model responses')
    return next
  }

  async callLLMSilent(): Promise<LLMResponse> {
    throw new Error('compaction is not expected in this focused test')
  }

  async executeTool(
    name: string,
    input: Record<string, unknown>,
  ): Promise<ToolResult> {
    this.executed.push({ name, input })
    return this.results[name] ?? { content: `executed ${name}` }
  }
}

function names(options: Parameters<typeof getToolSchemasForCapabilities>[0]): string[] {
  return getToolSchemasForCapabilities(options).map(tool => tool.name)
}

function testToolVisibilityAndExecutionAllowlist(): void {
  const rootTools = names({ supportsVision: true })
  for (const name of TEAM_TOOLS) {
    assert.ok(rootTools.includes(name), `Root must see ${name}`)
  }
  assert.ok(rootTools.includes('AskUserQuestion'), 'Root keeps user interaction authority')

  const memberGrant = memberDelegationGrant({
    allowed_tool_names: ['Read', 'SearchDocument'],
  })
  const memberAllowed = [
    ...memberGrant.allowed_tool_names,
    ...visibleAgentTeamTools(memberGrant),
  ]
  const memberTools = names({
    supportsVision: true,
    allowedTools: memberAllowed,
    allowAskUser: false,
  })
  assert.deepEqual(memberTools, [
    'Read',
    'SearchDocument',
    'SendMessage',
    'TaskUpdate',
    'TaskList',
    'TaskGet',
  ])
  for (const forbidden of [
    'Agent',
    'TaskCreate',
    'ReviewWorkspaceChanges',
    'ManageAgent',
    'AskUserQuestion',
  ]) {
    assert.ok(!memberTools.includes(forbidden), `member must not see ${forbidden}`)
  }

  const delegatedGrant = memberDelegationGrant({
    allowed_tool_names: ['Read'],
    capabilities: { can_delegate_tasks: true },
  })
  assert.ok(visibleAgentTeamTools(delegatedGrant).includes('TaskCreate'))

  const context: AgentExecutionContext = {
    userId: 'user_1',
    conversationId: 'conversation_1',
    runId: 'run_1',
    isRoot: false,
    allowedTools: memberAllowed,
  }
  assert.equal(canExecuteTool(context, 'Read'), true)
  assert.equal(canExecuteTool(context, 'CreateAgent'), false)
  assert.equal(canExecuteTool(context, 'SendAgentMessage'), true, 'legacy alias remains execution-only compatible')
  assert.equal(canExecuteTool(context, 'WaitForAgents'), true, 'legacy wait receipt can replay')
  assert.equal(canExecuteTool(context, 'SubmitAgentResult'), true, 'legacy submit receipt can replay')
  assert.equal(canExecuteTool(undefined, 'CreateAgent'), true, 'legacy/root execution remains unrestricted')
  assert.equal(toolCommandKey(context, { toolUseId: 'tool_1' }), 'run_1:tool_1')
}

async function testWaitBoundaryIsExclusiveAndDurable(): Promise<void> {
  const provider = new ScriptedProvider([
    response([
      {
        type: 'tool_use',
        id: 'tool_wait',
        name: 'WaitForAgents',
        input: { task_ids: ['task_1'], mode: 'all' },
      },
    ]),
  ], {
    WaitForAgents: {
      content: 'wait persisted',
      control: 'wait_agents',
    },
  })
  const persisted: string[] = []
  const completedActions: string[] = []
  const result = await agentLoop(provider, [], {
    runId: 'run_wait',
    maxTurns: 2,
    onTurnComplete(messages) {
      for (const message of messages) {
        for (const block of message.content) {
          if (block.type === 'tool_result') persisted.push(block.content as string)
        }
      }
    },
    onActionComplete({ actionId }) {
      completedActions.push(actionId)
    },
  })

  assert.equal(result.waitingForAgents, true)
  assert.equal(result.taskSubmitted, false)
  assert.deepEqual(provider.executed.map(item => item.name), ['WaitForAgents'])
  assert.deepEqual(persisted, ['wait persisted'], 'wait receipt must be checkpointed before return')
  assert.equal(completedActions.length, 2, 'model and wait tool actions must both close durably')
}

async function testSubmitBoundaryIsExclusiveAndDurable(): Promise<void> {
  const provider = new ScriptedProvider([
    response([
      {
        type: 'tool_use',
        id: 'tool_submit',
        name: 'SubmitAgentResult',
        input: { task_id: 'task_1', outcome: 'completed', summary: 'done' },
      },
    ]),
  ], {
    SubmitAgentResult: {
      content: 'result persisted',
      control: 'task_submitted',
    },
  })
  const persisted: string[] = []
  const result = await agentLoop(provider, [], {
    runId: 'run_submit',
    maxTurns: 2,
    onTurnComplete(messages) {
      for (const message of messages) {
        for (const block of message.content) {
          if (block.type === 'tool_result') persisted.push(block.content as string)
        }
      }
    },
  })

  assert.equal(result.taskSubmitted, true)
  assert.equal(result.waitingForAgents, false)
  assert.deepEqual(provider.executed.map(item => item.name), ['SubmitAgentResult'])
  assert.deepEqual(persisted, ['result persisted'])
}

async function testMixedControlBatchExecutesNothing(): Promise<void> {
  const provider = new ScriptedProvider([
    response([
      {
        type: 'tool_use',
        id: 'tool_message',
        name: 'SendAgentMessage',
        input: { to_agent_id: 'agent_2', kind: 'info', message: 'hello' },
      },
      {
        type: 'tool_use',
        id: 'tool_wait',
        name: 'WaitForAgents',
        input: { task_ids: ['task_1'], mode: 'all' },
      },
    ]),
    response([{ type: 'text', text: 'retried safely' }]),
  ], {})
  const result = await agentLoop(provider, [], {
    runId: 'run_invalid_batch',
    maxTurns: 2,
  })

  assert.deepEqual(provider.executed, [], 'no side effect may run from an invalid control batch')
  assert.equal(result.waitingForAgents, undefined)
  assert.equal(result.taskSubmitted, undefined)
  assert.equal(result.text, 'retried safely')
  assert.equal(result.toolCalls.length, 2)
  assert.ok(result.toolCalls.every(call => call.result.is_error === true))
  assert.ok(result.toolCalls.every(call => /must be called alone/.test(call.result.content)))
}

async function testExecutionScopedTokenAttribution(): Promise<void> {
  const suffix = randomUUID()
  const sourceA = `team-runtime-a-${suffix}`
  const sourceB = `team-runtime-b-${suffix}`
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const originalLog = console.log
  console.log = () => undefined
  try {
    const executionA = tokenTracker.runWithContext({
      userId: 'user_a',
      conversationId: 'conversation_a',
      teamId: 'team_a',
      agentId: 'agent_a',
      taskId: 'task_a',
      runId: 'run_a',
    }, async () => {
      await gate
      tokenTracker.record({
        source: sourceA,
        model: 'model_a',
        input_tokens: 11,
        output_tokens: 3,
      })
      return {
        context: { ...tokenTracker.context },
        calls: [
          ...(tokenTracker as unknown as { getCurrentCalls(): CallRecord[] }).getCurrentCalls(),
        ],
      }
    })
    const executionB = tokenTracker.runWithContext({
      userId: 'user_b',
      conversationId: 'conversation_b',
      teamId: 'team_b',
      agentId: 'agent_b',
      taskId: 'task_b',
      runId: 'run_b',
    }, async () => {
      await gate
      tokenTracker.record({
        source: sourceB,
        model: 'model_b',
        input_tokens: 17,
        output_tokens: 5,
      })
      return {
        context: { ...tokenTracker.context },
        calls: [
          ...(tokenTracker as unknown as { getCurrentCalls(): CallRecord[] }).getCurrentCalls(),
        ],
      }
    })
    release()
    const [resultA, resultB] = await Promise.all([executionA, executionB])
    assert.equal(resultA.context.runId, 'run_a')
    assert.equal(resultB.context.runId, 'run_b')

    const records = [...resultA.calls, ...resultB.calls]
      .filter(call => call.source === sourceA || call.source === sourceB)
    assert.equal(records.length, 2)
    const recordA = records.find(call => call.source === sourceA)
    const recordB = records.find(call => call.source === sourceB)
    assert.deepEqual(
      {
        user: recordA?.user_id,
        conversation: recordA?.conversation_id,
        team: recordA?.team_id,
        agent: recordA?.agent_id,
        task: recordA?.task_id,
        run: recordA?.run_id,
      },
      {
        user: 'user_a',
        conversation: 'conversation_a',
        team: 'team_a',
        agent: 'agent_a',
        task: 'task_a',
        run: 'run_a',
      },
    )
    assert.equal(recordB?.run_id, 'run_b')
    assert.equal(recordB?.agent_id, 'agent_b')
    assert.equal(recordB?.team_id, 'team_b')
  } finally {
    console.log = originalLog
  }
}

async function testWorkspaceScopeAcl(): Promise<void> {
  const workspace = createInMemoryWorkspace()
  await workspace.writeText('output/public.md', 'public')
  await workspace.writeText('.sci-pegasus/agents/agent_a/own.md', 'own')
  await workspace.writeText('.sci-pegasus/agents/agent_b/shared.md', 'shared by exact ref')
  await workspace.writeText('.sci-pegasus/agents/agent_b/hidden.md', 'hidden')
  await workspace.writeText('.sci-pegasus/versions/secret.md', 'internal')

  const scope = {
    agentId: 'agent_a',
    isRoot: false,
    readablePrivatePaths: ['.sci-pegasus/agents/agent_b/shared.md'],
  }
  assert.equal(agentScratchPrefix('agent_a'), '.sci-pegasus/agents/agent_a/')
  assert.equal(canAgentReadWorkspacePath('output/public.md', scope), true)
  assert.equal(canAgentReadWorkspacePath('.sci-pegasus/agents/agent_a/own.md', scope), true)
  assert.equal(canAgentReadWorkspacePath('.sci-pegasus/agents/agent_b/shared.md', scope), true)
  assert.equal(canAgentReadWorkspacePath('.sci-pegasus/agents/agent_b/hidden.md', scope), false)
  assert.equal(
    canAgentReadWorkspacePath('.sci-pegasus/versions/secret.md', scope),
    false,
    'members must not read internal metadata outside their private directory',
  )
  assert.equal(canAgentWriteWorkspacePath('.sci-pegasus/agents/agent_a/new.md', scope), true)
  assert.equal(canAgentWriteWorkspacePath('output/member.md', scope), false)
  assert.equal(canAgentWriteWorkspacePath('references/papers/paper-1/source-fulltext.md', scope), false)
  assert.equal(canAgentWriteWorkspacePath(
    'references/papers/paper-1/source-fulltext.md',
    scope,
    { managedLiterature: true },
  ), true)

  const scoped = scopeWorkspaceForAgent(workspace, scope)
  assert.deepEqual(scoped.list().sort(), [
    '.sci-pegasus/agents/agent_a/own.md',
    '.sci-pegasus/agents/agent_b/shared.md',
    'output/public.md',
  ])
  assert.equal(await scoped.readText('output/public.md'), 'public')
  assert.equal(await scoped.readText('.sci-pegasus/agents/agent_b/shared.md'), 'shared by exact ref')
  await assert.rejects(
    scoped.readText('.sci-pegasus/agents/agent_b/hidden.md'),
    /not permitted/,
  )
  await assert.rejects(
    scoped.readText('.sci-pegasus/versions/secret.md'),
    /not permitted/,
  )
  await scoped.writeText('.sci-pegasus/agents/agent_a/new.md', 'new')
  await assert.rejects(scoped.writeText('output/member.md', 'forbidden'), /only write/)

  const memberArchiveOptions: Array<{ archive?: boolean } | undefined> = []
  const archiveProbe = scopeWorkspaceForAgent({
    ...workspace,
    async writeText(path, content, note, options) {
      memberArchiveOptions.push(options)
      return workspace.writeText(path, content, note, options)
    },
  }, scope)
  await archiveProbe.writeText('.sci-pegasus/agents/agent_a/overwrite.md', 'v1')
  await archiveProbe.writeText(
    '.sci-pegasus/agents/agent_a/overwrite.md',
    'v2',
    undefined,
    { archive: true },
  )
  assert.deepEqual(
    memberArchiveOptions.map(options => options?.archive),
    [false, false],
    'member overwrites must use path-level CAS history without creating a shared legacy archive',
  )
  assert.equal(
    archiveProbe.list('.sci-pegasus/versions/**').length,
    0,
    'member private overwrites must never create a legacy archive path',
  )

  const root = scopeWorkspaceForAgent(workspace, { agentId: 'root', isRoot: true })
  assert.equal(await root.readText('.sci-pegasus/agents/agent_b/hidden.md'), 'hidden')
  await root.writeText('output/root.md', 'root')
}

async function main(): Promise<void> {
  testToolVisibilityAndExecutionAllowlist()
  await testWaitBoundaryIsExclusiveAndDurable()
  await testSubmitBoundaryIsExclusiveAndDurable()
  await testMixedControlBatchExecutesNothing()
  await testExecutionScopedTokenAttribution()
  await testWorkspaceScopeAcl()
  console.log('Agent Team runtime contracts verification passed.')
}

void main()
