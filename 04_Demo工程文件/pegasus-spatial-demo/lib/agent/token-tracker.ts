// ============================================================
// Token Usage Tracker — execution-scoped through AsyncLocalStorage.
// Records all model API calls and prints usage reports without allowing
// concurrent Agent Runs to overwrite each other's attribution.
// ============================================================

import { AsyncLocalStorage } from 'node:async_hooks'

export interface CallRecord {
  source: string   // e.g. 'agent-loop' | 'web-search' | 'compaction' | 'memory-extraction'
  model: string
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  timestamp: number
  user_id?: string
  conversation_id?: string
  team_id?: string
  agent_id?: string
  task_id?: string
  run_id?: string
}

export interface TokenExecutionContext {
  userId?: string
  conversationId?: string
  teamId?: string
  agentId?: string
  taskId?: string
  runId?: string
}

interface TokenExecutionStore extends TokenExecutionContext {
  calls: CallRecord[]
}

interface SourceSummary {
  source: string
  model: string
  count: number
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
}

function fmt(n: number): string {
  return n.toLocaleString('en-US')
}

function pad(s: string, len: number, align: 'left' | 'right' = 'left'): string {
  if (align === 'right') return s.padStart(len)
  return s.padEnd(len)
}

class TokenTracker {
  private readonly storage = new AsyncLocalStorage<TokenExecutionStore>()

  /** Run work inside an explicitly attributed execution context. */
  runWithContext<T>(context: TokenExecutionContext, operation: () => T): T {
    return this.storage.run({ ...context, calls: [] }, operation)
  }

  /**
   * Compatibility entrypoint for existing request handlers. `enterWith`
   * scopes all promises subsequently created by the current async chain.
   */
  startRequest(
    userId?: string,
    conversationId?: string,
    context?: Omit<TokenExecutionContext, 'userId' | 'conversationId'>,
  ): void {
    this.storage.enterWith({
      ...context,
      userId,
      conversationId,
      calls: [],
    })
  }

  /** Update the current execution after a new Conversation is created. */
  setConversationId(conversationId: string): void {
    const store = this.storage.getStore()
    if (store) store.conversationId = conversationId
  }

  /** Current request's user ID (set via startRequest) */
  get userId(): string { return this.storage.getStore()?.userId || '' }
  /** Current request's conversation ID (set via startRequest) */
  get conversationId(): string { return this.storage.getStore()?.conversationId || '' }

  get context(): Readonly<TokenExecutionContext> {
    const store = this.storage.getStore()
    return store ? {
      userId: store.userId,
      conversationId: store.conversationId,
      teamId: store.teamId,
      agentId: store.agentId,
      taskId: store.taskId,
      runId: store.runId,
    } : {}
  }

  /** Record a model API call and print a real-time log line */
  record(record: Omit<CallRecord, 'timestamp'>): void {
    const store = this.storage.getStore()
    const full: CallRecord = {
      ...record,
      timestamp: Date.now(),
      ...(store?.userId ? { user_id: store.userId } : {}),
      ...(store?.conversationId ? { conversation_id: store.conversationId } : {}),
      ...(store?.teamId ? { team_id: store.teamId } : {}),
      ...(store?.agentId ? { agent_id: store.agentId } : {}),
      ...(store?.taskId ? { task_id: store.taskId } : {}),
      ...(store?.runId ? { run_id: store.runId } : {}),
    }
    store?.calls.push(full)
    this.printCallDetail(full)
  }

  /** Print a single call log line */
  private printCallDetail(r: CallRecord): void {
    const parts = [
      `[token] ${pad(r.source, 18)}`,
      `| ${pad(r.model, 28)}`,
      `| in: ${pad(fmt(r.input_tokens), 9, 'right')}`,
      `out: ${pad(fmt(r.output_tokens), 7, 'right')}`,
    ]
    if (r.cache_creation_input_tokens) {
      parts.push(`| cache_create: ${fmt(r.cache_creation_input_tokens)}`)
    }
    if (r.cache_read_input_tokens) {
      parts.push(`cache_read: ${fmt(r.cache_read_input_tokens)}`)
    }
    console.log(parts.join(' '))
  }

