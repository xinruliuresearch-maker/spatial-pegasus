import { NextResponse } from 'next/server'
import mongoose from 'mongoose'
import { isAgentRunnerEnabled } from '@/lib/agent-runtime/runner'

// Liveness + readiness probe for container orchestrators. Returns 200 when the
// process is up AND the MongoDB connection is established (readyState === 1).
// When Mongo is disconnected we return 503 so K8s / Docker healthchecks can
// restart or stop routing traffic to this instance.

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const startedAt = Date.now()

const MONGO_STATES = ['disconnected', 'connected', 'connecting', 'disconnecting'] as const

export function GET(): NextResponse {
  const state = mongoose.connection.readyState as 0 | 1 | 2 | 3
  const mongo = MONGO_STATES[state] ?? 'unknown'
  const healthy = state === 1

  return NextResponse.json(
    {
      status: healthy ? 'ok' : 'degraded',
      uptime_ms: Date.now() - startedAt,
      mongo,
      agent_runner: isAgentRunnerEnabled() ? 'ready' : 'inline',
    },
    { status: healthy ? 200 : 503 },
  )
}
