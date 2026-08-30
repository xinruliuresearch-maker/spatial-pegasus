import { NextResponse } from 'next/server'
import { resolveLocalOwner } from '@/lib/local-owner'
import { getOrCreateProfile } from '@/lib/memory-v2/repository'

export const dynamic = 'force-dynamic'

export async function GET() {
  const userId = await resolveLocalOwner()
  if (userId instanceof Response) return userId
  const profile = await getOrCreateProfile(userId)
  return NextResponse.json({
    version: profile.version,
    compiled_text: profile.compiled_text,
    token_count: profile.token_count,
    preferences: profile.preferences,
    updated_at: profile.updated_at,
  })
}
