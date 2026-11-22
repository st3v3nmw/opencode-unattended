import { REASONS, monthLabel, type AuditEntry, type Effect, type Reason } from "./audit.ts"
import { parseDuration } from "../duration.ts"

export type Outcome = Effect | Reason

export interface ActionStats {
  action: string
  seen: number
  /** Allowed by your config, so the plugin never reviewed them. */
  config: number
  /** Your config asked, so the plugin took over: the judge answered or the plugin fell back. */
  judged: number
  /** How many of them ended with you being prompted. */
  asked: number
}

export interface Stats {
  seen: number
  config: number
  judged: number
  /** Requests that ended without prompting you: allowed by your config or the judge, or denied by the judge. */
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
  let config = 0
  let judged = 0
  let handled = 0

  for (const entry of entries) {
    const row = actions.get(entry.action) ?? { action: entry.action, seen: 0, config: 0, judged: 0, asked: 0 }
    actions.set(entry.action, row)
    row.seen++
    if (entry.effect === "ask") row.asked++
    else handled++

    if (entry.by === "config") {
      config++
      row.config++
    } else {
      judged++
      row.judged++
      outcomes[entry.by === "plugin" && entry.reason && entry.effect === "ask" ? entry.reason : entry.effect]++
      if (entry.latency !== undefined) latencies.push(entry.latency)
    }
  }

