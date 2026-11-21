import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readHistory } from "../src/history-db.ts"

const tool = (command: unknown, created = 100, name = "shell") => ({ type: "tool", name, time: { created }, state: { input: { command } } })

function database(rows: { type?: string; time?: number; content: unknown[] }[]) {
  const path = join(mkdtempSync(join(tmpdir(), "unattended-db-")), "opencode.db")
  const db = new Database(path)
  db.run("create table session_message (id text primary key, session_id text, type text, seq integer, time_created integer, time_updated integer, data text)")
  rows.forEach((row, i) =>
    db.run("insert into session_message values (?, 's', ?, ?, ?, ?, ?)", [
      `m${i}`,
      row.type ?? "assistant",
      i,
      row.time ?? 200,
      row.time ?? 200,
      JSON.stringify({ time: { created: row.time ?? 200 }, content: row.content }),
    ]),
  )
  db.close()
  return path
}

describe("readHistory", () => {
  test("returns the shell commands the agent ran since the cutoff, skipping other tools and messages", () => {
    const path = database([
      { content: [{ type: "text", text: "hi" }, tool("make lint"), tool("old", 10), { ...tool("edit"), name: "edit" }, tool(7), tool("ls", 150, "bash")] },
      { type: "user", content: [tool("not assistant")] },
      { time: 20, content: [tool("before the window", 300)] },
    ])
    expect(readHistory(path, 50)).toEqual({ commands: ["make lint", "ls"] })
  })

  test("does not change the database", () => {
    const path = database([{ content: [tool("make lint")] }])
    readHistory(path, 0)
    const db = new Database(path, { readonly: true })
    expect(db.query("select count(*) as n from session_message").get()).toEqual({ n: 1 })
    db.close()
  })

  test("says why when the file or its tables are not there", () => {
    expect(readHistory(join(tmpdir(), "unattended-no-such.db"), 0)).toEqual({ commands: [], error: expect.stringContaining("unattended-no-such.db") })
    const path = join(mkdtempSync(join(tmpdir(), "unattended-db-")), "other.db")
    new Database(path).close()
    expect(readHistory(path, 0)).toEqual({ commands: [], error: expect.stringContaining("session_message") })
  })
})
