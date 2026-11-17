import type { AuditEntry, JudgedEntry } from "./audit.ts"

export interface Stats {
  shell: number
  configAllowed: number
  judged: number
  outcomes: Record<JudgedEntry["outcome"], number>
  autoApproved: number
  latencyMs: { p50: number; p95: number } | null
  otherEvaluations: number
}

const OUTCOMES: JudgedEntry["outcome"][] = ["allow", "ask", "deny", "error", "too_long", "deny_streak"]

const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!

export function summarize(entries: readonly AuditEntry[]): Stats {
  const outcomes = Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Stats["outcomes"]
  const latencies: number[] = []
  let configAllowed = 0
  let judged = 0
  let otherEvaluations = 0

  for (const entry of entries) {
    if (entry.kind === "judged") {
      judged++
      outcomes[entry.outcome]++
      if (entry.latencyMs !== undefined) latencies.push(entry.latencyMs)
    } else if (entry.action === "shell") {
      configAllowed++
    } else {
      otherEvaluations++
    }
  }

  latencies.sort((a, b) => a - b)
  return {
    shell: configAllowed + judged,
    configAllowed,
    judged,
    outcomes,
    autoApproved: configAllowed + outcomes.allow,
    latencyMs: latencies.length ? { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) } : null,
    otherEvaluations,
  }
}

const pct = (part: number, whole: number) => (whole ? `${((part / whole) * 100).toFixed(1)}%` : "n/a")

export function format(stats: Stats): string {
  const { shell, configAllowed, judged, outcomes, autoApproved, latencyMs } = stats
  const lines = [
    `shell evaluations (not hard-denied by config): ${shell}`,
    `  auto-approved, total:      ${autoApproved} (${pct(autoApproved, shell)})`,
    `    by your config rules:    ${configAllowed} (${pct(configAllowed, shell)})`,
    `    by the judge:            ${outcomes.allow} (${pct(outcomes.allow, shell)})`,
    `  sent to the judge:         ${judged} (${pct(judged, shell)})`,
    `    allow:                   ${outcomes.allow} (${pct(outcomes.allow, judged)} of judged)`,
    `    ask:                     ${outcomes.ask} (${pct(outcomes.ask, judged)})`,
    `    deny:                    ${outcomes.deny} (${pct(outcomes.deny, judged)})`,
    `    deny streak -> ask:      ${outcomes.deny_streak} (${pct(outcomes.deny_streak, judged)})`,
    `    too long -> ask:         ${outcomes.too_long} (${pct(outcomes.too_long, judged)})`,
    `    judge error -> ask:      ${outcomes.error} (${pct(outcomes.error, judged)})`,
  ]
  if (latencyMs) lines.push(`  judge latency: p50 ${latencyMs.p50}ms, p95 ${latencyMs.p95}ms`)
  lines.push(`other evaluations seen: ${stats.otherEvaluations}`)
  return lines.join("\n")
}