  latencies.sort((a, b) => a - b)
  return {
    seen: entries.length,
    config,
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
  /** Set on the one row that folds the leftover models together, which can span providers. */
  others?: true
  stats: Stats
}

const judgeLabel = ({ model, provider }: Pick<JudgeStats, "model" | "provider">) => (provider ? `${model} @ ${provider}` : model)

/**
 * One summary per judge model and provider, most judged first. With a limit, the busiest `limit` rows are kept and the
 * rest fold into one `others` row (a single leftover keeps its name). Requests the judge never saw are left out.
 */
export function byJudge(entries: readonly AuditEntry[], limit = 0): JudgeStats[] {
  const groups = new Map<string, { model: string; provider?: string; entries: AuditEntry[] }>()
  for (const entry of entries) {
    if (entry.judge === undefined) continue
    const key = `${entry.judge}\n${entry.provider ?? ""}`
    const group = groups.get(key) ?? { model: entry.judge, provider: entry.provider, entries: [] }
    group.entries.push(entry)
    groups.set(key, group)
  }
  const rows = [...groups.values()]
    .map(({ model, provider, entries }) => ({ model, ...(provider ? { provider } : {}), entries, stats: summarize(entries) }))
    .sort((a, b) => b.stats.judged - a.stats.judged || judgeLabel(a).localeCompare(judgeLabel(b)))
  const plain = ({ entries, ...row }: (typeof rows)[number]): JudgeStats => row

  if (limit <= 0 || rows.length <= limit + 1) return rows.map(plain)
  const rest = rows.slice(limit)
  return [
    ...rows.slice(0, limit).map(plain),
    { model: `others (${rest.length})`, others: true, stats: summarize(rest.flatMap((row) => row.entries)) },
  ]
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

/** `30d`, `4w` and `12h` mean that long before `now`; anything else must be a date such as `2026-11-01`. */
export function parseWhen(text: string, now: number): number {
  const ago = parseDuration(text)
  if (ago !== undefined) return now - ago
  const time = Date.parse(text)
  if (Number.isNaN(time)) throw new Error(`cannot read "${text}": use 30d, 4w, 12h or a date like 2026-11-01`)
  return time
}

const rate = (part: number, whole: number) => (whole ? `${((part / whole) * 100).toFixed(1)}%` : "-")
/** A percentage with the count behind it, like `4.8% (23)`. */
const share = (part: number, whole: number) => (whole ? `${rate(part, whole)} (${part})` : "-")
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`
const cell = (value: string | number, width: number) => String(value).padStart(width)
/** `text` centered in `width` columns, for a label over several columns. */
const span = (text: string, width: number) => text.padStart(Math.floor((width + text.length) / 2)).padEnd(width)

const fallbacks = (outcomes: Stats["outcomes"]) => REASONS.reduce((sum, reason) => sum + outcomes[reason], 0)

/** Judged requests that ended with you being asked: the judge said ask, or the plugin fell back. */
export const returned = (outcomes: Stats["outcomes"]) => outcomes.ask + fallbacks(outcomes)

const sumActions = (action: string, rows: readonly ActionStats[]): ActionStats =>
  rows.reduce(
    (sum, row) => ({ ...sum, seen: sum.seen + row.seen, config: sum.config + row.config, judged: sum.judged + row.judged, asked: sum.asked + row.asked }),
    { action, seen: 0, config: 0, judged: 0, asked: 0 },
  )

/**
 * The busiest `limit` actions, the rest folded into one `others` row (a single leftover keeps its name), then a total.
 * A limit of 0 shows every action. Only the total shows counts next to its percentages.
 */
export function formatActions(rows: readonly ActionStats[], limit = 8): string {
  const fold = limit > 0 && rows.length > limit + 1
  const shown = fold ? [...rows.slice(0, limit), sumActions(`others (${rows.length - limit})`, rows.slice(limit))] : [...rows]
  if (rows.length > 1) shown.push(sumActions("TOTAL", rows))

  const name = Math.max(6, ...shown.map((a) => a.action.length))
  const headers = ["REQUESTS", "CONFIG", "JUDGED", "PROMPTED"]
  const measure = rows.length > 1 ? (i: number) => (i === shown.length - 1 ? share : rate) : () => rate
  const body = shown.map((a, i) => {
    const show = measure(i)
    return [String(a.seen), show(a.config, a.seen), show(a.judged, a.seen), show(a.asked, a.seen)]
  })
  const widths = headers.map((h, i) => Math.max(h.length, ...body.map((cells) => cells[i]!.length)) + 4)
  const row = (label: string, cells: string[]) => label.padEnd(name + 2) + cells.map((c, i) => c.padStart(widths[i]!)).join("")
  const groups = " ".repeat(name + 2 + widths[0]!) + span("% of requests", widths[1]! + widths[2]! + widths[3]!)
  return [groups.trimEnd(), row("ACTION", headers), ...shown.map((a, i) => row(a.action, body[i]!))].join("\n")
}

const monthName = (month: string) => {
  const [year, number] = month.split("-").map(Number)
  return new Date(Date.UTC(year!, number! - 1, 1)).toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" })
}

const latencyCells = (latency: Stats["latency"]) => [cell(latency ? seconds(latency.p50) : "-", 7), cell(latency ? seconds(latency.p95) : "-", 7)]

const MONTH_COLUMNS = [9, 8, 8, 7, 8, 7, 9, 7, 7]

/**
 * One row per month under a row that says which columns are shares of requests and which of judged, plus a `total` row over
 * the whole window when there is more than one month. `Prompted` is everything that ended in a prompt to you. The shares of
 * requests show their count in parentheses.
 */
export function formatMonthly(rows: readonly MonthStats[], total?: Stats): string {
  const lines: [string, Stats][] = rows.map(({ month, stats }) => [monthName(month), stats])
  if (total && rows.length > 1) lines.push(["TOTAL", total])

  const promptedShare = (stats: Stats) => share(stats.seen - stats.handled, stats.seen)
  const judgedShare = (stats: Stats) => share(stats.judged, stats.seen)
  const [label, seen, , , allowed, denied, prompted, p50, p95] = MONTH_COLUMNS as [number, number, number, number, number, number, number, number, number]
  const asked = Math.max(8, ...lines.map(([, stats]) => promptedShare(stats).length)) + 3
  const judged = Math.max(7, ...lines.map(([, stats]) => judgedShare(stats).length)) + 3

  const lead = (width: number, header: string) => width - header.length
  const first = lead(asked, "PROMPTED")
  const second = lead(allowed, "ALLOWED")
  const groups =
    " ".repeat(label + seen + 2 + first) +
    span("% of requests", asked + 1 + judged - first) +
    " " +
    " ".repeat(second) +
    span("% of judged", allowed + denied + prompted + 2 - second)
  const header = [
    "MONTH".padEnd(label),
    cell("REQUESTS", seen),
    cell("PROMPTED", asked),
    cell("JUDGED", judged),
    cell("ALLOWED", allowed),
    cell("DENIED", denied),
    cell("PROMPTED", prompted),
    cell("P50", p50),
    cell("P95", p95),
  ]
  const line = (name: string, stats: Stats) => {
    const { outcomes: o, judged: n, latency } = stats
    return [
      name.padEnd(label),
      cell(stats.seen, seen),
      cell(promptedShare(stats), asked),
      cell(judgedShare(stats), judged),
      cell(rate(o.allow, n), allowed),
      cell(rate(o.deny, n), denied),
      cell(rate(returned(o), n), prompted),
      ...latencyCells(latency),
    ].join(" ")
  }
  return [groups.trimEnd(), header.join(" "), ...lines.map(([name, stats]) => line(name, stats))].join("\n")
}

/**
 * Models grouped under their provider, busiest provider first, then the `others` row if models were folded, and a
 * `total` row when there is more than one row.
 * Counts are of judged requests, as percentages. `Prompted` is everything that ended in a prompt to you, including
 * denies the plugin escalated; `Failed` is the calls that errored, and is part of `Prompted`.
 */
export function formatJudges(rows: readonly JudgeStats[], total?: Stats): string {
  const title = "MODEL"
  const indent = "  "
  const folded = rows.find((row) => row.others)
  const byProvider = new Map<string, JudgeStats[]>()
  for (const row of rows.filter((row) => !row.others)) byProvider.set(row.provider ?? "", [...(byProvider.get(row.provider ?? "") ?? []), row])

  const groups = [...byProvider.entries()]
    .map(([provider, models]) => ({
      heading: provider || "UNKNOWN",
      unknown: !provider,
      total: models.reduce((sum, row) => sum + row.stats.judged, 0),
      models: [...models].sort((a, b) => b.stats.judged - a.stats.judged || a.model.localeCompare(b.model)),
    }))
    .sort((a, b) => Number(a.unknown) - Number(b.unknown) || b.total - a.total || a.heading.localeCompare(b.heading))

  const width = Math.max(title.length, ...groups.flatMap((group) => group.models.map((row) => indent.length + row.model.length)), folded?.model.length ?? 0)
  const header = [title.padEnd(width), cell("JUDGED", 7), cell("ALLOWED", 8), cell("DENIED", 7), cell("PROMPTED", 9), cell("FAILED", 7), cell("P50", 7), cell("P95", 7)]
  const line = (label: string, { outcomes: o, judged, latency }: Stats) =>
    [
      label.padEnd(width),
      cell(judged, 7),
      cell(rate(o.allow, judged), 8),
      cell(rate(o.deny, judged), 7),
      cell(rate(returned(o), judged), 9),
      cell(rate(o.error, judged), 7),
      ...latencyCells(latency),
    ].join(" ")

  const label = (" ".repeat(width + 1 + 7 + 1) + span("% of judged", 8 + 1 + 7 + 1 + 9 + 1 + 7)).trimEnd()
  const lines = [label, header.join(" ")]
  for (const group of groups) {
    lines.push(group.heading)
    for (const row of group.models) lines.push(line(indent + row.model, row.stats))
  }
  if (folded) lines.push(line(folded.model, folded.stats))
  if (total && rows.length > 1) lines.push(line("TOTAL", total))
  return lines.join("\n")
}
