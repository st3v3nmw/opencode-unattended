import { describe, expect, test } from "bun:test"
import type { AuditEntry, JudgedEntry } from "../src/audit.ts"
import { format, summarize } from "../src/stats.ts"

const judged = (outcome: JudgedEntry["outcome"], latencyMs?: number): AuditEntry => ({
  kind: "judged",
  time: 0,
  judge: "j",
  sessionID: "s",
  command: "c",
  commands: ["c"],
  outcome,
  decision: outcome === "allow" ? "allow" : outcome === "deny" ? "deny" : "ask",
  latencyMs,
})

const passthrough = (action: string, configEffect: "allow" | "ask" = "allow"): AuditEntry => ({
  kind: "passthrough",
  time: 0,
  sessionID: "s",
  action,
  configEffect,
})

describe("stats", () => {
  const entries = [
    passthrough("shell"),
    passthrough("shell"),
    passthrough("edit"),
    passthrough("read"),
    judged("allow", 100),
    judged("allow", 300),
    judged("ask", 200),
    judged("deny", 400),
    judged("too_long"),
    judged("deny_streak", 500),
    judged("error", 900),
  ]
  const stats = summarize(entries)

  test("counts shell evaluations and auto-approvals", () => {
    expect(stats.shell).toBe(9)
    expect(stats.configAllowed).toBe(2)
    expect(stats.judged).toBe(7)
    expect(stats.autoApproved).toBe(4)
    expect(stats.otherEvaluations).toBe(2)
  })

  test("splits the judged outcomes", () => {
    expect(stats.outcomes).toEqual({ allow: 2, ask: 1, deny: 1, error: 1, too_long: 1, deny_streak: 1 })
  })

  test("computes latency percentiles over entries that have one", () => {
    expect(stats.latencyMs).toEqual({ p50: 400, p95: 900 })
  })

  test("formats percentages and tolerates an empty log", () => {
    expect(format(stats)).toContain("auto-approved, total:      4 (44.4%)")
    expect(format(summarize([]))).toContain("n/a")
    expect(summarize([]).latencyMs).toBeNull()
  })
})
