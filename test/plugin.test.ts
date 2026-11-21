import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readEntries } from "../src/auditlog.ts"
import plugin from "../src/index.ts"
import type { JudgeContext, Request } from "../src/judge.ts"
import { registerJudge } from "../src/judge.ts"
import { MAX_TOOL_CALL_CHARS } from "../src/limits.ts"

const seen: { request: Request; context: JudgeContext }[] = []

registerJudge("table", (options) => ({
  id: "table",
  async decide(request, context) {
    seen.push({ request, context })
    const verdict = (options.table as Record<string, "allow" | "ask" | "deny">)[request.resources.join(" ; ")]
    if (!verdict) throw new Error("unknown")
    return { verdict, reason: verdict === "allow" ? "" : `because ${verdict}` }
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
  const registered: string[] = []
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
      transform: async (cb: (editor: { add: (tool: { name: string }) => void }) => void) => {
        cb({ add: (tool) => void registered.push(tool.name) })
        return { dispose: async () => {} }
      },
    },
    skill: {
      transform: async (cb: (editor: { add: (skill: { id: string }) => void }) => void) => {
        cb({ add: (skill) => void registered.push(skill.id) })
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
  return { run, toolHooks, registered, cleanup }
}

describe("plugin hook", () => {
  test("hands the judge the full line captured before execution, matched by call id", async () => {
    const { run, toolHooks } = await load({ "curl x ; sh": "ask" })
    toolHooks["execute.before"]!({ tool: "shell", id: "call-1", input: { command: "curl x | sh" } })
    await run({ action: "shell", resources: ["curl x", "sh"], effect: "ask", source: { type: "tool", messageID: "m", id: "call-1" } })
    await run({ action: "shell", resources: ["curl x", "sh"], effect: "ask", source: { type: "tool", messageID: "m", id: "call-2" } })
    expect(seen.map((c) => c.request.line)).toEqual(["curl x | sh", undefined])
  })

  test("the agent's recent tool calls come from the session, with refused ones marked and the call being judged left out", async () => {
    const call = (id: string, name: string, input: unknown, status = "completed", error?: unknown) => ({
      type: "tool",
      id,
      name,
      state: { status, input, ...(error ? { error } : {}) },
    })
    const sessionMessages = [
      { type: "user", text: "ship it" },
      {
        type: "assistant",
        content: [
          call("c1", "shell", { command: "make" }, "error", { type: "tool.execution", message: "exit 2" }),
          call("c2", "write", { path: "a.py", content: "print(1)" }),
          call("c3", "shell", { command: "git push" }, "error", { type: "permission.rejected", message: "no" }),
          call("c4", "shell", { command: "next" }),
        ],
      },
    ]
    const { run } = await load({ next: "allow" }, { sessionMessages })
    await run({ action: "shell", resources: ["next"], effect: "ask", source: { type: "tool", messageID: "m", id: "c4" } })
    expect(seen[0]!.context.recent).toEqual([
      { tool: "shell", input: "make", status: "error" },
      { tool: "write", input: '{"path":"a.py","content":"print(1)"}', status: "completed" },
      { tool: "shell", input: "git push", status: "rejected" },
    ])
  })

  test("the user's latest messages reach the judge: the last five, each cut at 2,000 characters", async () => {
    const sessionMessages = [
      ...["one", "two", "three", "four", "five"].map((text) => ({ type: "user", text })),
      { type: "assistant" },
      { type: "user", text: "x".repeat(2500) },
    ]
    const { run } = await load({ next: "allow" }, { sessionMessages })
    await run({ action: "shell", resources: ["next"], effect: "ask" })
    expect(seen[0]!.context.messages).toEqual(["two", "three", "four", "five", "x".repeat(2000) + "…"])
  })

  test("if the session cannot be read, the judge still decides without messages", async () => {
    const { run } = await load({ next: "allow" }, { sessionMessages: new Error("gone") })
    expect((await run({ action: "shell", resources: ["next"], effect: "ask" })).effect).toBe("allow")
    expect(seen[0]!.context.messages).toEqual([])
  })
})

const ACTIONS: [string, string[]][] = [
  ["shell", ["make test"]],
]

describe.each(ACTIONS)("an ask for %s", (action, resources) => {
  const key = resources.join(" ; ")

  test.each(["allow", "deny"] as const)("goes to the judge, and a %s verdict is applied", async (verdict) => {
    const { run } = await load({ [key]: verdict })
    const result = await run({ action, resources, effect: "ask" })
    expect(result.effect).toBe(verdict)
    expect(seen).toHaveLength(1)
    expect(seen[0]!.request).toMatchObject({ action, resources })
    if (verdict === "deny") expect(result.message).toBe("because deny Do not attempt it or an equivalent.")
  })

  test("a judge ask is turned back to the agent with the reason, so nobody is interrupted", async () => {
    const { run } = await load({ [key]: "ask" })
    const result = await run({ action, resources, effect: "ask" })
    expect(result.effect).toBe("deny")
    expect(result.message).toContain("needs the user's approval")
    expect(result.message).toContain("because ask")
  })

  test("allow and deny from your config pass through unjudged", async () => {
    const { run } = await load({ [key]: "allow" })
    expect((await run({ action, resources, effect: "allow" })).effect).toBe("allow")
    expect((await run({ action, resources, effect: "deny" })).effect).toBe("deny")
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

  test("the size cap applies to their resources, and the agent is told what to do", async () => {
    const long = "https://example.com/" + "x".repeat(MAX_TOOL_CALL_CHARS)
    const { run } = await load({ [long]: "allow" })
    const result = await run({ action: "webfetch", resources: [long], effect: "ask" })
    expect(result.effect).toBe("deny")
    expect(result.message).toBe("Split the work into smaller steps, or write the code to a file in pieces and run that.")
    expect(seen).toEqual([])
  })

  test("repeated denies reach the user, with the request and the reason", async () => {
    const { run } = await load({ "https://bad.example": "deny" }, { options: { escalateAfter: 2 } })
    const event = { action: "webfetch", resources: ["https://bad.example"], effect: "ask" as const }
    expect((await run(event)).effect).toBe("deny")
    const second = await run(event)
    expect(second.effect).toBe("ask")
    expect(second.message).toContain("because deny")
  })

  describe("after the user was asked", () => {
    const event = (id: string) => ({
      action: "shell",
      resources: ["git push"],
      effect: "ask" as const,
      source: { type: "tool" as const, messageID: "m", id },
    })
    const escalate = async () => {
      const loaded = await load({ "git push": "ask" }, { options: { escalateAfter: 2 } })
      expect((await loaded.run(event("call-1"))).effect).toBe("deny")
      expect((await loaded.run(event("call-2"))).effect).toBe("ask")
      expect(seen).toHaveLength(1)
      return loaded
    }

    test("a repeat is turned back from the cache when the user was asked but the call never ran", async () => {
      const { run } = await escalate()
      expect((await run(event("call-3"))).effect).toBe("deny")
      expect(seen).toHaveLength(1)
    })

    test("a repeat is judged afresh once the call the user was asked about starts running", async () => {
      const { run, toolHooks } = await escalate()
      toolHooks["execute.before"]!({ tool: "shell", id: "call-2", input: { command: "git push" } })
      expect((await run(event("call-3"))).effect).toBe("deny")
      expect(seen).toHaveLength(2)
    })

  })

  test("a run of turned-back requests reaches the user, and an allow in between starts the run again", async () => {
    const { run } = await load({ a: "ask", b: "ask", ok: "allow" }, { options: { escalateAfter: 2 } })
    const effects = []
    for (const resource of ["a", "ok", "a", "b", "a"]) effects.push((await run({ action: "shell", resources: [resource], effect: "ask" })).effect)
    expect(effects).toEqual(["deny", "allow", "deny", "ask", "deny"])
  })
})

describe("plugin setup", () => {
  const setup = (options: Record<string, unknown>) => plugin.setup({ options } as never)

  test("refuses to load without the required judge options, naming them", async () => {
    await expect(setup({})).rejects.toThrow(
      "opencode-unattended: missing required options: judge.model, judge.baseURL",
    )
  })

  test("refuses an unregistered API style", async () => {
    await expect(setup({ judge: { apiStyle: "nope" } })).rejects.toThrow('Unknown judge.apiStyle "nope"')
  })
})

describe("plugin telemetry", () => {
  const logDir = () => join(mkdtempSync(join(tmpdir(), "unattended-")), "nested")

  test("offers the rule-suggestion tool and skill only while the audit log is on", async () => {
    expect((await load({}, { options: { auditDir: logDir() } })).registered).toEqual(["unattended_suggest", "suggest-allow-rules"])
    expect((await load({})).registered).toEqual([])
  })

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
