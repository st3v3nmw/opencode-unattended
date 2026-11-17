import type { JudgeContext } from "./judge.ts"
import { clip } from "./messages.ts"

const MAX_COMMAND_CHARS = 300

export function createMemory(size: number) {
  const sessions = new Map<string, JudgeContext["recent"][number][]>()

  return {
    recordRun(sessionID: string, command: string, status: "completed" | "error") {
      const recent = sessions.get(sessionID) ?? []
      sessions.set(sessionID, recent)
      recent.push({ command: clip(command, MAX_COMMAND_CHARS), status })
      if (recent.length > size) recent.shift()
    },
    context(sessionID: string): Pick<JudgeContext, "recent"> {
      return { recent: [...(sessions.get(sessionID) ?? [])] }
    },
  }
}

export type Memory = ReturnType<typeof createMemory>
