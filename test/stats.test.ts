import { describe, expect, test } from "bun:test"
import type { AuditEntry } from "../src/audit.ts"
import { byJudge, format, formatJudges, formatMonthly, monthly, parseWhen, summarize, top } from "../src/stats.ts"

const at = (iso: string) => Date.parse(iso)

const entry = (over: Partial<AuditEntry>): AuditEntry => ({
  time: at("2026-11-17T07:00:00Z"),
  sessionID: "s",
  directory: "~/app",
  action: "shell",
  resources: ["c"],
  effect: "allow",
  by: "config",
  ...over,
})

const config = (action = "shell", effect: "allow" | "ask" = "allow", over: Partial<AuditEntry> = {}) =>
  entry({ action, effect, by: "config", ...over })
const judged = (effect: "allow" | "ask" | "deny", latency: number, over: Partial<AuditEntry> = {}) =>
  entry({ effect, by: "judge", judge: "m", latency, ...over })
const plugin = (reason: NonNullable<AuditEntry["reason"]>, over: Partial<AuditEntry> = {}) =>
  entry({ effect: "ask", by: "plugin", reason, ...over })

describe("stats", () => {
  const entries = [
    config(),
    config(),
    config("edit"),
    config("read"),
    judged("allow", 100),
    judged("allow", 300),
    judged("ask", 200),
    judged("deny", 400),
    plugin("too_long"),
    plugin("deny_streak", { judge: "m", latency: 500 }),
    plugin("error", { judge: "m", latency: 900, error: "HTTP 500" }),
    plugin("unconfigured"),
    plugin("unparsed"),
  ]
  const stats = summarize(entries)

  test("counts requests of every action, those your rules allowed, and those handled without prompting you", () => {
    expect(stats.seen).toBe(13)
    expect(stats.rules).toBe(4)
    expect(stats.judged).toBe(9)
    expect(stats.handled).toBe(7)
  })

  test("breaks requests down by action, most frequent first", () => {
    expect(stats.byAction).toEqual([
      { action: "shell", seen: 11, rules: 2, judged: 9, asked: 6 },
      { action: "edit", seen: 1, rules: 1, judged: 0, asked: 0 },
      { action: "read", seen: 1, rules: 1, judged: 0, asked: 0 },
    ])
  })

  test("a judged request of any action counts as judged under its own action", () => {
    const mixed = summarize([judged("allow", 10, { action: "webfetch" }), judged("ask", 20, { action: "webfetch" }), config("edit")])
    expect(mixed.judged).toBe(2)
    expect(mixed.byAction).toEqual([
      { action: "webfetch", seen: 2, rules: 0, judged: 2, asked: 1 },
      { action: "edit", seen: 1, rules: 1, judged: 0, asked: 0 },
    ])
  })

  test("splits the judge's answers from the plugin's reasons", () => {
    expect(stats.outcomes).toEqual({
      allow: 2,
      ask: 1,
      deny: 1,
      too_long: 1,
      deny_streak: 1,
      error: 1,
      unconfigured: 1,
      unparsed: 1,
    })
  })

  test("computes latency percentiles over entries that have one", () => {
    expect(stats.latency).toEqual({ p50: 400, p95: 900 })
  })

  test("a log with nothing in it reads as empty", () => {
    expect(format(summarize([]))).toBe("no permission requests")
    expect(summarize([]).latency).toBeNull()
  })

  test("the text says what each number is and shows only the fallback reasons that happened", () => {
    const text = format(stats)
    expect(text).toContain("13 permission requests seen")
    expect(text).toContain("allowed by your rules")
    expect(text).toContain("sent to the judge")
    expect(text).toContain("2 allowed, 1 asked you, 1 denied")
    expect(text).toContain("left for you by the plugin")
    expect(text).toContain("judge call failed")
    expect(text).toContain("7 of 13 handled without prompting you")
    expect(text).toContain("53.8%")
    expect(text).toContain("6 of 9 judged requests came back to you")
    expect(text).toContain("66.7%")
  })

  test("the action table keeps Seen as a count and shows the rest as percentages of that action's requests", () => {
    const lines = format(stats).split("\n")
    const at = lines.findIndex((line) => line.startsWith("ACTION"))
    expect(lines[at + 1]).toMatch(/^shell\s+11\s+18\.2%\s+81\.8%\s+54\.5%$/)
    expect(lines[at + 2]).toMatch(/^edit\s+1\s+100\.0%\s+0\.0%\s+0\.0%$/)
    expect(lines[at + 3]).toMatch(/^read\s+1\s+100\.0%\s+0\.0%\s+0\.0%$/)
  })

  test("a reason that did not happen is not listed", () => {
    const text = format(summarize([config(), judged("allow", 5)]))
    for (const label of ["judge call failed", "judge not configured", "too long to review", "escalated to you", "nothing to judge"]) {
      expect(text).not.toContain(label)
    }
    expect(text).toContain("0 left for you by the plugin")
  })

  test("the share of judged requests that came back to you is left out when nothing was judged", () => {
    expect(format(summarize([config(), config("edit")]))).not.toContain("judged requests")
  })

  test("a judge's deny does not count as coming back to you", () => {
    const text = format(summarize([judged("deny", 5), judged("allow", 5)]))
    expect(text).toContain("0 of 2 judged requests came back to you")
    expect(text).toContain("0.0%")
  })

  test("a percentage never runs into its label, however long the numbers", () => {
    const many = Array.from({ length: 12345 }, () => judged("ask", 1))
    expect(format(summarize(many))).toMatch(/came back to you {2,}100\.0%/)
  })
})

