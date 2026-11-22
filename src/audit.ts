import type { Effect } from "./rules.ts"

/**
 * Why the plugin decided instead of your opencode config or the judge. `unparsed` means there was nothing to judge,
 * `unavailable` that the judge failed recently and was not tried, `too_long` that the request was over the size limit,
 * and `deny_limit` that the agent had been turned back enough times in a row that you see the next request. Every
 * reason is an `ask` (you were prompted) except `too_long`, which turns the request back to the agent unless the limit
 * was reached. `ask_limit` comes from earlier versions, which counted turn-backs and judge denies apart.
 */
export type Reason = "unconfigured" | "error" | "unavailable" | "too_long" | "unparsed" | "ask_limit" | "deny_limit"

export const REASONS: readonly Reason[] = ["unconfigured", "error", "unavailable", "too_long", "unparsed", "ask_limit", "deny_limit"]

/**
 * One permission evaluation the plugin saw. `effect` is what happened to the request and `by` says who set it: your
 * opencode config (`config`), the judge model (`judge`), or this plugin (`plugin`, with a `reason`).
 */
export interface AuditEntry {
  time: number
  sessionID: string
  directory: string
  action: string
  resources: readonly string[]
  effect: Effect
  by: "config" | "judge" | "plugin"
  /** The judge's model, when it was consulted. */
  judge?: string
  /** The host of the judge's base URL (`openrouter.ai`, `localhost:11434`), when it was consulted. */
  provider?: string
  /** Milliseconds the judge took, when it was consulted. */
  latency?: number
  reason?: Reason
  /** The judge's one-sentence reason. For a deny it is what the agent was told. */
  why?: string
  /** The failure message, for `reason: "error"` only. */
  error?: string
}

/** What the approver knows; the plugin adds where the evaluation happened. */
export type ApproverEntry = Omit<AuditEntry, "directory">
