import { Plugin } from "@opencode/plugin"
import { createApprover } from "./approver.ts"
import type { ApproverEntry } from "./audit.ts"
import { createWriter, prune } from "./auditlog.ts"
import { createJudge, type Judge } from "./judge.ts"
import "./judges/openai-compatible.ts"
import { createMemory } from "./memory.ts"
import { lastUserMessages } from "./messages.ts"
import { parseOptions, type Settings } from "./options.ts"

const MAX_TRACKED_LINES = 100

export default Plugin.define({
  id: "unattended",
  async setup(ctx) {
    let settings: Settings
    let judge: Judge
    try {
      settings = parseOptions(ctx.options)
      judge = createJudge(settings.apiStyle, settings.judge)
    } catch (error) {
      throw new Error(`opencode-unattended: ${error instanceof Error ? error.message : String(error)}`)
    }
    const { maxRecentCommands, maxUserMessages, maxUserMessageChars, maxCommandChars, consecutiveDenies, auditDir } = settings

    let audit: ((entry: ApproverEntry) => void) | undefined
    if (auditDir !== false) {
      prune(auditDir)
      const write = createWriter(auditDir)
      audit = (entry) => write({ ...entry, directory: ctx.location.directory })
    }

    const memory = createMemory(maxRecentCommands)
    const approver = createApprover({
      judge,
      memory,
      audit,
      maxCommandChars,
      denyStreak: consecutiveDenies,
    })

    const lines = new Map<string, string>()
    const registrations = [
      await ctx.permission.hook("evaluate", async (event) => {
        if (event.effect === "deny") return
        if (event.effect !== "ask") {
          audit?.({
            time: Date.now(),
            sessionID: event.sessionID,
            action: event.action,
            resources: event.resources,
            effect: event.effect,
            by: "config",
          })
          return
        }
        const line = event.action === "shell" && event.source ? lines.get(event.source.id) : undefined
        const messages = await ctx.session
          .context({ sessionID: event.sessionID })
          .then((all) => lastUserMessages(all, maxUserMessages, maxUserMessageChars), () => [])
        const review = await approver.review(
          event.sessionID,
          { action: event.action, resources: event.resources, line },
          messages,
        )
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