describe("monthly", () => {
  const entries = [
    plugin("error", { time: at("2026-12-01T00:00:00Z"), judge: "m", latency: 5 }),
    config("shell", "allow", { time: at("2026-10-31T23:59:59Z") }),
    judged("allow", 100, { time: at("2026-10-05T09:00:00Z") }),
    judged("allow", 300, { time: at("2026-11-17T09:00:00Z") }),
    plugin("error", { time: at("2026-11-30T23:59:59Z"), judge: "m", latency: 5 }),
  ]

  test("buckets by the entry's own time into calendar months, oldest first", () => {
    const rows = monthly(entries)
    expect(rows.map((r) => [r.month, r.stats.seen])).toEqual([
      ["2026-10", 2],
      ["2026-11", 2],
      ["2026-12", 1],
    ])
  })

  test("renders one line per month, labeled like Nov 2026", () => {
    const text = formatMonthly(monthly(entries))
    const lines = text.split("\n")
    expect(lines.length).toBe(4)
    expect(lines.slice(1).map((line) => line.slice(0, 8))).toEqual(["Oct 2026", "Nov 2026", "Dec 2026"])
  })

  test("Seen is a count; the rest are percentages, with outcomes taken over judged requests", () => {
    const lines = formatMonthly(monthly(entries)).split("\n")
    expect(lines[1]).toMatch(/^Oct 2026\s+2\s+100\.0%\s+50\.0%\s+100\.0%\s+0\.0%\s+0\.0%\s+0\.0%\s/)
    expect(lines[2]).toMatch(/^Nov 2026\s+2\s+50\.0%\s+100\.0%\s+50\.0%\s+0\.0%\s+0\.0%\s+50\.0%\s/)
    expect(lines[3]).toMatch(/^Dec 2026\s+1\s+0\.0%\s+100\.0%\s+0\.0%\s+0\.0%\s+0\.0%\s+100\.0%\s/)
  })

  test("a month where nothing was judged shows a dash where a percentage of judged would be", () => {
    const [, line] = formatMonthly(monthly([config()])).split("\n")
    expect(line).toMatch(/^Nov 2026\s+1\s+100\.0%\s+0\.0%\s+-\s+-\s+-\s+-\s+-\s+-$/)
  })
})

