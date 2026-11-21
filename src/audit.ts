import type { Verdict } from "./verdict.ts"

/**
 * Why the plugin decided instead of your opencode config or the judge. `unparsed` means there was nothing to judge,
 * `unavailable` that the judge failed recently and was not tried, `too_long` that the request was over the size limit,
 * and the two limits that requests it had been turning back reached the point where you see the next one. Every reason
 * is an `ask` (you were prompted) except `too_long`, which turns the request back to the agent unless a limit was reached.
 */
export type Reason = "unconfigured" | "error" | "unavailable" | "too_long" | "unparsed" | "ask_limit" | "deny_limit"

export const REASONS: readonly Reason[] = ["unconfigured", "error", "unavailable", "too_long", "unparsed", "ask_limit", "deny_limit"]

/**
 * One permission evaluation the plugin saw. `effect` is what happened to the request and `by` says who set it: your
 * opencode config (`config`), the judge model (`judge`), or this plugin (`plugin`, with a `reason`).
 * A judge `ask` is turned back to the agent as a deny, so its `effect` is `deny` and `verdict` keeps what the judge said.
 */
export interface AuditEntry {
  time: number
  sessionID: string
  directory: string
  action: string
  resources: readonly string[]
  effect: Verdict
  by: "config" | "judge" | "plugin"
  /** The judge's model, when it was consulted. */
  judge?: string
  /** The host of the judge's base URL (`openrouter.ai`, `localhost:11434`), when it was consulted. */
  provider?: string
  /** Milliseconds the judge took, when it was consulted. */
  latency?: number
  reason?: Reason
  /** What the judge answered, when that differs from `effect`. */
  verdict?: Verdict
  /** The judge's one-sentence reason for not allowing, as the agent was told. */
  why?: string
  /** The failure message, for `reason: "error"` only. */
  error?: string
}

/** What the approver knows; the plugin adds where the evaluation happened. */
export type ApproverEntry = Omit<AuditEntry, "directory">
