import { NextRequest, NextResponse } from 'next/server'
import { cleanupExpiredStagedAssets } from '@/lib/media/storage'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Cron endpoint for 24-hour staged-orphan collection. */
export async function POST(req: NextRequest) {
  const expected = process.env.CRON_SECRET
  const supplied = req.headers.get('authorization')
  if (!expected || supplied !== `Bearer ${expected}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const deleted = await cleanupExpiredStagedAssets()
  return NextResponse.json({ deleted })
}
