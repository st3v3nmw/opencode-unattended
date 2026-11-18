import type { Verdict } from "./verdict.ts"

/** Why the plugin decided instead of opencode's rules or the judge. `unparsed` means there was nothing to judge. */
export type Reason = "unconfigured" | "error" | "too_long" | "deny_streak" | "unparsed"

export const REASONS: readonly Reason[] = ["unconfigured", "error", "too_long", "deny_streak", "unparsed"]

/**
 * One permission evaluation the plugin saw. `by` says who set `effect`: opencode's own rules (`config`), the judge
 * model (`judge`), or this plugin (`plugin`, always an `ask` with a `reason`).
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
  /** The failure message, for `reason: "error"` only. */
  error?: string
}

/** What the approver knows; the plugin adds where the evaluation happened. */
export type ApproverEntry = Omit<AuditEntry, "directory">
