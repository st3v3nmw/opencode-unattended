import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readEntries } from "../src/auditlog.ts"
import plugin from "../src/index.ts"
import type { JudgeContext, Request } from "../src/judge.ts"
import { registerJudge } from "../src/judge.ts"

const seen: { request: Request; context: JudgeContext }[] = []

registerJudge("table", (options) => ({
  id: "table",
  async decide(request, context) {
    seen.push({ request, context })
    const verdict = (options.table as Record<string, never>)[request.resources.join(" ; ")]
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
  metadata?: Record<string, unknown>
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
    options: { judge: { apiStyle: "table", table }, auditDir: false, ...options },
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

  test("never touches an effect your config already decided", async () => {
    const { run } = await load({ ls: "allow" })
    expect((await run({ action: "shell", resources: ["ls"], effect: "deny" })).effect).toBe("deny")
    expect((await run({ action: "shell", resources: ["ls"], effect: "allow" })).effect).toBe("allow")
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
    expect(seen.map((c) => c.request.line)).toEqual(["curl x | sh", undefined])
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
    const { run } = await load({ next: "allow" }, { options: { context: { maxUserMessages: 2, maxUserMessageChars: 10 } }, sessionMessages })
    await run({ action: "shell", resources: ["next"], effect: "ask" })
    expect(seen[0]!.context.messages).toEqual(["two", "xxxxxxxxxx…"])
  })

  test("if the session cannot be read, the judge still decides without messages", async () => {
    const { run } = await load({ next: "allow" }, { sessionMessages: new Error("gone") })
    expect((await run({ action: "shell", resources: ["next"], effect: "ask" })).effect).toBe("allow")
    expect(seen[0]!.context.messages).toEqual([])
  })

  test("an over-long command asks with an explanation and no judge call", async () => {
    const { run } = await load({ "a long command": "allow" }, { options: { context: { maxCommandChars: 5 } } })
    const result = await run({ action: "shell", resources: ["a long command"], effect: "ask" })
    expect(result.effect).toBe("ask")
    expect(result.message).toContain("longer than 5 characters")
    expect(seen).toEqual([])
  })

  test("repeated denies turn into an ask carrying the explanation", async () => {
    const { run } = await load({ wipe: "deny" }, { options: { escalation: { consecutiveDenies: 2 } } })
    expect((await run({ action: "shell", resources: ["wipe"], effect: "ask" })).effect).toBe("deny")
    const second = await run({ action: "shell", resources: ["wipe"], effect: "ask" })
    expect(second.effect).toBe("ask")
    expect(second.message).toContain("2 commands in a row")
  })
})

const ACTIONS: [string, string[]][] = [
  ["shell", ["make test"]],
  ["custom.thing", ["anything"]],
]

describe.each(ACTIONS)("an ask for %s", (action, resources) => {
  const key = resources.join(" ; ")

  test.each(["allow", "deny", "ask"] as const)("goes to the judge, and a %s verdict is applied", async (verdict) => {
    const { run } = await load({ [key]: verdict })
    const result = await run({ action, resources, effect: "ask" })
    expect(result.effect).toBe(verdict)
    expect(seen).toHaveLength(1)
    expect(seen[0]!.request).toMatchObject({ action, resources })
    if (verdict === "ask") expect(result.message).toBeUndefined()
  })

  test("a deny names the request", async () => {
    const { run } = await load({ [key]: "deny" })
    const { message } = await run({ action, resources, effect: "ask" })
    expect(message).toContain(JSON.stringify(key))
    if (action !== "shell") expect(message).toContain(`${action} `)
  })

  test("a judge failure leaves the prompt and says why", async () => {
    const { run } = await load({})
    const result = await run({ action, resources, effect: "ask" })
    expect(result.effect).toBe("ask")
    expect(result.message).toContain(action === "shell" ? "could not review this command" : "could not review this request")
  })

  test("allow and deny from your config pass through unjudged", async () => {
    const { run } = await load({ [key]: "allow" })
    expect((await run({ action, resources, effect: "allow" })).effect).toBe("allow")
    expect((await run({ action, resources, effect: "deny" })).effect).toBe("deny")
    expect(seen).toEqual([])
  })

  test("a resource of * leaves the prompt without a judge call", async () => {
    const { run } = await load({ "*": "allow" })
    const result = await run({ action, resources: ["*"], effect: "ask" })
    expect(result.effect).toBe("ask")
    expect(result.message).toBeUndefined()
    expect(seen).toEqual([])
  })

  test("is logged with its action and resources, and extra event fields are harmless", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "unattended-")), "log")
    const { run } = await load({ [key]: "allow" }, { options: { auditDir: dir } })
    await run({ action, resources, effect: "ask", metadata: { anything: 1 } })
    expect(readEntries(dir)).toMatchObject([{ by: "judge", action, resources, effect: "allow", judge: "table" }])
  })
})

