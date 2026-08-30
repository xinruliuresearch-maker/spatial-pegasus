/** Base URL for all LLM API calls. No public-provider fallback is allowed: an
 * isolated Sci-Pegasus deployment must select its gateway explicitly. */
export const LLM_BASE_URL = process.env.LLM_BASE_URL?.trim().replace(/\/+$/, '') || ''

/**
 * API key used by the main agent loop (orchestrator models — Claude Opus etc.).
 * Separated from the tool key so the gateway can enforce channel budgets and permissions;
 * a runaway tool loop cannot burn the orchestrator budget.
 *
 * Required in production. Throws (via resolveAlias) if unset when an orchestrator
 * alias is resolved. No implicit fallback — be explicit about which key is in use.
 */
export const LLM_API_KEY_ORCHESTRATOR = process.env.LLM_API_KEY_ORCHESTRATOR || ''

/**
 * API key for tool-layer calls such as web search and memory extraction.
 * Higher-volume + cheaper per-call than the orchestrator, so the gateway grants this
 * key access only to the tool model set with its own budget cap.
 */
export const LLM_API_KEY_TOOLS = process.env.LLM_API_KEY_TOOLS || ''
