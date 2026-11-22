import { describe, expect, test } from "bun:test"
import { createApprover, TOO_LONG, type ApproverOptions } from "../src/approver.ts"
import type { ApproverEntry } from "../src/audit/audit.ts"
import { JudgeNotConfigured, JudgeUnavailable, type Judge, type JudgeContext, type Judgement, type Request, type Verdict } from "../src/judge/judge.ts"
import { MAX_TOOL_CALL_CHARS } from "../src/judge/limits.ts"

type Answer = Verdict | Judgement | Error

const judgement = (answer: Verdict | Judgement): Judgement => (typeof answer === "string" ? { verdict: answer, reason: "" } : answer)

const setup = (answers: Answer[] | Answer, options: Partial<ApproverOptions> = {}) => {
  const queue = Array.isArray(answers) ? [...answers] : undefined
  const calls: { request: Request; context: JudgeContext }[] = []
  const judge: Judge = {
    id: "fake",
    provider: "fake.example",
    async decide(request, context) {
      calls.push({ request, context })
      const answer = queue ? (queue.length > 1 ? queue.shift()! : queue[0]!) : (answers as Answer)
      if (answer instanceof Error) throw answer
      return judgement(answer)
    },
  }
  return { approver: createApprover({ judge, ...options }), calls }
}

const SUFFIX = "Do not reach the same effect another way. If it is essential, stop and tell the user what you need and why."

const shell = (...resources: string[]) => ({ action: "shell", resources })

/** Runs distinct requests, so the verdict cache never answers for the judge. */
const reviewAll = async (approver: ReturnType<typeof setup>["approver"], count: number, session = "s") => {
  const decisions = []
  for (let i = 0; i < count; i++) decisions.push((await approver.review(session, shell(`cmd ${i}`))).decision)
  return decisions
}

describe("approver", () => {
  test("makes exactly one judge call per request, whatever its length", async () => {
    const { approver, calls } = setup("allow")
    const review = await approver.review("s", shell("sleep 1", "ls", "head -3"))
    expect(review.decision).toBe("allow")
    expect(calls.length).toBe(1)
    expect(calls[0]!.request.resources).toEqual(["sleep 1", "ls", "head -3"])
  })

  test("a deny goes back to the agent with the judge's reason", async () => {
    const { approver } = setup({ verdict: "deny", reason: "That wipes the home directory." })
    const review = await approver.review("s", { action: "shell", resources: ["ls", "rm -rf ~"], line: "ls && rm -rf ~" })
    expect(review.decision).toBe("deny")
    expect(review.message).toBe(`That wipes the home directory. ${SUFFIX}`)
  })

  test("a deny with no reason still says something", async () => {
    const { approver } = setup("deny")
    expect((await approver.review("s", shell("rm -rf /"))).message).toBe(`This is not something to do unattended. ${SUFFIX}`)
  })

  test("asks when the judge throws, and says why", async () => {
    const { approver } = setup(new Error("timeout"))
    const review = await approver.review("s", shell("ls"))
    expect(review.decision).toBe("ask")
    expect(review.message).toContain("could not review this command")
    expect(review.message).toContain("timeout")
  })

  test("the judge receives the recent tool calls and the user's messages it was given", async () => {
    const { approver, calls } = setup("allow")
    const recent = [{ tool: "shell", input: "make", status: "error" as const }]
    await approver.review("s", shell("next"), { messages: ["fix the build"], recent })
    expect(calls[0]!.context).toEqual({ recent, messages: ["fix the build"] })
  })

})

