import type { ToolSchema } from '../types'
import {
  isLegacyAgentTeamToolName,
  type LegacyAgentTeamToolName,
} from './policy'

/**
 * Input contracts for Team tools that existed before the conversational Team
 * surface was introduced.  These schemas are intentionally recovery-only:
 * they must never be merged into `lib/tools/schemas.ts`, provider requests, or
 * prompt token accounting.  Their sole purpose is to re-validate an exact
 * durable tool_use whose tool-call action was already journalled before an
 * upgrade or process restart.
 */

const stringItem = { type: 'string', minLength: 1 } as const

const budgetSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    max_tokens: { type: 'integer', minimum: 0 },
    max_cost_usd: { type: 'number', minimum: 0 },
    max_tool_calls: { type: 'integer', minimum: 0 },
    max_download_bytes: { type: 'integer', minimum: 0 },
  },
} as const

const fileReviewSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    proposal_item_id: { type: 'string', minLength: 1 },
    action: {
      type: 'string',
      enum: ['accept', 'reject', 'retarget', 'request_changes'],
    },
    target_path: { type: 'string' },
    expected_target_revision: { type: ['integer', 'null'], minimum: 0 },
    reason: { type: 'string', maxLength: 4000 },
  },
  required: ['proposal_item_id', 'action'],
} as const

const legacyRecoveryToolSchemas: Readonly<Record<LegacyAgentTeamToolName, ToolSchema>> = {
  CreateAgent: {
    name: 'CreateAgent',
    description: 'Recovery-only legacy Team tool input contract.',
    input_schema: {
      type: 'object',
      properties: {
        alias: { type: 'string', minLength: 1, maxLength: 120 },
        role: { type: 'string', minLength: 1, maxLength: 500 },
        instructions: { type: 'string', maxLength: 12000 },
        allowed_tools: {
          type: 'array',
          maxItems: 100,
          uniqueItems: true,
          items: stringItem,
        },
        can_delegate_tasks: { type: 'boolean' },
        budget: budgetSchema,
        initial_task: {
          type: 'object',
          additionalProperties: false,
          properties: {
            objective: { type: 'string', minLength: 1, maxLength: 20000 },
            acceptance_criteria: {
              type: 'array',
              maxItems: 100,
              items: stringItem,
            },
            context_refs: {
              type: 'array',
              maxItems: 200,
              items: stringItem,
            },
          },
          required: ['objective'],
        },
      },
      required: ['alias', 'role'],
    },
  },
  AssignAgentTask: {
    name: 'AssignAgentTask',
    description: 'Recovery-only legacy Team tool input contract.',
    input_schema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', minLength: 1 },
        objective: { type: 'string', minLength: 1, maxLength: 20000 },
        acceptance_criteria: {
          type: 'array',
          maxItems: 100,
          items: stringItem,
        },
        context_refs: {
          type: 'array',
          maxItems: 200,
          items: stringItem,
        },
        depends_on: {
          type: 'array',
          maxItems: 100,
          uniqueItems: true,
          items: stringItem,
        },
        budget: budgetSchema,
      },
      required: ['agent_id', 'objective'],
    },
  },
  SendAgentMessage: {
    name: 'SendAgentMessage',
    description: 'Recovery-only legacy Team tool input contract.',
    input_schema: {
      type: 'object',
      properties: {
        to_agent_id: { type: 'string', minLength: 1 },
        kind: {
          type: 'string',
          enum: ['info', 'request', 'review', 'response', 'progress', 'blocker', 'error'],
        },
        message: { type: 'string', minLength: 1, maxLength: 50000 },
        summary: { type: 'string', maxLength: 500 },
        task_id: { type: 'string', minLength: 1 },
        reply_to: { type: 'string', minLength: 1 },
        refs: {
          type: 'array',
          maxItems: 100,
          items: stringItem,
        },
      },
      required: ['to_agent_id', 'kind', 'message'],
    },
  },
  InspectAgentTeam: {
    name: 'InspectAgentTeam',
    description: 'Recovery-only legacy Team tool input contract.',
    input_schema: {
      type: 'object',
      properties: {
        agent_ids: {
          type: 'array',
          maxItems: 100,
          uniqueItems: true,
          items: stringItem,
        },
        task_ids: {
          type: 'array',
          maxItems: 100,
          uniqueItems: true,
          items: stringItem,
        },
        include_recent_messages: { type: 'boolean' },
        include_results: { type: 'boolean' },
        after_seq: { type: 'integer', minimum: 0 },
      },
    },
  },
  WaitForAgents: {
    name: 'WaitForAgents',
    description: 'Recovery-only legacy Team tool input contract.',
    input_schema: {
      type: 'object',
      properties: {
        task_ids: {
          type: 'array',
          minItems: 1,
          maxItems: 100,
          uniqueItems: true,
          items: stringItem,
        },
        mode: { type: 'string', enum: ['all', 'any'] },
        timeout_seconds: { type: 'integer', minimum: 10, maximum: 86400 },
      },
      required: ['task_ids'],
    },
  },
  SubmitAgentResult: {
    name: 'SubmitAgentResult',
    description: 'Recovery-only legacy Team tool input contract.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', minLength: 1 },
        outcome: { type: 'string', enum: ['completed', 'blocked', 'failed'] },
        summary: { type: 'string', minLength: 1, maxLength: 100000 },
        findings: { type: 'array', maxItems: 500, items: {} },
        refs: {
          type: 'array',
          maxItems: 500,
          items: stringItem,
        },
        proposed_files: {
          type: 'array',
          maxItems: 500,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              source_path: { type: 'string', minLength: 1 },
              target_path: { type: 'string', minLength: 1 },
            },
            required: ['source_path'],
          },
        },
      },
      required: ['task_id', 'summary'],
    },
  },
  ReviewAgentResult: {
    name: 'ReviewAgentResult',
    description: 'Recovery-only legacy Team tool input contract.',
    input_schema: {
      type: 'object',
      properties: {
        result_id: { type: 'string', minLength: 1 },
        task_action: { type: 'string', enum: ['accept', 'rework'] },
        feedback: { type: 'string', maxLength: 16000 },
        file_reviews: {
          type: 'array',
          maxItems: 500,
          items: fileReviewSchema,
        },
      },
      required: ['result_id', 'task_action', 'file_reviews'],
    },
  },
}

export function getLegacyAgentTeamRecoverySchema(name: string): ToolSchema | undefined {
  return isLegacyAgentTeamToolName(name)
    ? legacyRecoveryToolSchemas[name]
    : undefined
}

export function getLegacyAgentTeamRecoverySchemaNames(): LegacyAgentTeamToolName[] {
  return Object.keys(legacyRecoveryToolSchemas) as LegacyAgentTeamToolName[]
}
