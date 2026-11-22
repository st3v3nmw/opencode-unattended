import { Plugin } from "@opencode/plugin"
import { createApprover } from "./approver.ts"
import type { ApproverEntry } from "./audit.ts"
import { createWriter, prune, readEntries } from "./auditlog.ts"
import { recentCommands } from "./history.ts"
import { createJudge, type Judge, type Request } from "./judge.ts"
import "./judges/openai.ts"
import { recentToolCalls } from "./calls.ts"
import { MAX_TRACKED, RECENT_TOOL_CALLS, RECENT_TOOL_CALL_CHARS, USER_MESSAGES, USER_MESSAGE_CHARS } from "./limits.ts"
import { lastUserMessages } from "./messages.ts"
import { parseOptions, type Settings } from "./options.ts"
import { SUGGEST_SKILL } from "./suggest-skill.ts"
import { suggestTool } from "./suggest-tool.ts"

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
    const { escalateAfter, dataDir, auditLog } = settings

    let audit: ((entry: ApproverEntry) => void) | undefined
    if (auditLog.enabled) {
      prune(dataDir)
      const write = createWriter(dataDir)
      audit = (entry) => write({ ...entry, directory: ctx.location.directory })
    }

    const approver = createApprover({
      judge,
      audit,
      consecutiveLimit: escalateAfter,
      denyLimit: escalateAfter,
    })

    const lines = new Map<string, string>()
    const asked = new Map<string, { sessionID: string; request: Request }>()
    const remember = <T>(map: Map<string, T>, id: string, value: T) => {
      map.set(id, value)
      if (map.size > MAX_TRACKED) map.delete(map.keys().next().value!)
    }
    const registrations: { dispose: () => Promise<void> }[] = [
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
        const context = await ctx.session.context({ sessionID: event.sessionID }).then(
          (all) => ({
            messages: lastUserMessages(all, USER_MESSAGES, USER_MESSAGE_CHARS),
            recent: recentToolCalls(all, event.source?.id, RECENT_TOOL_CALLS, RECENT_TOOL_CALL_CHARS),
          }),
          () => ({ messages: [], recent: [] }),
        )
        const review = await approver.review(event.sessionID, { action: event.action, resources: event.resources, line }, context)
        if (review.decision === "ask" && event.source) {
          remember(asked, event.source.id, { sessionID: event.sessionID, request: { action: event.action, resources: event.resources, line } })
        }
        if (review.decision === "ask" && !review.message) return
        event.effect = review.decision
        if (review.message) event.message = review.message
      }),
      await ctx.tool.hook("execute.before", (event) => {
        const approved = asked.get(event.id)
        if (approved) {
          asked.delete(event.id)
          approver.forget(approved.sessionID, approved.request)
        }
        const command = (event.input as { command?: unknown } | null)?.command
        if (event.tool !== "shell" || typeof command !== "string") return
        remember(lines, event.id, command)
      }),
    ]

    if (auditLog.enabled) {
      const tool = suggestTool({
        entries: (since) => readEntries(dataDir, { since }),
        commands: (since) => recentCommands(ctx.session, since),
      })
      registrations.push(
        await ctx.tool.transform((editor) => editor.add(tool)),
        await ctx.skill.transform((editor) => editor.add(SUGGEST_SKILL as Parameters<typeof editor.add>[0])),
      )
    }

    return async () => {
      await Promise.all(registrations.map((r) => r.dispose()))
    }
  },
})