describe("size cap", () => {
  const long = "echo " + "x".repeat(MAX_TOOL_CALL_CHARS)

  test("a request over the cap is turned back to the agent without a judge call or truncation", async () => {
    const { approver, calls } = setup("allow")
    const review = await approver.review("s", shell(long))
    expect(review).toEqual({ decision: "deny", message: TOO_LONG })
    expect(calls).toEqual([])
  })

  test("a request exactly at the cap is judged", async () => {
    const { approver, calls } = setup("allow")
    expect((await approver.review("s", shell("x".repeat(MAX_TOOL_CALL_CHARS)))).decision).toBe("allow")
    expect(calls.length).toBe(1)
  })

  test("the cap applies to the full line when it is longer than the pieces", async () => {
    const { approver, calls } = setup("allow")
    const review = await approver.review("s", { action: "shell", resources: ["a", "b"], line: "a ".repeat(MAX_TOOL_CALL_CHARS) + "| b" })
    expect(review.decision).toBe("deny")
    expect(calls).toEqual([])
  })

  test("it counts toward the run of turned-back requests, so an agent that keeps sending them reaches the user", async () => {
    const { approver } = setup("allow", { escalateAfter: 3 })
    const decisions = []
    for (let i = 0; i < 4; i++) decisions.push((await approver.review("s", shell(long + i))).decision)
    expect(decisions).toEqual(["deny", "deny", "ask", "deny"])
  })

})

describe("what the user sees", () => {
  test("requests reach the user once enough have been turned back in a row", async () => {
    const { approver } = setup("deny", { escalateAfter: 3 })
    expect(await reviewAll(approver, 7)).toEqual(["deny", "deny", "ask", "deny", "deny", "ask", "deny"])
  })

  test("an allow resets the run", async () => {
    const { approver } = setup(["deny", "deny", "allow", "deny", "deny"], { escalateAfter: 3 })
    expect(await reviewAll(approver, 5)).toEqual(["deny", "deny", "allow", "deny", "deny"])
  })

  test("denies with an allow between them never reach the user", async () => {
    const { approver } = setup(["deny", "allow", "deny", "allow", "deny", "allow"], { escalateAfter: 2 })
    expect(await reviewAll(approver, 6)).toEqual(["deny", "allow", "deny", "allow", "deny", "allow"])
  })

  test("seeing the user starts the run again", async () => {
    const { approver } = setup("deny", { escalateAfter: 2 })
    expect(await reviewAll(approver, 5)).toEqual(["deny", "ask", "deny", "ask", "deny"])
  })

  test("judge errors neither count nor reset", async () => {
    const { approver } = setup(["deny", new Error("down"), "deny"], { escalateAfter: 2 })
    expect(await reviewAll(approver, 3)).toEqual(["deny", "ask", "ask"])
  })

  test("counts are per session", async () => {
    const { approver } = setup("deny", { escalateAfter: 2 })
    await reviewAll(approver, 1, "a")
    expect(await reviewAll(approver, 1, "b")).toEqual(["deny"])
  })

  test("the message to the user carries the latest reason, and no counts", async () => {
    const { approver } = setup({ verdict: "deny", reason: "It wipes the disk." }, { escalateAfter: 1 })
    const review = await approver.review("s", shell("dd if=/dev/zero of=/dev/sda"))
    expect(review.decision).toBe("ask")
    expect(review.message).toContain("It wipes the disk.")
    expect(review.message).not.toMatch(/\d+ (requests|commands)|in a row|limit/)
  })
})

