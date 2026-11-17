import type { AuditEntry, JudgedEntry } from "./audit.ts"
import type { Chain, Judge } from "./judge.ts"
import type { Memory } from "./memory.ts"
import type { Verdict } from "./verdict.ts"

export interface Review {
  decision: Verdict
  message?: string
}

export interface ApproverOptions {
  judge: Judge
  memory: Memory
  audit?: (entry: AuditEntry) => void
  /** Longer commands are never truncated or judged; they go to the user. */
  maxCommandChars?: number
  /** After this many judge denies in a row in one session, further denies become asks. */
  denyStreak?: number
}

export function createApprover({ judge, memory, audit, maxCommandChars = 8000, denyStreak = 3 }: ApproverOptions) {
  const streaks = new Map<string, number>()

  return {
    async review(sessionID: string, chain: Chain, userMessages: readonly string[] = []): Promise<Review> {
      if (chain.commands.length === 0) return { decision: "ask" }
      const command = chain.line ?? chain.commands.join(" ; ")
      const write = (outcome: JudgedEntry["outcome"], decision: Verdict, extra: Partial<JudgedEntry> = {}) =>
        audit?.({
          kind: "judged",
          time: Date.now(),
          judge: judge.id,
          sessionID,
          command,
          commands: chain.commands,
          outcome,
          decision,
          ...extra,
        })

      if (command.length > maxCommandChars) {
        write("too_long", "ask")
        return {
          decision: "ask",
          message: `opencode-unattended did not review this command because it is longer than ${maxCommandChars} characters.`,
        }
      }

      const started = Date.now()
      let verdict: Verdict
      try {
        verdict = await judge.decide(chain, { ...memory.context(sessionID), messages: userMessages })
      } catch (error) {
        write("error", "ask", { latencyMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) })
        return { decision: "ask" }
      }
      const latencyMs = Date.now() - started

      if (verdict !== "deny") {
        streaks.set(sessionID, 0)
        write(verdict, verdict, { latencyMs })
        return { decision: verdict }
      }

      const streak = (streaks.get(sessionID) ?? 0) + 1
      streaks.set(sessionID, streak)
      if (streak >= denyStreak) {
        write("deny_streak", "ask", { latencyMs })
        return {
          decision: "ask",
          message: `opencode-unattended denied ${streak} commands in a row, so it is asking you instead: ${JSON.stringify(command)}`,
        }
      }
      write("deny", "deny", { latencyMs })
      return {
        decision: "deny",
        message: `Blocked by opencode-unattended: ${JSON.stringify(command)} looks destructive or irreversible. Use a safer approach or ask the user to run it.`,
      }
    },
  }
}
