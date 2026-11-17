import type { Verdict } from "./verdict.ts"

export type Outcome = Verdict | "error" | "too_long" | "deny_streak"

/** A shell chain that was sent to (or short-circuited before) the judge. */
export interface JudgedEntry {
  kind: "judged"
  time: number
  judge: string
  sessionID: string
  command: string
  commands: readonly string[]
  outcome: Outcome
  /** The effect actually applied after guards. */
  decision: Verdict
  latencyMs?: number
  error?: string
}

/** An evaluation the plugin saw but did not judge. It supplies the denominator for stats. */
export interface PassthroughEntry {
  kind: "passthrough"
  time: number
  sessionID: string
  action: string
  configEffect: "allow" | "ask"
}

export type AuditEntry = (JudgedEntry | PassthroughEntry) & { directory?: string; project?: string }
