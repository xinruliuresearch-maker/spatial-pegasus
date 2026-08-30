import { NextResponse } from 'next/server'
import { resolveLocalOwner } from '@/lib/local-owner'
import { getUserPlan, getUserModelOverrides } from '@/lib/demo-access-policy'
import { listVisibleMainAliases } from '@/lib/llm-registry'

export const dynamic = 'force-dynamic'

/**
 * Return the list of main-loop model aliases visible to the currently logged-in
 * user, filtered by their subscription plan. The frontend chat picker calls this
 * and renders `displayName` + `displayDescription`; the selected `alias` (NOT
 * the real model ID) is what gets sent back in /api/chat settings.
 *
 * Test-mode users (`test_mode: true` on user doc) get a single masked entry
 * with displayName "AI 助手" — the picker UI naturally locks to that one
 * option and the underlying alias resolves to forced_main_alias (or plan
 * default if force is unset/invalid). Backend chat route enforces the same
 * forced-alias decision so frontend / backend agree.
 */
export async function GET() {
  const userId = await resolveLocalOwner()
  if (userId instanceof Response) return userId

  const [plan, overrides] = await Promise.all([
    getUserPlan(userId),
    getUserModelOverrides(userId),
  ])
  const aliases = listVisibleMainAliases(plan, {
    mask: overrides.test_mode,
    forcedAlias: overrides.forced_main_alias,
  })

  // Compatibility shape: keep `id` and `name` fields so older frontend code that
  // reads those still works. `alias` is the canonical new field.
  return NextResponse.json(aliases.map(a => ({
    id: a.alias,
    name: a.displayName,
    description: a.displayDescription,
    alias: a.alias,
    supportsVision: a.supportsVision,
  })))
}
