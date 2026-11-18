import type { AuditEntry, Reason } from "./audit.ts"
import { REASONS } from "./audit.ts"
import { monthLabel } from "./auditlog.ts"
import type { Verdict } from "./verdict.ts"

export type Outcome = Verdict | Reason

export interface ActionStats {
  action: string
  seen: number
  /** Allowed by your config rules, so the plugin never reviewed them. */
  rules: number
  /** Your rules asked, so the plugin took over: the judge answered or the plugin fell back. */
  judged: number
  /** How many of them ended with you being prompted. */
  asked: number
}

export interface Stats {
  seen: number
  rules: number
  judged: number
  /** Requests that ended without prompting you: allowed by a rule or the judge, or denied by the judge. */
  handled: number
  /** Over judged requests: the judge's verdicts, or the plugin's reason for asking you instead. */
  outcomes: Record<Outcome, number>
  latency: { p50: number; p95: number } | null
  byAction: ActionStats[]
}

const OUTCOMES: Outcome[] = ["allow", "ask", "deny", ...REASONS]

const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!

export function summarize(entries: readonly AuditEntry[]): Stats {
  const outcomes = Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Stats["outcomes"]
  const actions = new Map<string, ActionStats>()
  const latencies: number[] = []
  let rules = 0
  let judged = 0
  let handled = 0

  for (const entry of entries) {
    const row = actions.get(entry.action) ?? { action: entry.action, seen: 0, rules: 0, judged: 0, asked: 0 }
    actions.set(entry.action, row)
    row.seen++
    if (entry.effect === "ask") row.asked++
    else handled++

    if (entry.by === "config") {
      rules++
      row.rules++
    } else {
      judged++
      row.judged++
      outcomes[entry.by === "plugin" && entry.reason ? entry.reason : entry.effect]++
      if (entry.latency !== undefined) latencies.push(entry.latency)
    }
  }

  latencies.sort((a, b) => a - b)
  return {
    seen: entries.length,
    rules,
    judged,
    handled,
    outcomes,
    latency: latencies.length ? { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) } : null,
    byAction: [...actions.values()].sort((a, b) => b.seen - a.seen || a.action.localeCompare(b.action)),
  }
}

export interface MonthStats {
  month: string
  stats: Stats
}

/** One summary per calendar month (UTC) of the entries' own times, oldest first. */
export function monthly(entries: readonly AuditEntry[]): MonthStats[] {
  const groups = new Map<string, AuditEntry[]>()
  for (const entry of entries) {
    const month = monthLabel(entry.time)
    groups.set(month, [...(groups.get(month) ?? []), entry])
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, group]) => ({ month, stats: summarize(group) }))
}

export interface JudgeStats {
  model: string
  provider?: string
  stats: Stats
}

const judgeLabel = ({ model, provider }: Pick<JudgeStats, "model" | "provider">) => (provider ? `${model} @ ${provider}` : model)

/** One summary per judge model and provider, most judged first. Requests the judge never saw are left out. */
export function byJudge(entries: readonly AuditEntry[]): JudgeStats[] {
  const groups = new Map<string, { model: string; provider?: string; entries: AuditEntry[] }>()
  for (const entry of entries) {
    if (entry.judge === undefined) continue
    const key = `${entry.judge}\n${entry.provider ?? ""}`
    const group = groups.get(key) ?? { model: entry.judge, provider: entry.provider, entries: [] }
    group.entries.push(entry)
    groups.set(key, group)
  }
  return [...groups.values()]
    .map(({ model, provider, entries }) => ({ model, ...(provider ? { provider } : {}), stats: summarize(entries) }))
    .sort((a, b) => b.stats.judged - a.stats.judged || judgeLabel(a).localeCompare(judgeLabel(b)))
}

export interface Ranked {
  label: string
  count: number
}

/** The most frequent commands (or error messages) that ended in an ask or a deny, or that failed. */
export function top(entries: readonly AuditEntry[], kind: "ask" | "deny" | "error", limit = 10): Ranked[] {
  const counts = new Map<string, number>()
  const add = (label: string) => counts.set(label, (counts.get(label) ?? 0) + 1)
  const resource = (e: AuditEntry) => (e.action === "shell" ? "" : `${e.action} `) + e.resources.join(" ; ")

  for (const entry of entries) {
    if (kind === "error") {
      if (entry.reason === "error") add(entry.error ?? "unknown error")
      else if (entry.reason === "unconfigured") add("judge not configured")
    } else if (entry.effect === kind) {
      add(resource(entry))
    }
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, limit)
}

const UNITS: Record<string, number> = { h: 3_600_000, d: 86_400_000, w: 604_800_000 }

/** `30d`, `4w` and `12h` mean that long before `now`; anything else must be a date such as `2026-11-01`. */
export function parseWhen(text: string, now: number): number {
  const relative = /^(\d+)([hdw])$/.exec(text)
  if (relative) return now - Number(relative[1]) * UNITS[relative[2]!]!
  const time = Date.parse(text)
  if (Number.isNaN(time)) throw new Error(`cannot read "${text}": use 30d, 4w, 12h or a date like 2026-11-01`)
  return time
}

