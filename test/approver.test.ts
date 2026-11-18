import { describe, expect, test } from "bun:test"
import { createApprover, type ApproverOptions } from "../src/approver.ts"
import type { ApproverEntry } from "../src/audit.ts"
import { JudgeNotConfigured, type Judge, type JudgeContext, type Request } from "../src/judge.ts"
import { createMemory } from "../src/memory.ts"
import type { Verdict } from "../src/verdict.ts"

const setup = (answers: (Verdict | Error)[] | Verdict | Error, options: Partial<ApproverOptions> = {}) => {
  const queue = Array.isArray(answers) ? [...answers] : undefined
  const calls: { request: Request; context: JudgeContext }[] = []
  const judge: Judge = {
    id: "fake",
    provider: "fake.example",
    async decide(request, context) {
      calls.push({ request, context })
      const answer = queue ? (queue.length > 1 ? queue.shift()! : queue[0]!) : (answers as Verdict | Error)
      if (answer instanceof Error) throw answer
      return answer
    },
  }
  const memory = createMemory(3)
  return { approver: createApprover({ judge, memory, ...options }), memory, calls }
}

describe("approver", () => {
  test("makes exactly one judge call per request, whatever its length", async () => {
    const { approver, calls } = setup("allow")
    const review = await approver.review("s", { action: "shell", resources: ["sleep 1", "ls", "head -3"] })
    expect(review.decision).toBe("allow")
    expect(calls.length).toBe(1)
    expect(calls[0]!.request.resources).toEqual(["sleep 1", "ls", "head -3"])
  })

  test("denies with a message naming the full line, else the joined subcommands", async () => {
    const { approver } = setup("deny")
    const withLine = await approver.review("s", { action: "shell", resources: ["ls", "rm -rf ~"], line: "ls && rm -rf ~" })
    expect(withLine.decision).toBe("deny")
    expect(withLine.message).toContain('"ls && rm -rf ~"')
    const without = await approver.review("s", { action: "shell", resources: ["ls", "rm -rf /"] })
    expect(without.message).toContain('"ls ; rm -rf /"')
  })

  test("asks when the judge throws, and says why", async () => {
    const { approver } = setup(new Error("timeout"))
    const review = await approver.review("s", { action: "shell", resources: ["ls"] })
    expect(review.decision).toBe("ask")
    expect(review.message).toContain("could not review this command")
    expect(review.message).toContain("timeout")
  })

  test("asks with the missing settings named when the judge is not configured", async () => {
    const { approver } = setup(new JudgeNotConfigured("judge not configured: set OPENCODE_UNATTENDED_MODEL"))
    const review = await approver.review("s", { action: "shell", resources: ["ls"] })
    expect(review.decision).toBe("ask")
    expect(review.message).toContain("judge not configured: set OPENCODE_UNATTENDED_MODEL")
  })

  test("a judge verdict of ask carries no message", async () => {
    const { approver } = setup("ask")
    expect(await approver.review("s", { action: "shell", resources: ["ls"] })).toEqual({ decision: "ask" })
  })

  test("asks for an empty chain without calling the judge", async () => {
    const { approver, calls } = setup("allow")
    expect((await approver.review("s", { action: "shell", resources: [] })).decision).toBe("ask")
    expect(calls).toEqual([])
  })

  test("the judge receives the session's last few commands and the user's messages", async () => {
    const { approver, memory, calls } = setup("allow")
    for (const c of ["a", "b", "c", "d"]) memory.recordRun("s", c, "completed")
    memory.recordRun("s", "bad", "error")
    memory.recordRun("other", "elsewhere", "completed")
    await approver.review("s", { action: "shell", resources: ["next"] }, ["fix the build"])
    expect(calls[0]!.context.recent.map((r) => r.command)).toEqual(["c", "d", "bad"])
    expect(calls[0]!.context.recent.at(-1)!.status).toBe("error")
    expect(calls[0]!.context.messages).toEqual(["fix the build"])
  })
})

