// ============================================================
// Per-conversation AbortController registry (process-level)
// Allows the interrupt endpoint to signal a running agent loop.
// Also maintains a userId → Set<conversationId> reverse index so
// rate limiting can count concurrent active loops per user.
// ============================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const registry: Map<string, { controller: AbortController; userId: string }> = (globalThis as any).__sci_pegasus_abort_registry ??= new Map()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const userIndex: Map<string, Set<string>> = (globalThis as any).__sci_pegasus_abort_user_index ??= new Map()

export function registerAbort(conversationId: string, controller: AbortController, userId: string): void {
  registry.set(conversationId, { controller, userId })
  let conversations = userIndex.get(userId)
  if (!conversations) {
    conversations = new Set()
    userIndex.set(userId, conversations)
  }
  conversations.add(conversationId)
}

export function unregisterAbort(conversationId: string): void {
  const entry = registry.get(conversationId)
  registry.delete(conversationId)
  if (entry) {
    const conversations = userIndex.get(entry.userId)
    if (conversations) {
      conversations.delete(conversationId)
      if (conversations.size === 0) userIndex.delete(entry.userId)
    }
  }
}

/** Trigger abort('interrupt') on a running conversation. Returns true if found. */
export function interruptConversation(conversationId: string): boolean {
  const entry = registry.get(conversationId)
  if (entry) {
    entry.controller.abort('interrupt')
    return true
  }
  return false
}

export function isConversationRunning(conversationId: string): boolean {
  return registry.has(conversationId)
}

/** Count active agent loops for a given user across all their conversations. */
export function getUserActiveLoopCount(userId: string): number {
  return userIndex.get(userId)?.size ?? 0
}

/** Abort every currently-running loop with the given reason. Used by the
 *  SIGTERM handler so in-flight agent work releases its DB/HTTP resources
 *  before the process exits. Returns the number of loops aborted. */
export function abortAllConversations(reason: string): number {
  let count = 0
  for (const entry of registry.values()) {
    entry.controller.abort(reason)
    count++
  }
  return count
}
