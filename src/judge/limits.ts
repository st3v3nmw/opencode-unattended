/** What the judge is shown. The request being judged is never truncated, because the judge decides on exactly what it sees. */
export const MAX_TOOL_CALL_CHARS = 8_000
export const USER_MESSAGES = 5
export const USER_MESSAGE_CHARS = 2_000
export const RECENT_TOOL_CALLS = 10
export const RECENT_TOOL_CALL_CHARS = 8_000

/** The answer is short, but a reasoning model spends tokens thinking first, and a cut-off answer is no answer. */
export const DEFAULT_MAX_TOKENS = 4096

/** Errors quoted in messages and the audit log. */
export const SNIPPET_CHARS = 200

/** How many call ids, cached refusals and the like are remembered before the oldest are forgotten. */
export const MAX_TRACKED = 100

export const DEFAULT_TIMEOUT_MS = 30_000

/** How long to wait before each retry of a failed call that names no delay. The last one also caps a Retry-After. */
export const RETRY_DELAYS_MS = [15_000, 30_000, 60_000]
export const MAX_RETRY_AFTER_MS = RETRY_DELAYS_MS.at(-1)!

/**
 * The most one judge call may spend retrying, waits and attempts together. Without a Retry-After the worst case is 105s
 * of waits plus four attempts at the default timeout, 225s.
 */
export const MAX_RETRY_TIME_MS = 300_000

/** After a call exhausts its retries, further requests skip the judge and go to the user for this long. */
export const BREAKER_COOLDOWN_MS = 60_000
