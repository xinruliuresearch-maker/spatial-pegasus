import assert from 'node:assert/strict'
import { Conversation } from '../models'
import {
  ImmutableConversationFieldError,
  updateConversationFields,
} from '../repository'

async function run(): Promise<void> {
  const schemaPath = Conversation.schema.path('project_guide') as typeof Conversation.schema.paths[string] & {
    $immutable?: boolean
  }
  assert.equal(schemaPath.$immutable, true)

  const initialGuide = { template_id: 'spatial-creation', version: 1 }
  const conversation = new Conversation({
    conversation_id: 'project-guide-create-test',
    user_id: 'test-user',
    project_guide: initialGuide,
  })
  assert.deepEqual(conversation.project_guide, initialGuide)

  conversation.isNew = false
  conversation.project_guide = { template_id: 'other-template', version: 2 }
  assert.deepEqual(conversation.project_guide, initialGuide)

  await assert.rejects(
    updateConversationFields('conversation', 'user', {
      project_guide: { template_id: 'other-template', version: 2 },
    }),
    (error: unknown) => error instanceof ImmutableConversationFieldError,
  )
  console.log('project guide boundary verification passed')
}

void run()
