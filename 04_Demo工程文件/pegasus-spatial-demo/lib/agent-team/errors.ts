export class AgentTeamError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'AgentTeamError'
  }
}

export class AgentTeamNotFoundError extends AgentTeamError {
  constructor() {
    super('Agent team was not found for this user and project.', 'AGENT_TEAM_NOT_FOUND')
    this.name = 'AgentTeamNotFoundError'
  }
}

export class TeamAgentNotFoundError extends AgentTeamError {
  constructor(agentId?: string) {
    super('Agent was not found in this team.', 'TEAM_AGENT_NOT_FOUND', { agent_id: agentId })
    this.name = 'TeamAgentNotFoundError'
  }
}

export class AgentTaskNotFoundError extends AgentTeamError {
  constructor(taskId?: string) {
    super('Task was not found in this team.', 'AGENT_TASK_NOT_FOUND', { task_id: taskId })
    this.name = 'AgentTaskNotFoundError'
  }
}

export class AgentResultNotFoundError extends AgentTeamError {
  constructor(resultId?: string) {
    super('Result was not found in this team.', 'AGENT_RESULT_NOT_FOUND', { result_id: resultId })
    this.name = 'AgentResultNotFoundError'
  }
}

export class AgentPermissionError extends AgentTeamError {
  constructor(capability: string) {
    super(`Agent does not have the required ${capability} grant.`, 'AGENT_PERMISSION_DENIED', {
      capability,
    })
    this.name = 'AgentPermissionError'
  }
}

export class AgentTeamCapacityError extends AgentTeamError {
  constructor(limit: number) {
    super(`Agent team has reached its ${limit}-agent identity limit.`, 'AGENT_TEAM_CAPACITY', {
      limit,
    })
    this.name = 'AgentTeamCapacityError'
  }
}

export class AgentExecutionCapacityError extends AgentTeamError {
  constructor(limit: number) {
    super(`Agent team has reached its ${limit}-execution concurrency limit.`, 'AGENT_EXECUTION_CAPACITY', {
      limit,
    })
    this.name = 'AgentExecutionCapacityError'
  }
}

export class AgentCommandInProgressError extends AgentTeamError {
  constructor(commandKey: string) {
    super('The same agent command is still being processed.', 'AGENT_COMMAND_IN_PROGRESS', {
      command_key: commandKey,
    })
    this.name = 'AgentCommandInProgressError'
  }
}

export class AgentCommandFenceLostError extends AgentTeamError {
  constructor(commandKey: string) {
    super('The command lease was lost before its result became durable.', 'AGENT_COMMAND_FENCE_LOST', {
      command_key: commandKey,
    })
    this.name = 'AgentCommandFenceLostError'
  }
}

export class AgentSessionLeaseLostError extends AgentTeamError {
  constructor(sessionId: string) {
    super('The Agent Session run lease is no longer owned by this executor.', 'AGENT_SESSION_LEASE_LOST', {
      session_id: sessionId,
    })
    this.name = 'AgentSessionLeaseLostError'
  }
}

export class AgentControlFenceLostError extends AgentTeamError {
  constructor(runId: string) {
    super(
      'The Agent Run no longer owns the execution fence for this control command.',
      'AGENT_CONTROL_FENCE_LOST',
      { run_id: runId },
    )
    this.name = 'AgentControlFenceLostError'
  }
}

export class AgentExecutionBudgetExceededError extends AgentTeamError {
  constructor(input: {
    scope: 'team' | 'agent' | 'task'
    dimension: 'tokens' | 'cost_usd' | 'tool_calls' | 'download_bytes'
    limit: number
    used: number
  }) {
    super(
      `Agent execution ${input.scope} budget is exhausted for ${input.dimension}.`,
      'AGENT_EXECUTION_BUDGET_EXCEEDED',
      input,
    )
    this.name = 'AgentExecutionBudgetExceededError'
  }
}

export class InvalidAgentTeamOperationError extends AgentTeamError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'INVALID_AGENT_TEAM_OPERATION', details)
    this.name = 'InvalidAgentTeamOperationError'
  }
}
