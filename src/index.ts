import { appendFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { Plugin } from "@opencode/plugin"
import { createApprover } from "./approver.ts"
import type { AuditEntry } from "./audit.ts"
import { createJudge } from "./judge.ts"
import "./judges/openai-compatible.ts"
import { createMemory } from "./memory.ts"
import { lastUserMessages } from "./messages.ts"

export const DEFAULT_AUDIT_LOG = join(homedir(), ".local", "state", "opencode-unattended", "audit.jsonl")
const MAX_TRACKED_LINES = 100

function auditWriter(path: string | false): ((entry: AuditEntry) => void) | undefined {
  if (path === false) return undefined
  mkdirSync(dirname(path), { recursive: true })
  return (entry) => {
    try {
      appendFileSync(path, JSON.stringify(entry) + "\n")
    } catch {}
  }
}

export default Plugin.define({
  id: "unattended",
  async setup(ctx) {
    const {
      judge: judgeName = "openai-compatible",
      judgeOptions = {},
      contextSize = 10,
      userMessages = 5,
      userMessageChars = 500,
      maxCommandChars = 8000,
      denyStreak = 3,
      auditLog,
    } = ctx.options

    const write = auditWriter(auditLog === false ? false : (auditLog ?? DEFAULT_AUDIT_LOG))
    const where = { directory: ctx.location.directory, project: ctx.location.project?.id }
    const audit = write && ((entry: AuditEntry) => write({ ...entry, ...where }))

    const memory = createMemory(contextSize)
    const approver = createApprover({
      judge: createJudge(judgeName, judgeOptions),
      memory,
      audit,
      maxCommandChars,
      denyStreak,
    })

    const lines = new Map<string, string>()
    const registrations = [
      await ctx.permission.hook("evaluate", async (event) => {
        if (event.effect === "deny") return
        if (event.action !== "shell" || event.effect !== "ask") {
          audit?.({ kind: "passthrough", time: Date.now(), sessionID: event.sessionID, action: event.action, configEffect: event.effect })
          return
        }
        const line = event.source ? lines.get(event.source.id) : undefined
        const messages = await ctx.session
          .context({ sessionID: event.sessionID })
          .then((all) => lastUserMessages(all, userMessages, userMessageChars), () => [])
        const review = await approver.review(event.sessionID, { commands: event.resources, line }, messages)
        if (review.decision === "ask" && !review.message) return
        event.effect = review.decision
        if (review.message) event.message = review.message
      }),
      await ctx.tool.hook("execute.before", (event) => {
        const command = (event.input as { command?: unknown } | null)?.command
        if (event.tool !== "shell" || typeof command !== "string") return
        lines.set(event.id, command)
        if (lines.size > MAX_TRACKED_LINES) lines.delete(lines.keys().next().value!)
      }),
      await ctx.tool.hook("execute.after", (event) => {
        const command = (event.input as { command?: unknown } | null)?.command
        if (event.tool === "shell" && typeof command === "string") {
          memory.recordRun(event.sessionID, command, event.status === "completed" ? "completed" : "error")
        }
      }),
    ]

    return async () => {
      await Promise.all(registrations.map((r) => r.dispose()))
    }
  },
})