describe("byJudge", () => {
  const a = { judge: "a", provider: "x.example" }
  const entries = [
    judged("allow", 100, a),
    judged("allow", 300, a),
    judged("ask", 200, a),
    plugin("error", { ...a, latency: 900, error: "HTTP 500" }),
    plugin("deny_streak", { ...a, latency: 500 }),
    judged("deny", 400, { judge: "b", provider: "localhost:11434" }),
    judged("allow", 50, { judge: "a" }),
    config(),
    plugin("too_long"),
    plugin("unparsed"),
    plugin("unconfigured"),
  ]

  test("groups by model and provider, most judged first, ties alphabetical", () => {
    expect(byJudge(entries).map((r) => [r.model, r.provider, r.stats.judged])).toEqual([
      ["a", "x.example", 5],
      ["a", undefined, 1],
      ["b", "localhost:11434", 1],
    ])
  })

  test("leaves out requests the judge never saw", () => {
    expect(byJudge([config(), plugin("too_long"), plugin("unparsed"), plugin("unconfigured")])).toEqual([])
  })

  test("Allow, Ask, Deny and Failed add up to Judged on every row", () => {
    for (const { stats } of byJudge(entries)) {
      const o = stats.outcomes
      expect(o.allow + o.ask + o.deny + o.deny_streak + o.error).toBe(stats.judged)
    }
  })

  test("groups models under their provider heading, with escalated denies under Deny and errors under Failed", () => {
    const lines = formatJudges(byJudge(entries)).split("\n")
    expect(lines.length).toBe(7)
    expect(lines[0]).toMatch(/^MODEL\s+JUDGED\s+ALLOW\s+ASK\s+DENY\s+FAILED\s+P50\s+P95$/)
    expect(lines[1]).toBe("x.example")
    expect(lines[2]).toMatch(/^ {2}a\s+5\s+40\.0%\s+20\.0%\s+20\.0%\s+20\.0%\s+0\.3s\s+0\.9s$/)
    expect(lines[3]).toBe("localhost:11434")
    expect(lines[4]).toMatch(/^ {2}b\s+1\s+0\.0%\s+0\.0%\s+100\.0%\s+0\.0%\s+0\.4s\s+0\.4s$/)
    expect(lines[5]).toBe("UNKNOWN")
    expect(lines[6]).toMatch(/^ {2}a\s+1\s+100\.0%\s+0\.0%\s+0\.0%\s+0\.0%\s+0\.1s\s+0\.1s$/)
  })

  describe("ordering", () => {
    const group = (provider: string | undefined, model: string, count: number) =>
      Array.from({ length: count }, () => judged("allow", 100, { judge: model, ...(provider ? { provider } : {}) }))
    const many = [
      ...group("slow.example", "zeta", 3),
      ...group("slow.example", "alpha", 3),
      ...group("slow.example", "beta", 1),
      ...group("big.example", "solo", 4),
      ...group("", "legacy", 9),
    ]
    const labels = (text: string) => text.split("\n").map((line) => line.trim().split(/\s+/)[0])

    test("providers by total judged, then models by their own volume, ties alphabetical, unknown last", () => {
      expect(labels(formatJudges(byJudge(many)))).toEqual([
        "MODEL",
        "slow.example",
        "alpha",
        "zeta",
        "beta",
        "big.example",
        "solo",
        "UNKNOWN",
        "legacy",
      ])
    })

    test("the result does not depend on the order the rows arrive in", () => {
      const rows = byJudge(many)
      expect(formatJudges([...rows].reverse())).toBe(formatJudges(rows))
    })
  })

  test("a long provider host does not widen the label column", () => {
    const text = formatJudges(byJudge([judged("allow", 100, { judge: "m", provider: "a-very-long-hostname.internal.example:8443" })]))
    const [header] = text.split("\n")
    expect(header!.length).toBeLessThan(80)
  })

  test("a single model still gets its provider heading", () => {
    const lines = formatJudges(byJudge([judged("allow", 100, a), judged("ask", 200, a)])).split("\n")
    expect(lines.length).toBe(3)
    expect(lines[1]).toBe("x.example")
    expect(lines[2]).toMatch(/^ {2}a\s+2\s+50\.0%\s+50\.0%\s+0\.0%\s+0\.0%\s+0\.2s\s+0\.2s$/)
  })
})

describe("top", () => {
  const retry = { resources: ["make test"] }
  const entries = [
    judged("ask", 1, { resources: ["pip install x"] }),
    judged("ask", 1, { resources: ["pip install x"] }),
    plugin("too_long", { resources: ["python big.py"] }),
    config("edit", "ask"),
    judged("deny", 1, { resources: ["rm -rf ~"] }),
    plugin("error", { ...retry, error: "HTTP 429" }),
    plugin("error", { ...retry, error: "HTTP 429" }),
    plugin("error", { ...retry, error: "timeout" }),
    plugin("unconfigured", retry),
  ]

  test("lists what ended in an ask, most frequent first, ties alphabetical", () => {
    expect(top(entries, "ask")).toEqual([
      { label: "make test", count: 4 },
      { label: "pip install x", count: 2 },
      { label: "edit c", count: 1 },
      { label: "python big.py", count: 1 },
    ])
  })

  test("lists denies", () => {
    expect(top(entries, "deny")).toEqual([{ label: "rm -rf ~", count: 1 }])
  })

  test("groups errors by message and includes unconfigured", () => {
    expect(top(entries, "error")).toEqual([
      { label: "HTTP 429", count: 2 },
      { label: "judge not configured", count: 1 },
      { label: "timeout", count: 1 },
    ])
  })

  test("respects the limit", () => {
    expect(top(entries, "ask", 1)).toEqual([{ label: "make test", count: 4 }])
  })
})

describe("parseWhen", () => {
  const now = at("2026-11-17T12:00:00Z")

  test("durations count back from now", () => {
    expect(parseWhen("12h", now)).toBe(at("2026-11-17T00:00:00Z"))
    expect(parseWhen("30d", now)).toBe(at("2026-10-18T12:00:00Z"))
    expect(parseWhen("2w", now)).toBe(at("2026-11-03T12:00:00Z"))
  })

  test("dates are absolute", () => {
    expect(parseWhen("2026-11-01", now)).toBe(at("2026-11-01T00:00:00Z"))
  })

  test("anything else is rejected with the accepted forms", () => {
    expect(() => parseWhen("soon", now)).toThrow("use 30d, 4w, 12h or a date")
    expect(() => parseWhen("5m", now)).toThrow("cannot read")
  })
})
