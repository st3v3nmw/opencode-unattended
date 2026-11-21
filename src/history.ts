const PAGE = 50
const MAX_SESSIONS = 200
const PARALLEL = 5

interface SessionRef {
  id: string
  time: { updated: number }
}

/** The part of the host's session API this reads. */
export interface SessionReader {
  list(input: { limit?: number; order?: "asc" | "desc"; cursor?: string }): Promise<{ data: SessionRef[]; cursor: { next?: string | null } }>
  context(input: { sessionID: string }): Promise<readonly unknown[]>
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

export function shellCommands(messages: readonly unknown[], since: number): string[] {
  const out: string[] = []
  for (const message of messages) {
    if (!isRecord(message) || message.type !== "assistant" || !Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (!isRecord(part) || part.type !== "tool" || (part.name !== "shell" && part.name !== "bash")) continue
      const created = isRecord(part.time) ? part.time.created : undefined
      const input = isRecord(part.state) ? part.state.input : undefined
      const command = isRecord(input) ? input.command : undefined
      if (typeof command === "string" && typeof created === "number" && created >= since) out.push(command)
    }
  }
  return out
}

/** The shell command lines the agent ran since `since`, from the most recent sessions. Unreadable sessions are skipped. */
export async function recentCommands(sessions: SessionReader, since: number): Promise<string[]> {
  const ids: string[] = []
  let cursor: string | undefined
  scan: while (ids.length < MAX_SESSIONS) {
    const page = await sessions.list({ limit: PAGE, order: "desc", ...(cursor ? { cursor } : {}) })
    for (const session of page.data) {
      if (session.time.updated < since) break scan
      ids.push(session.id)
    }
    if (!page.cursor.next) break
    cursor = page.cursor.next
  }

  const commands: string[] = []
  for (let i = 0; i < ids.length; i += PARALLEL) {
    const batch = await Promise.all(
      ids.slice(i, i + PARALLEL).map((sessionID) =>
        sessions.context({ sessionID }).then(
          (messages) => shellCommands(messages, since),
          () => [],
        ),
      ),
    )
    commands.push(...batch.flat())
  }
  return commands
}
