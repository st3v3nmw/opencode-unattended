import { describe, expect, test } from "bun:test"
import { createApprover, type ApproverOptions } from "../src/approver.ts"
import type { AuditEntry } from "../src/audit.ts"
import type { Chain, Judge, JudgeContext } from "../src/judge.ts"
import { createMemory } from "../src/memory.ts"
import type { Verdict } from "../src/verdict.ts"

const setup = (answers: (Verdict | Error)[] | Verdict | Error, options: Partial<ApproverOptions> = {}) => {
  const queue = Array.isArray(answers) ? [...answers] : undefined
  const calls: { chain: Chain; context: JudgeContext }[] = []
  const judge: Judge = {
    id: "fake",
    async decide(chain, context) {
      calls.push({ chain, context })
      const answer = queue ? (queue.length > 1 ? queue.shift()! : queue[0]!) : (answers as Verdict | Error)
      if (answer instanceof Error) throw answer
      return answer
    },
  }
  const memory = createMemory(3)
  return { approver: createApprover({ judge, memory, ...options }), memory, calls }
}

describe("approver", () => {
  test("makes exactly one judge call per chain, whatever its length", async () => {
    const { approver, calls } = setup("allow")
    const review = await approver.review("s", { commands: ["sleep 1", "ls", "head -3"] })
    expect(review.decision).toBe("allow")
    expect(calls.length).toBe(1)
    expect(calls[0]!.chain.commands).toEqual(["sleep 1", "ls", "head -3"])
  })

  test("denies with a message naming the full line, else the joined subcommands", async () => {
    const { approver } = setup("deny")
    const withLine = await approver.review("s", { commands: ["ls", "rm -rf ~"], line: "ls && rm -rf ~" })
    expect(withLine.decision).toBe("deny")
    expect(withLine.message).toContain('"ls && rm -rf ~"')
    const without = await approver.review("s", { commands: ["ls", "rm -rf /"] })
    expect(without.message).toContain('"ls ; rm -rf /"')
  })

  test("asks when the judge throws", async () => {
    const { approver } = setup(new Error("timeout"))
    expect((await approver.review("s", { commands: ["ls"] })).decision).toBe("ask")
  })

  test("asks for an empty chain without calling the judge", async () => {
    const { approver, calls } = setup("allow")
    expect((await approver.review("s", { commands: [] })).decision).toBe("ask")
    expect(calls).toEqual([])
  })

  test("the judge receives the session's last few commands and the user's messages", async () => {
    const { approver, memory, calls } = setup("allow")
    for (const c of ["a", "b", "c", "d"]) memory.recordRun("s", c, "completed")
    memory.recordRun("s", "bad", "error")
    memory.recordRun("other", "elsewhere", "completed")
    await approver.review("s", { commands: ["next"] }, ["fix the build"])
    expect(calls[0]!.context.recent.map((r) => r.command)).toEqual(["c", "d", "bad"])
    expect(calls[0]!.context.recent.at(-1)!.status).toBe("error")
    expect(calls[0]!.context.messages).toEqual(["fix the build"])
  })
})

describe("size cap", () => {
  test("a command over the cap asks without a judge call and without truncation", async () => {
    const entries: AuditEntry[] = []
    const { approver, calls } = setup("allow", { maxCommandChars: 20, audit: (e) => entries.push(e) })
    const review = await approver.review("s", { commands: ["echo " + "x".repeat(30)] })
    expect(review.decision).toBe("ask")
    expect(review.message).toContain("longer than 20 characters")
    expect(calls).toEqual([])
    expect(entries[0]).toMatchObject({ kind: "judged", outcome: "too_long", decision: "ask" })
  })

  test("a command exactly at the cap is judged", async () => {
    const { approver, calls } = setup("allow", { maxCommandChars: 20 })
    expect((await approver.review("s", { commands: ["x".repeat(20)] })).decision).toBe("allow")
    expect(calls.length).toBe(1)
  })

  test("the cap applies to the full line when it is longer than the pieces", async () => {
    const { approver, calls } = setup("allow", { maxCommandChars: 10 })
    const review = await approver.review("s", { commands: ["a", "b"], line: "a ".repeat(20) + "| b" })
    expect(review.decision).toBe("ask")
    expect(calls).toEqual([])
  })
})

describe("deny streak", () => {
  test("denies become asks once the streak reaches the limit", async () => {
    const { approver } = setup("deny", { denyStreak: 3 })
    const decisions = []
    for (let i = 0; i < 5; i++) decisions.push((await approver.review("s", { commands: ["rm -rf /"] })).decision)
    expect(decisions).toEqual(["deny", "deny", "ask", "ask", "ask"])
  })

  test("the downgraded ask explains itself", async () => {
    const { approver } = setup("deny", { denyStreak: 2 })
    await approver.review("s", { commands: ["rm -rf /"] })
    const review = await approver.review("s", { commands: ["rm -rf /"] })
    expect(review.decision).toBe("ask")
    expect(review.message).toContain("2 commands in a row")
  })

  test("a non-deny verdict resets the streak", async () => {
    const { approver } = setup(["deny", "deny", "allow", "deny", "deny"], { denyStreak: 3 })
    const decisions = []
    for (let i = 0; i < 5; i++) decisions.push((await approver.review("s", { commands: ["x"] })).decision)
    expect(decisions).toEqual(["deny", "deny", "allow", "deny", "deny"])
  })

  test("judge errors neither count nor reset", async () => {
    const { approver } = setup(["deny", new Error("down"), "deny"], { denyStreak: 2 })
    const decisions = []
    for (let i = 0; i < 3; i++) decisions.push((await approver.review("s", { commands: ["x"] })).decision)
    expect(decisions).toEqual(["deny", "ask", "ask"])
  })

  test("streaks are per session", async () => {
    const { approver } = setup("deny", { denyStreak: 2 })
    await approver.review("a", { commands: ["x"] })
    expect((await approver.review("b", { commands: ["x"] })).decision).toBe("deny")
  })
})

describe("audit", () => {
  test("one entry per chain with outcome, applied decision and latency", async () => {
    const entries: AuditEntry[] = []
    const ok = setup("allow", { audit: (e) => entries.push(e) })
    await ok.approver.review("s", { commands: ["ls", "wc -l"], line: "ls | wc -l" })
    const bad = setup(new Error("down"), { audit: (e) => entries.push(e) })
    await bad.approver.review("s", { commands: ["ls"] })
    const streak = setup("deny", { denyStreak: 1, audit: (e) => entries.push(e) })
    await streak.approver.review("s", { commands: ["rm -rf /"] })

    expect(entries.map((e) => e.kind === "judged" && [e.command, e.outcome, e.decision])).toEqual([
      ["ls | wc -l", "allow", "allow"],
      ["ls", "error", "ask"],
      ["rm -rf /", "deny_streak", "ask"],
    ])
    const first = entries[0]!
    expect(first.kind === "judged" && first.commands).toEqual(["ls", "wc -l"])
    expect(first.kind === "judged" && typeof first.latencyMs).toBe("number")
    expect(entries[1]!.kind === "judged" && entries[1]!.error).toBe("down")
  })
})