const pct = (part: number, whole: number) => (whole ? `${((part / whole) * 100).toFixed(1)}%` : "n/a")
const rate = (part: number, whole: number) => (whole ? pct(part, whole) : "-")
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`
const cell = (value: string | number, width: number) => String(value).padStart(width)

const FALLBACKS: [Reason, string][] = [
  ["error", "judge call failed"],
  ["unconfigured", "judge not configured"],
  ["too_long", "too long to review"],
  ["deny_streak", "denies in a row, escalated to you"],
  ["unparsed", "nothing to judge"],
]

const fallbacks = (outcomes: Stats["outcomes"]) => FALLBACKS.reduce((sum, [reason]) => sum + outcomes[reason], 0)

export function format(stats: Stats): string {
  const { seen, rules, judged, handled, outcomes, byAction } = stats
  if (seen === 0) return "no permission requests"

  const width = String(seen).length
  const count = (n: number) => String(n).padStart(width)
  const row = (indent: number, n: number, label: string, whole?: number) => {
    const text = `${" ".repeat(indent)}${count(n)} ${label}`
    return whole === undefined ? text : `${text.padEnd(44)}${pct(n, whole)}`
  }

  const left = fallbacks(outcomes)
  const share = (text: string, part: number, whole: number) => `${text}  `.padEnd(44) + pct(part, whole)
  const lines = [
    `${seen} permission request${seen === 1 ? "" : "s"} seen`,
    row(2, rules, "allowed by your rules", seen),
    row(2, judged, "sent to the judge", seen),
    `${" ".repeat(4 + width)} ${outcomes.allow} allowed, ${outcomes.ask} asked you, ${outcomes.deny} denied`,
    row(2, left, "left for you by the plugin"),
    ...FALLBACKS.filter(([reason]) => outcomes[reason] > 0).map(
      ([reason, label]) => `${" ".repeat(4 + width)} ${outcomes[reason]} ${label}`,
    ),
    "",
    share(`${handled} of ${seen} handled without prompting you`, handled, seen),
  ]
  if (judged > 0) {
    const returned = outcomes.ask + left
    lines.push(share(`${returned} of ${judged} judged requests came back to you`, returned, judged))
  }

  const name = Math.max(6, ...byAction.map((a) => a.action.length))
  lines.push(
    "",
    "ACTION".padEnd(name + 2) + ["SEEN", "RULES", "JUDGED", "YOU"].map((h) => h.padStart(10)).join(""),
    ...byAction.map(
      (a) =>
        a.action.padEnd(name + 2) +
        [a.seen, rate(a.rules, a.seen), rate(a.judged, a.seen), rate(a.asked, a.seen)].map((n) => String(n).padStart(10)).join(""),
    ),
  )
  return lines.join("\n")
}

const monthName = (month: string) => {
  const [year, number] = month.split("-").map(Number)
  return new Date(Date.UTC(year!, number! - 1, 1)).toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" })
}

export function formatMonthly(rows: readonly MonthStats[]): string {
  const header = ["MONTH".padEnd(9), cell("SEEN", 6), cell("HANDLED", 8), cell("JUDGED", 7), cell("ALLOW", 7), cell("ASK", 6), cell("DENY", 6), cell("FALLBACK", 9), cell("P50", 7), cell("P95", 7)]
  const lines = [header.join(" ")]
  for (const { month, stats } of rows) {
    const { outcomes: o, judged, seen, handled, latency } = stats
    lines.push(
      [
        monthName(month).padEnd(9),
        cell(seen, 6),
        cell(rate(handled, seen), 8),
        cell(rate(judged, seen), 7),
        cell(rate(o.allow, judged), 7),
        cell(rate(o.ask, judged), 6),
        cell(rate(o.deny, judged), 6),
        cell(rate(fallbacks(o), judged), 9),
        cell(latency ? seconds(latency.p50) : "-", 7),
        cell(latency ? seconds(latency.p95) : "-", 7),
      ].join(" "),
    )
  }
  return lines.join("\n")
}

/**
 * Models grouped under their provider, busiest provider first. Counts are of judged requests, as percentages. `Deny` is
 * what the model said, so it includes denies the plugin escalated to you; `Failed` is calls that errored.
 */
export function formatJudges(rows: readonly JudgeStats[]): string {
  const title = "MODEL"
  const indent = "  "
  const byProvider = new Map<string, JudgeStats[]>()
  for (const row of rows) byProvider.set(row.provider ?? "", [...(byProvider.get(row.provider ?? "") ?? []), row])

  const groups = [...byProvider.entries()]
    .map(([provider, models]) => ({
      heading: provider || "UNKNOWN",
      unknown: !provider,
      total: models.reduce((sum, row) => sum + row.stats.judged, 0),
      models: [...models].sort((a, b) => b.stats.judged - a.stats.judged || a.model.localeCompare(b.model)),
    }))
    .sort((a, b) => Number(a.unknown) - Number(b.unknown) || b.total - a.total || a.heading.localeCompare(b.heading))

  const width = Math.max(title.length, ...groups.flatMap((group) => group.models.map((row) => indent.length + row.model.length)))
  const header = [title.padEnd(width), cell("JUDGED", 7), cell("ALLOW", 7), cell("ASK", 6), cell("DENY", 6), cell("FAILED", 7), cell("P50", 7), cell("P95", 7)]
  const lines = [header.join(" ")]
  for (const group of groups) {
    lines.push(group.heading)
    for (const row of group.models) {
      const { outcomes: o, judged, latency } = row.stats
      lines.push(
        [
          (indent + row.model).padEnd(width),
          cell(judged, 7),
          cell(rate(o.allow, judged), 7),
          cell(rate(o.ask, judged), 6),
          cell(rate(o.deny + o.deny_streak, judged), 6),
          cell(rate(o.error, judged), 7),
          cell(latency ? seconds(latency.p50) : "-", 7),
          cell(latency ? seconds(latency.p95) : "-", 7),
        ].join(" "),
      )
    }
  }
  return lines.join("\n")
}
