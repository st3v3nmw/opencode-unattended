import type { RecentCall } from "./judge.ts"
import { truncate } from "./messages.ts"

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

const REJECTED = "permission.rejected"

function render(input: unknown): string {
  if (isRecord(input) && typeof input.command === "string") return input.command
  return JSON.stringify(input) ?? ""
}

/**
 * The agent's last `count` finished tool calls, oldest first, from the messages of a session. Calls still running are left
 * out, and so is `exceptID`, the call being judged. A call that was turned back is `rejected`. Tool outputs are never read.
 */
export function recentToolCalls(messages: readonly unknown[], exceptID: string | undefined, count: number, maxChars: number): RecentCall[] {
  if (count <= 0) return []
  const calls: RecentCall[] = []
  for (const message of messages) {
    if (!isRecord(message) || message.type !== "assistant" || !Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (!isRecord(part) || part.type !== "tool" || typeof part.name !== "string" || part.id === exceptID) continue
      const state = isRecord(part.state) ? part.state : undefined
      if (state?.status !== "completed" && state?.status !== "error") continue
      const rejected = state.status === "error" && isRecord(state.error) && state.error.type === REJECTED
      calls.push({
        tool: part.name,
        input: truncate(render(state.input), maxChars),
        status: rejected ? "rejected" : state.status,
      })
    }
  }
  return calls.slice(-count)
}