describe("size cap", () => {
  test("a command over the cap asks without a judge call and without truncation", async () => {
    const entries: ApproverEntry[] = []
    const { approver, calls } = setup("allow", { maxCommandChars: 20, audit: (e) => entries.push(e) })
    const review = await approver.review("s", { action: "shell", resources: ["echo " + "x".repeat(30)] })
    expect(review.decision).toBe("ask")
    expect(review.message).toContain("longer than 20 characters")
    expect(calls).toEqual([])
    expect(entries[0]).toMatchObject({ by: "plugin", reason: "too_long", effect: "ask" })
  })

  test("a command exactly at the cap is judged", async () => {
    const { approver, calls } = setup("allow", { maxCommandChars: 20 })
    expect((await approver.review("s", { action: "shell", resources: ["x".repeat(20)] })).decision).toBe("allow")
    expect(calls.length).toBe(1)
  })

  test("the cap applies to the full line when it is longer than the pieces", async () => {
    const { approver, calls } = setup("allow", { maxCommandChars: 10 })
    const review = await approver.review("s", { action: "shell", resources: ["a", "b"], line: "a ".repeat(20) + "| b" })
    expect(review.decision).toBe("ask")
    expect(calls).toEqual([])
  })
})

describe("deny streak", () => {
  test("denies become asks once the streak reaches the limit", async () => {
    const { approver } = setup("deny", { denyStreak: 3 })
    const decisions = []
    for (let i = 0; i < 5; i++) decisions.push((await approver.review("s", { action: "shell", resources: ["rm -rf /"] })).decision)
    expect(decisions).toEqual(["deny", "deny", "ask", "ask", "ask"])
  })

  test("the downgraded ask explains itself", async () => {
    const { approver } = setup("deny", { denyStreak: 2 })
    await approver.review("s", { action: "shell", resources: ["rm -rf /"] })
    const review = await approver.review("s", { action: "shell", resources: ["rm -rf /"] })
    expect(review.decision).toBe("ask")
    expect(review.message).toContain("2 commands in a row")
  })

  test("a non-deny verdict resets the streak", async () => {
    const { approver } = setup(["deny", "deny", "allow", "deny", "deny"], { denyStreak: 3 })
    const decisions = []
    for (let i = 0; i < 5; i++) decisions.push((await approver.review("s", { action: "shell", resources: ["x"] })).decision)
    expect(decisions).toEqual(["deny", "deny", "allow", "deny", "deny"])
  })

  test("judge errors neither count nor reset", async () => {
    const { approver } = setup(["deny", new Error("down"), "deny"], { denyStreak: 2 })
    const decisions = []
    for (let i = 0; i < 3; i++) decisions.push((await approver.review("s", { action: "shell", resources: ["x"] })).decision)
    expect(decisions).toEqual(["deny", "ask", "ask"])
  })

  test("streaks are per session", async () => {
    const { approver } = setup("deny", { denyStreak: 2 })
    await approver.review("a", { action: "shell", resources: ["x"] })
    expect((await approver.review("b", { action: "shell", resources: ["x"] })).decision).toBe("deny")
  })
})

