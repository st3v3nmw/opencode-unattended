import { describe, expect, test } from "bun:test"
import type { AuditEntry } from "../../src/audit/audit.ts"
import { SUGGEST_TOOL, suggestTool } from "../../src/suggest/tool.ts"

const DAY = 86_400_000
const NOW = 100 * DAY

const entry = (time: number, sessionID: string): AuditEntry => ({
  time,
  sessionID,
  directory: "~/app",
  action: "shell",
  resources: ["make lint"],
  effect: "allow",
  by: "judge",
})

function setup() {
  const asked: number[] = []
  const tool = suggestTool({
    now: () => NOW,
    entries: (since) => {
      asked.push(since)
      return [entry(NOW - 8 * DAY, "old"), entry(NOW - DAY, "a"), entry(NOW - DAY, "b"), entry(NOW - DAY, "a")]
    },
    commands: async () => ["make lint", "ls"],
    resolves: () => true,
  })
  return { tool, asked }
}

describe("suggest tool", () => {
  test("reads the window it was asked for and reports what it found", async () => {
    const { tool, asked } = setup()
    expect(tool.name).toBe(SUGGEST_TOOL)
    const { content } = await tool.execute({ days: 7, rules: [] })
    expect(asked).toEqual([NOW - 7 * DAY])
    expect(content).toMatch(/^PATTERN +% OF JUDGED +% OF SESSIONS +EXAMPLE\nmake lint \* +100\.0% +100\.0% +make lint/)
  })

  test("the rules it is given decide what counts as already allowed", async () => {
    const { tool } = setup()
    const { content } = await tool.execute({ days: 7, rules: [{ resource: "make *", effect: "allow" }] })
    expect(content).toContain("No pattern qualifies")
  })

  test("rules for other actions apply to those actions, and rules without an action are shell rules", async () => {
    const tool = suggestTool({
      now: () => NOW,
      entries: () => Array.from({ length: 3 }, () => ({ ...entry(NOW - DAY, "a"), action: "webfetch", resources: ["https://docs.example.com/a"] })),
      commands: async () => [],
      resolves: () => true,
    })
    const open = await tool.execute({ days: 7, rules: [{ resource: "make *", effect: "allow" }] })
    expect(open.content).toMatch(/^\[webfetch\]\nPATTERN .*\nhttps:\/\/docs\.example\.com\/\*/)
    const covered = await tool.execute({ days: 7, rules: [{ action: "webfetch", resource: "https://docs.example.com/*", effect: "allow" }] })
    expect(covered.content).toContain("No pattern qualifies")
  })

  test("leaves out a command that is not on PATH and says so", async () => {
    const tool = suggestTool({
      now: () => NOW,
      entries: () => [entry(NOW - DAY, "a"), entry(NOW - DAY, "b"), entry(NOW - DAY, "a")],
      commands: async () => [],
      resolves: () => false,
    })
    const { content } = await tool.execute({ days: 7, rules: [] })
    expect(content).toContain("Skipped 1 name not found on PATH and not a shell builtin: make.")
    expect(content).toContain("No pattern qualifies")
  })

  test.each([["7"], [1.5], [181]])("rejects days = %p", async (days) => {
    const { tool, asked } = setup()
    expect((await tool.execute({ days, rules: [] })).content).toBe("days must be a whole number from 1 to 180.")
    expect(asked).toEqual([])
  })

  test.each([["make *"], [[{ resource: "make *", effect: "yes" }]]])("rejects rules = %p", async (rules) => {
    const { tool, asked } = setup()
    expect((await tool.execute({ days: 7, rules })).content).toBe("rules must be a list of { action, resource, effect } with effect allow, ask or deny.")
    expect(asked).toEqual([])
  })
})
