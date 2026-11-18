import type { ApproverEntry, Reason } from "./audit.ts"
import { JudgeNotConfigured, type Judge, type Request } from "./judge.ts"
import type { Memory } from "./memory.ts"
import type { Verdict } from "./verdict.ts"

export interface Review {
  decision: Verdict
  message?: string
}

export interface ApproverOptions {
  judge: Judge
  memory: Memory
  audit?: (entry: ApproverEntry) => void
  /** Longer requests are never truncated or judged; they go to the user. */
  maxCommandChars?: number
  /** After this many judge denies in a row in one session, further denies become asks. */
  denyStreak?: number
}

const MAX_ERROR_CHARS = 200

/** A request whose resources are empty or all `*` tells the judge nothing, so there is nothing to judge. */
const hasDetail = (resources: readonly string[]) => resources.some((r) => r.trim() !== "" && r.trim() !== "*")

export function createApprover({ judge, memory, audit, maxCommandChars = 8000, denyStreak = 3 }: ApproverOptions) {
  const streaks = new Map<string, number>()

  return {
    async review(sessionID: string, request: Request, userMessages: readonly string[] = []): Promise<Review> {
      const shell = request.action === "shell"
      const noun = shell ? "command" : "request"
      const write = (effect: Verdict, extra: Partial<ApproverEntry>) =>
        audit?.({
          time: Date.now(),
          sessionID,
          action: request.action,
          resources: request.resources,
          effect,
          by: "judge",
          ...extra,
        })
      const plugin = (reason: Reason, extra: Partial<ApproverEntry> = {}) =>
        write("ask", { by: "plugin", reason, ...extra })

      if (!hasDetail(request.resources)) {
        plugin("unparsed")
        return { decision: "ask" }
      }
      const text = request.line ?? request.resources.join(" ; ")
      const subject = shell ? JSON.stringify(text) : `${request.action} ${JSON.stringify(text)}`

      if (text.length > maxCommandChars) {
        plugin("too_long")
        return {
          decision: "ask",
          message: `opencode-unattended did not review this ${noun} because it is longer than ${maxCommandChars} characters.`,
        }
      }

      const started = Date.now()
      const consulted = { judge: judge.id, ...(judge.provider ? { provider: judge.provider } : {}) }
      let verdict: Verdict
      try {
        verdict = await judge.decide(request, { ...memory.context(sessionID), messages: userMessages })
      } catch (error) {
        const reason = (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_CHARS)
        if (error instanceof JudgeNotConfigured) plugin("unconfigured")
        else plugin("error", { ...consulted, latency: Date.now() - started, error: reason })
        return { decision: "ask", message: `opencode-unattended could not review this ${noun}, so it is asking you: ${reason}` }
      }
      const latency = Date.now() - started

      if (verdict !== "deny") {
        streaks.set(sessionID, 0)
        write(verdict, { ...consulted, latency })
        return { decision: verdict }
      }

      const streak = (streaks.get(sessionID) ?? 0) + 1
      streaks.set(sessionID, streak)
      if (streak >= denyStreak) {
        plugin("deny_streak", { ...consulted, latency })
        return {
          decision: "ask",
          message: `opencode-unattended denied ${streak} ${noun}s in a row, so it is asking you instead: ${subject}`,
        }
      }
      write("deny", { ...consulted, latency })
      return {
        decision: "deny",
        message: shell
          ? `Blocked by opencode-unattended: ${subject} looks destructive or irreversible. Use a safer approach or ask the user to run it.`
          : `Blocked by opencode-unattended: ${subject} looks unsafe to do unattended. Use a safer approach or ask the user to do it.`,
      }
    },
  }
}
