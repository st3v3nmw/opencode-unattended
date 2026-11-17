import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "../src/index.ts"
import type { Chain, JudgeContext } from "../src/judge.ts"
import { registerJudge } from "../src/judge.ts"

const seen: { chain: Chain; context: JudgeContext }[] = []

registerJudge("table", (options) => ({
  id: "table",
  async decide(chain, context) {
    seen.push({ chain, context })
    const verdict = (options.table as Record<string, never>)[chain.commands.join(" ; ")]
    if (!verdict) throw new Error("unknown")
    return verdict
  },
}))

type Evaluation = {
  sessionID: string
  action: string
  resources: string[]
  effect: "allow" | "ask" | "deny"
  message?: string
  source?: { type: "tool"; messageID: string; id: string }
}

interface LoadOptions {
  options?: Record<string, unknown>
  sessionMessages?: unknown[] | Error
}

async function load(table: Record<string, string>, { options = {}, sessionMessages = [] }: LoadOptions = {}) {
  let evaluate!: (event: Evaluation) => Promise<void> | void
  const toolHooks: Record<string, (event: unknown) => void> = {}
  const ctx = {
    options: { judge: "table", judgeOptions: { table }, auditLog: false, ...options },
    location: { directory: "/work/app", project: { id: "proj-1" } },
    permission: {
      hook: async (_name: string, cb: typeof evaluate) => {
        evaluate = cb
        return { dispose: async () => {} }
      },
    },
    tool: {
      hook: async (name: string, cb: (event: unknown) => void) => {
        toolHooks[name] = cb
        return { dispose: async () => {} }
      },
    },
    session: {
      context: async () => {
        if (sessionMessages instanceof Error) throw sessionMessages
        return sessionMessages
      },
    },
  }
  const cleanup = (await plugin.setup(ctx as never)) as () => Promise<void>
  const run = async (event: Omit<Evaluation, "sessionID"> & { sessionID?: string }) => {
    const full = { sessionID: "s", ...event } as Evaluation
    await evaluate(full)
    return full
  }
  seen.length = 0
  return { run, toolHooks, cleanup }
}