describe("non-shell requests", () => {
  test("never receive a command line, even when a shell call shares their source id", async () => {
    const { run, toolHooks } = await load({ "https://example.com": "allow" })
    toolHooks["execute.before"]!({ tool: "shell", id: "call-1", input: { command: "curl x" } })
    await run({
      action: "webfetch",
      resources: ["https://example.com"],
      effect: "ask",
      source: { type: "tool", messageID: "m", id: "call-1" },
    })
    expect(seen[0]!.request.line).toBeUndefined()
  })

  test("the size cap applies to their resources", async () => {
    const { run } = await load({ "https://example.com/long": "allow" }, { options: { context: { maxCommandChars: 10 } } })
    const result = await run({ action: "webfetch", resources: ["https://example.com/long"], effect: "ask" })
    expect(result.effect).toBe("ask")
    expect(result.message).toContain("this request because it is longer than 10 characters")
    expect(seen).toEqual([])
  })

  test("repeated denies turn into an ask and call them requests", async () => {
    const { run } = await load({ "https://bad.example": "deny" }, { options: { escalation: { consecutiveDenies: 2 } } })
    const event = { action: "webfetch", resources: ["https://bad.example"], effect: "ask" as const }
    expect((await run(event)).effect).toBe("deny")
    const second = await run(event)
    expect(second.effect).toBe("ask")
    expect(second.message).toContain("2 requests in a row")
  })
})

describe("plugin setup", () => {
  const setup = (options: Record<string, unknown>) => plugin.setup({ options } as never)

  test("refuses to load without the required judge options, naming them", async () => {
    await expect(setup({})).rejects.toThrow(
      "opencode-unattended: missing required options: judge.model, judge.baseURL",
    )
  })

  test("refuses a misspelled option", async () => {
    await expect(setup({ judge: { apiStyle: "table", table: {} }, denyStreak: 2 })).rejects.toThrow(
      "opencode-unattended: unknown options: denyStreak",
    )
  })

  test("refuses an unregistered API style", async () => {
    await expect(setup({ judge: { apiStyle: "nope" } })).rejects.toThrow('Unknown judge.apiStyle "nope"')
  })
})

describe("plugin telemetry", () => {
  const logDir = () => join(mkdtempSync(join(tmpdir(), "unattended-")), "nested")

  test("records what the config decided and what the judge decided, tagged with the directory", async () => {
    const dir = logDir()
    const { run } = await load({ ls: "allow" }, { options: { auditDir: dir } })
    await run({ action: "shell", resources: ["ls"], effect: "ask" })
    await run({ action: "shell", resources: ["pwd"], effect: "allow" })
    await run({ action: "edit", resources: ["a.txt"], effect: "allow" })
    await run({ action: "shell", resources: ["rm"], effect: "deny" })

    const log = readEntries(dir)
    expect(log.map((e) => [e.by, e.action, e.resources, e.effect])).toEqual([
      ["judge", "shell", ["ls"], "allow"],
      ["config", "shell", [], "allow"],
      ["config", "edit", [], "allow"],
    ])
    expect(log.every((e) => e.directory === "/work/app" && e.sessionID === "s")).toBe(true)
    expect(log[0]).toMatchObject({ judge: "table" })
    expect(log[1]).not.toHaveProperty("judge")
  })

  test("a judge failure is logged as a plugin ask and the prompt says why", async () => {
    const dir = logDir()
    const { run } = await load({}, { options: { auditDir: dir } })
    const result = await run({ action: "shell", resources: ["anything"], effect: "ask" })
    expect(result.effect).toBe("ask")
    expect(result.message).toContain("could not review this command")
    expect(readEntries(dir)).toMatchObject([{ by: "plugin", reason: "error", effect: "ask", error: "unknown" }])
  })

  test("removes monthly files older than the retention window when it loads", async () => {
    const dir = logDir()
    await load({}, { options: { auditDir: dir } })
    writeFileSync(join(dir, "audit-2020-01.jsonl"), "")
    const recent = join(dir, "audit-2999-01.jsonl")
    writeFileSync(recent, "")
    await load({}, { options: { auditDir: dir } })
    expect(existsSync(join(dir, "audit-2020-01.jsonl"))).toBe(false)
    expect(existsSync(recent)).toBe(true)
  })
})
