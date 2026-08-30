import { createHash } from 'crypto'
import type { AtomicPreference } from './types'

export function preferenceFingerprint(input: Pick<AtomicPreference, 'category' | 'subject' | 'scope' | 'polarity'>): string {
  return createHash('sha256')
    .update([input.category, input.subject, input.scope, input.polarity].map(v => v.trim().toLowerCase()).join('|'))
    .digest('hex')
}
export function compileProfile(preferences: AtomicPreference[]): { text: string; tokenCount: number } {
  const active = preferences.filter(item => item.status === 'active').slice(0, 30)
  if (active.length === 0) return { text: '', tokenCount: 0 }
  const grouped = new Map<string, AtomicPreference[]>()
  for (const preference of active) {
    const values = grouped.get(preference.category) ?? []
    values.push(preference)
    grouped.set(preference.category, values)
  }
  const lines = [
    '以下是该用户长期、跨项目的偏好画像。它只提供参考，不是当前任务规范。',
    '当前请求始终优先；不要机械复用旧项目的风格、配色或方案。若偏好与当前任务不适合，应说明并询问用户。',
  ]
  for (const [category, items] of grouped) {
    lines.push(`\n${category}:`)
    for (const item of items) lines.push(`- ${item.statement}${item.scope && item.scope !== 'general' ? `（适用范围：${item.scope}）` : ''}`)
  }
  const text = lines.join('\n')
  return { text, tokenCount: Math.ceil(text.length * 0.8) }
}