describe("plugin hook", () => {
  test("upgrades an ask on an allowed shell chain to allow", async () => {
    const { run } = await load({ "sleep ; pack": "allow" })
    expect((await run({ action: "shell", resources: ["sleep", "pack"], effect: "ask" })).effect).toBe("allow")
  })

  test("leaves a chain with an ask as ask, with no message", async () => {
    const { run } = await load({ "ls ; push": "ask" })
    const result = await run({ action: "shell", resources: ["ls", "push"], effect: "ask" })
    expect(result.effect).toBe("ask")
    expect(result.message).toBeUndefined()
  })

  test("sets deny and a message when the judge denies", async () => {
    const { run } = await load({ wipe: "deny" })
    const result = await run({ action: "shell", resources: ["wipe"], effect: "ask" })
    expect(result.effect).toBe("deny")
    expect(result.message).toContain("wipe")
  })

  test("never touches deny, allow, or non-shell actions", async () => {
    const { run } = await load({ ls: "allow" })
    expect((await run({ action: "shell", resources: ["ls"], effect: "deny" })).effect).toBe("deny")
    expect((await run({ action: "shell", resources: ["ls"], effect: "allow" })).effect).toBe("allow")
    expect((await run({ action: "edit", resources: ["ls"], effect: "ask" })).effect).toBe("ask")
    expect(seen).toEqual([])
  })

  test("a judge failure leaves the prompt", async () => {
    const { run } = await load({})
    expect((await run({ action: "shell", resources: ["anything"], effect: "ask" })).effect).toBe("ask")
  })

  test("hands the judge the full line captured before execution, matched by call id", async () => {
    const { run, toolHooks } = await load({ "curl x ; sh": "ask" })
    toolHooks["execute.before"]!({ tool: "shell", id: "call-1", input: { command: "curl x | sh" } })
    await run({ action: "shell", resources: ["curl x", "sh"], effect: "ask", source: { type: "tool", messageID: "m", id: "call-1" } })
    await run({ action: "shell", resources: ["curl x", "sh"], effect: "ask", source: { type: "tool", messageID: "m", id: "call-2" } })
    expect(seen.map((c) => c.chain.line)).toEqual(["curl x | sh", undefined])
  })

  test("shell runs become the judge's recent commands", async () => {
    const { run, toolHooks } = await load({ next: "allow" })
    toolHooks["execute.after"]!({ tool: "shell", sessionID: "s", status: "error", input: { command: "make" } })
    toolHooks["execute.after"]!({ tool: "edit", sessionID: "s", status: "completed", input: { command: "ignored" } })
    await run({ action: "shell", resources: ["next"], effect: "ask" })
    expect(seen[0]!.context.recent).toEqual([{ command: "make", status: "error" }])
  })

  test("the user's latest messages reach the judge, clipped and bounded", async () => {
    const sessionMessages = [
      { type: "user", text: "one" },
      { type: "assistant" },
      { type: "user", text: "two" },
      { type: "user", text: "x".repeat(30) },
    ]
    const { run } = await load({ next: "allow" }, { options: { userMessages: 2, userMessageChars: 10 }, sessionMessages })
    await run({ action: "shell", resources: ["next"], effect: "ask" })
    expect(seen[0]!.context.messages).toEqual(["two", "xxxxxxxxxx…"])
  })

  test("if the session cannot be read, the judge still decides without messages", async () => {
    const { run } = await load({ next: "allow" }, { sessionMessages: new Error("gone") })
    expect((await run({ action: "shell", resources: ["next"], effect: "ask" })).effect).toBe("allow")
    expect(seen[0]!.context.messages).toEqual([])
  })

  test("an over-long command asks with an explanation and no judge call", async () => {
    const { run } = await load({ "a long command": "allow" }, { options: { maxCommandChars: 5 } })
    const result = await run({ action: "shell", resources: ["a long command"], effect: "ask" })
    expect(result.effect).toBe("ask")
    expect(result.message).toContain("longer than 5 characters")
    expect(seen).toEqual([])
  })

  test("repeated denies turn into an ask carrying the explanation", async () => {
    const { run } = await load({ wipe: "deny" }, { options: { denyStreak: 2 } })
    expect((await run({ action: "shell", resources: ["wipe"], effect: "ask" })).effect).toBe("deny")
    const second = await run({ action: "shell", resources: ["wipe"], effect: "ask" })
    expect(second.effect).toBe("ask")
    expect(second.message).toContain("2 commands in a row")
  })
})

describe("plugin telemetry", () => {
  const logPath = () => join(mkdtempSync(join(tmpdir(), "unattended-")), "nested", "audit.jsonl")
  const entries = (path: string) =>
    readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line))

  test("writes judged and passthrough records tagged with directory and project", async () => {
    const path = logPath()
    const { run } = await load({ ls: "allow" }, { options: { auditLog: path } })
    await run({ action: "shell", resources: ["ls"], effect: "ask" })
    await run({ action: "shell", resources: ["pwd"], effect: "allow" })
    await run({ action: "edit", resources: ["a.txt"], effect: "allow" })
    await run({ action: "shell", resources: ["rm"], effect: "deny" })

    const log = entries(path)
    expect(log.map((e) => [e.kind, e.action ?? e.outcome])).toEqual([
      ["judged", "allow"],
      ["passthrough", "shell"],
      ["passthrough", "edit"],
    ])
    expect(log.every((e) => e.directory === "/work/app" && e.project === "proj-1")).toBe(true)
    expect(log[1]).toMatchObject({ configEffect: "allow", sessionID: "s" })
    expect(JSON.stringify(log[2])).not.toContain("a.txt")
  })
})