describe("what the agent sees", () => {
  const MENTIONS = /in a row|limit|budget|streak|retry|try again|\d+ (requests|commands|times)/i

  test("no refusal mentions counts, limits, retries or the cache", async () => {
    const { approver } = setup([{ verdict: "deny", reason: "Needs sign-off." }, { verdict: "deny", reason: "Too destructive." }], {
      escalateAfter: 99,
    })
    const messages = []
    for (const line of ["a", "b", "a", "b", "a"]) messages.push((await approver.review("s", shell(line))).message!)
    messages.push((await approver.review("s", shell("x".repeat(MAX_TOOL_CALL_CHARS + 1)))).message!)
    for (const message of messages) expect(message).not.toMatch(MENTIONS)
  })

  test("a repeated request gets the same words as the first, without a second judge call", async () => {
    const { approver, calls } = setup({ verdict: "deny", reason: "Needs sign-off." }, { escalateAfter: 99 })
    const first = await approver.review("s", shell("git push"))
    const second = await approver.review("s", shell("git push"))
    expect(second).toEqual(first)
    expect(calls).toHaveLength(1)
  })

  test("a judge that would flip its answer cannot be retried into allowing", async () => {
    const { approver, calls } = setup(["deny", "allow"], { escalateAfter: 99 })
    const decisions = []
    for (let i = 0; i < 3; i++) decisions.push((await approver.review("s", shell("rm -rf build/..", "x"))).decision)
    expect(decisions).toEqual(["deny", "deny", "deny"])
    expect(calls).toHaveLength(1)
  })

  test("a repeat still counts, so an agent that insists reaches the user", async () => {
    const { approver } = setup("deny", { escalateAfter: 3 })
    const decisions = []
    for (let i = 0; i < 3; i++) decisions.push((await approver.review("s", shell("git push"))).decision)
    expect(decisions).toEqual(["deny", "deny", "ask"])
  })

  test("a request the user approved is judged afresh when the agent repeats it, and others stay cached", async () => {
    const { approver, calls } = setup("deny", { escalateAfter: 99 })
    await approver.review("s", shell("git push"))
    await approver.review("s", shell("npm publish"))
    expect(calls).toHaveLength(2)
    approver.forget("s", shell("git push"))
    await approver.review("s", shell("git push"))
    await approver.review("s", shell("npm publish"))
    expect(calls).toHaveLength(3)
  })

  test("a different request is judged afresh", async () => {
    const { approver, calls } = setup("deny", { escalateAfter: 99 })
    await approver.review("s", shell("a"))
    await approver.review("s", shell("b"))
    await approver.review("s", { action: "shell", resources: ["a"], line: "a && b" })
    expect(calls).toHaveLength(3)
  })

  test("a new user message may cover what was refused, so the request is judged again", async () => {
    const { approver, calls } = setup(["deny", "allow"])
    const said = (...messages: string[]) => ({ messages })
    expect((await approver.review("s", shell("git push"), said("fix the test"))).decision).toBe("deny")
    expect((await approver.review("s", shell("git push"), said("fix the test"))).decision).toBe("deny")
    expect(calls).toHaveLength(1)
    expect((await approver.review("s", shell("git push"), said("fix the test", "now push it"))).decision).toBe("allow")
    expect(calls).toHaveLength(2)
  })

  test("an allow is never cached", async () => {
    const { approver, calls } = setup(["allow", "deny"])
    expect((await approver.review("s", shell("x"))).decision).toBe("allow")
    expect((await approver.review("s", shell("x"))).decision).toBe("deny")
    expect(calls).toHaveLength(2)
  })

  test("the cache is per session", async () => {
    const { approver, calls } = setup("deny", { escalateAfter: 99 })
    await approver.review("a", shell("x"))
    await approver.review("b", shell("x"))
    expect(calls).toHaveLength(2)
  })
})

describe("an unavailable judge", () => {
  const clock = () => {
    let time = 1_000
    return { now: () => time, advance: (ms: number) => void (time += ms) }
  }

  test("after it exhausts its retries, requests go to the user without a call until the cooldown ends", async () => {
    const { now, advance } = clock()
    const { approver, calls } = setup([new JudgeUnavailable("judge HTTP 429"), "allow"], { cooldownMs: 60_000, now })
    const first = await approver.review("s", shell("a"))
    expect(first.decision).toBe("ask")
    advance(30_000)
    const second = await approver.review("s", shell("b"))
    expect(second.decision).toBe("ask")
    expect(second.message).toContain("unavailable")
    expect(second.message).toContain("judge HTTP 429")
    expect(calls).toHaveLength(1)
    advance(30_001)
    expect((await approver.review("s", shell("c"))).decision).toBe("allow")
    expect(calls).toHaveLength(2)
  })

  test("a judge that answered badly is not an outage: the next request still goes to it", async () => {
    const { approver, calls } = setup([new Error("judge returned unknown decision"), "allow"])
    expect((await approver.review("s", shell("a"))).decision).toBe("ask")
    expect((await approver.review("s", shell("b"))).decision).toBe("allow")
    expect(calls).toHaveLength(2)
  })

  test("it does not touch the counts", async () => {
    const { now, advance } = clock()
    const { approver } = setup(["deny", new JudgeUnavailable("down"), "deny"], { escalateAfter: 2, cooldownMs: 10, now })
    const first = await approver.review("s", shell("a"))
    await approver.review("s", shell("b"))
    advance(11)
    const third = await approver.review("s", shell("c"))
    expect([first.decision, third.decision]).toEqual(["deny", "ask"])
  })
})

