import { Database } from "bun:sqlite"
import { homedir } from "node:os"
import { join } from "node:path"
import { shellCommands } from "./history.ts"

export const DEFAULT_DB = join(homedir(), ".local", "share", "opencode", "opencode.db")

const TOOL_PARTS = `
  select p.value as part
  from session_message m, json_each(m.data, '$.content') p
  where m.type = 'assistant'
    and m.time_created >= ?
    and json_extract(p.value, '$.type') = 'tool'
    and json_extract(p.value, '$.name') in ('shell', 'bash')`

export interface History {
  commands: string[]
  /** Set when the history could not be read, so the caller can say the result is based on the audit log alone. */
  error?: string
}

/**
 * The shell command lines the agent ran since `since`, read straight from opencode's database without writing to it.
 * The schema belongs to opencode, so anything unexpected is reported rather than thrown.
 */
export function readHistory(path: string, since: number): History {
  let db: Database | undefined
  try {
    db = new Database(path, { readonly: true })
    const rows = db.query(TOOL_PARTS).all(since) as { part: string }[]
    const commands = rows.flatMap(({ part }) => shellCommands([{ type: "assistant", content: [JSON.parse(part)] }], since))
    return { commands }
  } catch (error) {
    return { commands: [], error: `cannot read history from ${path}: ${error instanceof Error ? error.message : String(error)}` }
  } finally {
    db?.close()
  }
}