describe("audit", () => {
  const run = async (judge: Verdict | Error, commands: string[], options: Partial<ApproverOptions> = {}) => {
    const entries: ApproverEntry[] = []
    const { approver } = setup(judge, { audit: (e) => entries.push(e), ...options })
    await approver.review("s", { action: "shell", resources: commands })
    expect(entries.length).toBe(1)
    return entries[0]!
  }

  test.each(["allow", "ask", "deny"] as const)("a judge %s is recorded as the judge's decision", async (verdict) => {
    const entry = await run(verdict, ["ls", "wc -l"])
    expect(entry).toMatchObject({
      sessionID: "s",
      action: "shell",
      resources: ["ls", "wc -l"],
      effect: verdict,
      by: "judge",
      judge: "fake",
    })
    expect(typeof entry.time).toBe("number")
    expect(typeof entry.latency).toBe("number")
    expect(entry.reason).toBeUndefined()
    expect(entry.error).toBeUndefined()
  })

  test("a failed judge call is a plugin ask with the error, judge and latency", async () => {
    const entry = await run(new Error("down"), ["ls"])
    expect(entry).toMatchObject({ effect: "ask", by: "plugin", reason: "error", error: "down", judge: "fake" })
    expect(typeof entry.latency).toBe("number")
  })

  test("a judge that is not configured is a plugin ask with no judge and no latency", async () => {
    const entry = await run(new JudgeNotConfigured("judge not configured: set K"), ["ls"])
    expect(entry).toMatchObject({ effect: "ask", by: "plugin", reason: "unconfigured" })
    expect(entry).not.toHaveProperty("judge")
    expect(entry).not.toHaveProperty("latency")
    expect(entry).not.toHaveProperty("error")
  })

  test("an over-long command is a plugin ask that never reached the judge", async () => {
    const entry = await run("allow", ["echo " + "x".repeat(30)], { maxCommandChars: 20 })
    expect(entry).toMatchObject({ effect: "ask", by: "plugin", reason: "too_long" })
    expect(entry).not.toHaveProperty("judge")
    expect(entry).not.toHaveProperty("latency")
  })

  test("a deny streak is a plugin ask that keeps the judge and latency", async () => {
    const entry = await run("deny", ["rm -rf /"], { denyStreak: 1 })
    expect(entry).toMatchObject({ effect: "ask", by: "plugin", reason: "deny_streak", judge: "fake" })
    expect(typeof entry.latency).toBe("number")
  })

  test("a command that parsed to nothing is logged as a plugin ask", async () => {
    const entry = await run("allow", [])
    expect(entry).toMatchObject({ effect: "ask", by: "plugin", reason: "unparsed", resources: [] })
    expect(entry).not.toHaveProperty("judge")
  })

  test("every path that consulted the judge records its provider next to its model", async () => {
    const entries = [
      await run("allow", ["ls"]),
      await run("deny", ["ls"]),
      await run(new Error("down"), ["ls"]),
      await run("deny", ["rm -rf /"], { denyStreak: 1 }),
    ]
    for (const entry of entries) expect(entry).toMatchObject({ judge: "fake", provider: "fake.example" })
  })

  test("paths that never reached the judge record no provider", async () => {
    const entries = [
      await run(new JudgeNotConfigured("judge not configured: set K"), ["ls"]),
      await run("allow", ["echo " + "x".repeat(30)], { maxCommandChars: 20 }),
      await run("allow", []),
    ]
    for (const entry of entries) expect(entry).not.toHaveProperty("provider")
  })

  test("a judge with no provider records none", async () => {
    const entries: ApproverEntry[] = []
    const judge: Judge = { id: "bare", decide: async () => "allow" }
    await createApprover({ judge, memory: createMemory(1), audit: (e) => entries.push(e) }).review("s", { action: "shell", resources: ["ls"] })
    expect(entries[0]).toMatchObject({ judge: "bare" })
    expect(entries[0]).not.toHaveProperty("provider")
  })
})

describe("any action", () => {
  test("the judge receives the action and resources unchanged", async () => {
    const { approver, calls } = setup("allow")
    await approver.review("s", { action: "webfetch", resources: ["https://example.com/docs"] })
    expect(calls[0]!.request).toEqual({ action: "webfetch", resources: ["https://example.com/docs"] })
  })

  test("a non-shell deny names the action and the resource", async () => {
    const { approver } = setup("deny")
    const review = await approver.review("s", { action: "edit", resources: ["/etc/hosts"] })
    expect(review.decision).toBe("deny")
    expect(review.message).toContain('edit "/etc/hosts"')
  })

  test.each([[[]], [["  ", "*"]]])(
    "resources %j tell the judge nothing, so it is not called",
    async (resources) => {
      const entries: ApproverEntry[] = []
      const { approver, calls } = setup("allow", { audit: (e) => entries.push(e) })
      expect(await approver.review("s", { action: "github_create_issue", resources })).toEqual({ decision: "ask" })
      expect(calls).toEqual([])
      expect(entries).toMatchObject([{ by: "plugin", reason: "unparsed", action: "github_create_issue", effect: "ask" }])
    },
  )

  test("a single resource with detail is enough to judge", async () => {
    const { approver, calls } = setup("allow")
    expect((await approver.review("s", { action: "external_directory", resources: ["*", "/tmp/x/*"] })).decision).toBe("allow")
    expect(calls).toHaveLength(1)
  })

  test("the audit entry carries the real action", async () => {
    const entries: ApproverEntry[] = []
    const { approver } = setup("allow", { audit: (e) => entries.push(e) })
    await approver.review("s", { action: "websearch", resources: ["bun test"] })
    expect(entries).toMatchObject([{ action: "websearch", resources: ["bun test"], by: "judge", effect: "allow", judge: "fake" }])
  })

  test("the cap and the streak count requests of any action together", async () => {
    const { approver } = setup("deny", { denyStreak: 2 })
    expect((await approver.review("s", { action: "shell", resources: ["rm -rf /"] })).decision).toBe("deny")
    const second = await approver.review("s", { action: "webfetch", resources: ["https://bad.example"] })
    expect(second.decision).toBe("ask")
    expect(second.message).toContain("2 requests in a row")
  })
})
