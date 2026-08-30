import { randomUUID } from 'crypto'
import type {
  AskUserInteraction,
  AskUserQuestionItem,
  AskUserQuestionOption,
} from '../types'

const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/

function normalizeOption(value: unknown, index: number): AskUserQuestionOption {
  if (typeof value === 'string') {
    const label = value.trim()
    if (!label) throw new Error(`option ${index + 1} has an empty label`)
    return { label }
  }
  if (!value || typeof value !== 'object') {
    throw new Error(`option ${index + 1} must be an object or string`)
  }
  const option = value as Record<string, unknown>
  const label = typeof option.label === 'string' ? option.label.trim() : ''
  if (!label) throw new Error(`option ${index + 1} has an empty label`)
  const description = typeof option.description === 'string'
    ? option.description.trim().slice(0, 240)
    : undefined
  return { label, ...(description ? { description } : {}) }
}

function normalizeQuestion(value: unknown, index: number): AskUserQuestionItem {
  if (!value || typeof value !== 'object') {
    throw new Error(`question ${index + 1} must be an object`)
  }
  const question = value as Record<string, unknown>
  const id = typeof question.id === 'string' ? question.id.trim() : ''
  const header = typeof question.header === 'string' ? question.header.trim() : ''
  const text = typeof question.question === 'string' ? question.question.trim() : ''
  if (!ID_PATTERN.test(id)) {
    throw new Error(`question ${index + 1} id must match ${ID_PATTERN}`)
  }
  if (!header || header.length > 12) {
    throw new Error(`question ${id} header must contain 1-12 characters`)
  }
  if (!text) throw new Error(`question ${id} is empty`)
  if (!Array.isArray(question.options) || question.options.length < 2 || question.options.length > 5) {
    throw new Error(`question ${id} must contain 2-5 options`)
  }
  const options = question.options.map(normalizeOption)
  const labels = new Set(options.map(option => option.label))
  if (labels.size !== options.length) {
    throw new Error(`question ${id} contains duplicate option labels`)
  }
  return {
    id,
    header,
    question: text,
    options,
    multi_select: question.multi_select === true,
    required: question.required !== false,
    allow_custom: question.allow_custom !== false,
  }
}

export function normalizeAskUserQuestionInput(input: Record<string, unknown>): AskUserInteraction {
  let rawQuestions: unknown[]
  if (Array.isArray(input.questions)) {
    rawQuestions = input.questions
  } else if (typeof input.question === 'string') {
    const legacyOptions = Array.isArray(input.options) ? input.options : []
    rawQuestions = [{
      id: 'question',
      header: '需要确认',
      question: input.question,
      options: legacyOptions.map(label => ({ label })),
      multi_select: false,
      required: true,
      allow_custom: true,
    }]
  } else {
    throw new Error('questions must contain 1-4 questions')
  }
  if (rawQuestions.length < 1 || rawQuestions.length > 4) {
    throw new Error('questions must contain 1-4 questions')
  }
  const questions = rawQuestions.map(normalizeQuestion)
  const ids = new Set(questions.map(question => question.id))
  if (ids.size !== questions.length) throw new Error('question ids must be unique')
  return { interaction_id: `ask_${randomUUID()}`, questions }
}

export function formatAskUserAnswers(
  questions: AskUserQuestionItem[],
  answers: Record<string, string[]>,
): string {
  const lines = ['我对你刚才问题的回答：', '']
  questions.forEach((question, index) => {
    lines.push(`${index + 1}. ${question.header}`)
    lines.push(`问题：${question.question}`)
    lines.push(`回答：${(answers[question.id] ?? []).join('、') || '未回答'}`)
    if (index < questions.length - 1) lines.push('')
  })
  return lines.join('\n')
}