describe("audit", () => {
  const run = async (answer: Answer, commands: string[], options: Partial<ApproverOptions> = {}) => {
    const entries: ApproverEntry[] = []
    const { approver } = setup(answer, { audit: (e) => entries.push(e), ...options })
    await approver.review("s", shell(...commands))
    expect(entries.length).toBe(1)
    return entries[0]!
  }

  test("an allow is recorded with its judge and latency", async () => {
    const entry = await run("allow", ["ls", "wc -l"])
    expect(entry).toMatchObject({ sessionID: "s", action: "shell", resources: ["ls", "wc -l"], effect: "allow", by: "judge", judge: "fake" })
    expect(typeof entry.latency).toBe("number")
    expect(entry.reason).toBeUndefined()
    expect(entry.error).toBeUndefined()
  })

  test("an allow keeps the judge's reason", async () => {
    const entry = await run({ verdict: "allow", reason: "Read-only listing of the project." }, ["ls"])
    expect(entry).toMatchObject({ effect: "allow", by: "judge", why: "Read-only listing of the project." })
  })

  test("a deny is recorded with the judge's reason", async () => {
    const entry = await run({ verdict: "deny", reason: "Too destructive." }, ["rm -rf /"])
    expect(entry).toMatchObject({ effect: "deny", by: "judge", judge: "fake", why: "Too destructive." })
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

  test("an over-long command is a plugin deny without a judge, or a plugin ask for the limit once it is reached", async () => {
    const long = ["echo " + "x".repeat(MAX_TOOL_CALL_CHARS)]
    const entry = await run("allow", long)
    expect(entry).toMatchObject({ effect: "deny", by: "plugin", reason: "too_long" })
    expect(entry).not.toHaveProperty("judge")
    expect(entry).not.toHaveProperty("latency")
    expect(await run("allow", long, { escalateAfter: 1 })).toMatchObject({ effect: "ask", by: "plugin", reason: "deny_limit" })
  })

  test("reaching the limit is a plugin ask that keeps the judge and latency", async () => {
    const entry = await run({ verdict: "deny", reason: "Too destructive." }, ["rm -rf /"], { escalateAfter: 1 })
    expect(entry).toMatchObject({ effect: "ask", by: "plugin", reason: "deny_limit", judge: "fake", why: "Too destructive." })
    expect(typeof entry.latency).toBe("number")
  })

  test("a request skipped because the judge is unavailable is a plugin ask with no judge", async () => {
    const entries: ApproverEntry[] = []
    const { approver } = setup(new JudgeUnavailable("down"), { audit: (e) => entries.push(e) })
    await approver.review("s", shell("a"))
    await approver.review("s", shell("b"))
    expect(entries[1]).toMatchObject({ effect: "ask", by: "plugin", reason: "unavailable" })
    expect(entries[1]).not.toHaveProperty("judge")
  })

  test("a cached refusal is recorded as a deny without a judge or latency", async () => {
    const entries: ApproverEntry[] = []
    const { approver } = setup("deny", { audit: (e) => entries.push(e), escalateAfter: 99 })
    await approver.review("s", shell("git push"))
    await approver.review("s", shell("git push"))
    expect(entries[1]).toMatchObject({ effect: "deny", by: "judge", resources: ["git push"] })
    expect(entries[1]).not.toHaveProperty("judge")
    expect(entries[1]).not.toHaveProperty("latency")
  })

  test("every path that consulted the judge records its provider next to its model", async () => {
    const entries = [
      await run("allow", ["ls"]),
      await run("deny", ["ls"]),
      await run(new Error("down"), ["ls"]),
      await run("deny", ["rm -rf /"], { escalateAfter: 1 }),
    ]
    for (const entry of entries) expect(entry).toMatchObject({ judge: "fake", provider: "fake.example" })
  })

})

describe("any action", () => {

  test("a non-shell deny carries the reason and not the resource", async () => {
    const { approver } = setup({ verdict: "deny", reason: "That is a system file." })
    const review = await approver.review("s", { action: "edit", resources: ["/etc/hosts"] })
    expect(review.decision).toBe("deny")
    expect(review.message).toContain("That is a system file.")
    expect(review.message).not.toContain("/etc/hosts")
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
})