  /** Get calls from the current request only */
  private getCurrentCalls(): CallRecord[] {
    return this.storage.getStore()?.calls ?? []
  }

  /** Print formatted usage report for the current request */
  printReport(): void {
    const calls = this.getCurrentCalls()
    if (calls.length === 0) {
      console.log('[token] No model API calls recorded for this request.')
      return
    }

    // Group by source+model
    const groups = new Map<string, SourceSummary>()
    for (const c of calls) {
      const key = `${c.source}|${c.model}`
      const existing = groups.get(key)
      if (existing) {
        existing.count++
        existing.input_tokens += c.input_tokens
        existing.output_tokens += c.output_tokens
        existing.cache_creation_input_tokens += c.cache_creation_input_tokens || 0
        existing.cache_read_input_tokens += c.cache_read_input_tokens || 0
      } else {
        groups.set(key, {
          source: c.source,
          model: c.model,
          count: 1,
          input_tokens: c.input_tokens,
          output_tokens: c.output_tokens,
          cache_creation_input_tokens: c.cache_creation_input_tokens || 0,
          cache_read_input_tokens: c.cache_read_input_tokens || 0,
        })
      }
    }

    let totalIn = 0, totalOut = 0, totalCacheCreate = 0, totalCacheRead = 0

    const rows: { label: string; model: string; input: string; output: string }[] = []
    for (const g of groups.values()) {
      totalIn += g.input_tokens
      totalOut += g.output_tokens
      totalCacheCreate += g.cache_creation_input_tokens
      totalCacheRead += g.cache_read_input_tokens

      const label = g.count > 1 ? `${g.source} (x${g.count})` : g.source
      rows.push({ label: pad(label, 20), model: pad(g.model, 24), input: pad(fmt(g.input_tokens), 9, 'right'), output: pad(fmt(g.output_tokens), 8, 'right') })
    }

    // Column widths: source=22, model=26, input=11, output=10 → inner = 22+26+11+10+3(│) = 72
    const C1 = 22, C2 = 26, C3 = 11, C4 = 10
    const IW = C1 + C2 + C3 + C4 + 3  // 72, +3 for │ separators
    const sep = (l: string, m: string, r: string) => `${l}${'─'.repeat(C1)}${m}${'─'.repeat(C2)}${m}${'─'.repeat(C3)}${m}${'─'.repeat(C4)}${r}`

    function row(s: string, m: string, i: string, o: string) {
      return `║ ${s} │ ${m} │ ${i} │ ${o} ║`
    }

    console.log('')
    console.log(`╔${'═'.repeat(IW)}╗`)

    const title = 'TOKEN USAGE REPORT'
    const lp = Math.floor((IW - title.length) / 2)
    console.log(`║${' '.repeat(lp)}${title}${' '.repeat(IW - lp - title.length)}║`)

    console.log(sep('╠', '┬', '╣'))
    console.log(row(pad('Source', 20), pad('Model', 24), pad('Input', 9, 'right'), pad('Output', 8, 'right')))
    console.log(sep('╠', '┼', '╣'))

    for (const r of rows) {
      console.log(row(r.label, r.model, r.input, r.output))
    }

    console.log(sep('╠', '┼', '╣'))
    console.log(row(pad('TOTAL', 20), pad('', 24), pad(fmt(totalIn), 9, 'right'), pad(fmt(totalOut), 8, 'right')))

    if (totalCacheCreate > 0 || totalCacheRead > 0) {
      const cacheInfo = `Cache: created ${fmt(totalCacheCreate)} | read ${fmt(totalCacheRead)}`
      console.log(`║ ${pad(cacheInfo, IW - 2)}║`)
    }

    console.log(`╚${'═'.repeat(IW)}╝`)
    console.log('')
  }

}

export const tokenTracker = new TokenTracker()
