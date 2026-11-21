import { describe, expect, test } from "bun:test"
import type { AuditEntry } from "../src/audit.ts"
import { byJudge, formatActions, formatJudges, monthly, parseWhen, summarize, top } from "../src/stats.ts"

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

/**
 * Reads a rendered table into rows of { label, ...cells keyed by header }, so tests do not depend on column order or spacing.
 * A repeated header keeps its first cell under its own name and later ones under `NAME_2`, `NAME_3`, ... A count that follows a
 * percentage stays in its cell: `4.8% (23)` reads as `4.8%(23)`.
 */
const table = (text: string): Record<string, string>[] => {
  const lines = text.split("\n")
  const headers = lines.find((line) => /^(ACTION|MONTH|MODEL)\b/.test(line))!.trim().split(/\s+/)
  const keys = headers.map((h, i) => (headers.indexOf(h) === i ? h : `${h}_${headers.slice(0, i + 1).filter((x) => x === h).length}`))
  return lines
    .slice(lines.findIndex((line) => /^(ACTION|MONTH|MODEL)\b/.test(line)) + 1)
    .map((line) => line.trim().replace(/%\s+\(/g, "%(").split(/\s+/))
    .filter((cells) => cells.length >= headers.length)
    .map((cells) => {
      const values = cells.slice(1 - headers.length)
      return { label: cells.slice(0, cells.length - values.length).join(" "), ...Object.fromEntries(values.map((v, i) => [keys[i + 1]!, v])) }
    })
}

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
    plugin("deny_limit", { judge: "m", latency: 500 }),
    plugin("error", { judge: "m", latency: 900, error: "HTTP 500" }),
    plugin("unconfigured"),
    plugin("unparsed"),
  ]
  const stats = summarize(entries)

  test("counts requests of every action, those your config allowed, and those handled without prompting you", () => {
    expect(stats.seen).toBe(13)
    expect(stats.config).toBe(4)
    expect(stats.judged).toBe(9)
    expect(stats.handled).toBe(7)
  })

  test("breaks requests down by action, most frequent first", () => {
    expect(stats.byAction).toEqual([
      { action: "shell", seen: 11, config: 2, judged: 9, asked: 6 },
      { action: "edit", seen: 1, config: 1, judged: 0, asked: 0 },
      { action: "read", seen: 1, config: 1, judged: 0, asked: 0 },
    ])
  })

  test("splits the judge's answers from the plugin's reasons", () => {
    expect(stats.outcomes).toEqual({
      allow: 2,
      ask: 1,
      deny: 1,
      too_long: 1,
      deny_limit: 1,
      ask_limit: 0,
      unavailable: 0,
      error: 1,
      unconfigured: 1,
      unparsed: 1,
    })
  })

  test("a request the plugin turned back to the agent is a deny, not a prompt", () => {
    const turnedBack = summarize([plugin("too_long", { effect: "deny" }), plugin("too_long"), judged("allow", 100)])
    expect(turnedBack.outcomes).toMatchObject({ deny: 1, too_long: 1, allow: 1 })
    expect(turnedBack.handled).toBe(2)
    expect(turnedBack.judged).toBe(3)
  })

  test("computes latency percentiles over entries that have one", () => {
    expect(stats.latency).toEqual({ p50: 400, p95: 900 })
  })

  describe("action table", () => {
    test("a label row says the percentages are shares of requests, over CONFIG, JUDGED and PROMPTED only", () => {
      const [label, header] = formatActions(stats.byAction, 1).split("\n")
      const start = label!.indexOf("% of requests")
      expect(start).toBeGreaterThanOrEqual(header!.indexOf("REQUESTS") + "REQUESTS".length)
      expect(start + "% of requests".length).toBeLessThanOrEqual(header!.length)
      expect(label).toBe(label!.trimEnd())
    })

    test("actions beyond the limit fold into others, and the total covers every action", () => {
      const out = table(formatActions(stats.byAction, 1))
      expect(out.map((row) => row.label)).toEqual(["shell", "others (2)", "TOTAL"])
      expect(out[0]).toMatchObject({ REQUESTS: "11", CONFIG: "18.2%", JUDGED: "81.8%", PROMPTED: "54.5%" })
      expect(out[1]).toMatchObject({ REQUESTS: "2", CONFIG: "100.0%", JUDGED: "0.0%", PROMPTED: "0.0%" })
      expect(out[2]).toMatchObject({ REQUESTS: "13", CONFIG: "30.8%(4)", JUDGED: "69.2%(9)", PROMPTED: "46.2%(6)" })
    })
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

})

describe("byJudge", () => {
  const a = { judge: "a", provider: "x.example" }
  const entries = [
    judged("allow", 100, a),
    judged("allow", 300, a),
    judged("ask", 200, a),
    plugin("error", { ...a, latency: 900, error: "HTTP 500" }),
    plugin("deny_limit", { ...a, latency: 500 }),
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

  test("a label row says the outcome percentages are shares of judged, over ALLOWED to FAILED only", () => {
    const [label, header] = formatJudges(byJudge(entries)).split("\n")
    const start = label!.indexOf("% of judged")
    expect(start).toBeGreaterThanOrEqual(header!.indexOf("JUDGED") + "JUDGED".length)
    expect(start + "% of judged".length).toBeLessThanOrEqual(header!.indexOf("FAILED") + "FAILED".length)
    expect(label).toBe(label!.trimEnd())
  })

  test("Prompted counts everything that ended in a prompt, Failed only the errors, Denied only the judge's denials", () => {
    expect(table(formatJudges(byJudge(entries)))[0]).toMatchObject({
      label: "a",
      JUDGED: "5",
      ALLOWED: "40.0%",
      DENIED: "0.0%",
      PROMPTED: "60.0%",
      FAILED: "20.0%",
    })
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
    expect(parseWhen("90m", now)).toBe(at("2026-11-17T10:30:00Z"))
  })

  test("dates are absolute", () => {
    expect(parseWhen("2026-11-01", now)).toBe(at("2026-11-01T00:00:00Z"))
  })

  test("anything else is rejected with the accepted forms", () => {
    expect(() => parseWhen("soon", now)).toThrow("use 30d, 4w, 12h or a date")
    expect(() => parseWhen("5x", now)).toThrow("cannot read")
  })
})
