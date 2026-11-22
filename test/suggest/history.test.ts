import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readHistory, recentCommands, type SessionReader } from "../../src/suggest/history.ts"

const tool = (command: unknown, created = 100, name = "shell") => ({ type: "tool", name, time: { created }, state: { input: { command } } })
const assistant = (...content: unknown[]) => ({ type: "assistant", content })

function reader(sessions: Record<string, { updated: number; messages: unknown[] | Error }>, pageSize = 50) {
  const asked: string[] = []
  const ids = Object.keys(sessions)
  const reader: SessionReader = {
    async list({ cursor }) {
      const from = cursor ? Number(cursor) : 0
      const next = from + pageSize
      return {
        data: ids.slice(from, next).map((id) => ({ id, time: { updated: sessions[id]!.updated } })),
        cursor: { next: next < ids.length ? String(next) : null },
      }
    },
    async context({ sessionID }) {
      asked.push(sessionID)
      const { messages } = sessions[sessionID]!
      if (messages instanceof Error) throw messages
      return messages
    },
  }
  return { reader, asked }
}

describe("recentCommands", () => {
  test("collects shell commands in the window, skipping other tools, odd inputs and older parts", async () => {
    const { reader: sessions } = reader({
      a: {
        updated: 500,
        messages: [
          { type: "user", text: "hi" },
          assistant(tool("make lint"), tool("old", 10), tool("ls", 100, "bash"), tool(7), { type: "text", text: "x" }, { ...tool("edit"), name: "edit" }),
        ],
      },
    })
    expect(await recentCommands(sessions, 50)).toEqual(["make lint", "ls"])
  })

  test("stops at the first session older than the window and follows pages", async () => {
    const { reader: sessions, asked } = reader(
      {
        a: { updated: 900, messages: [assistant(tool("one"))] },
        b: { updated: 800, messages: [assistant(tool("two"))] },
        c: { updated: 10, messages: [assistant(tool("three"))] },
      },
      1,
    )
    expect(await recentCommands(sessions, 50)).toEqual(["one", "two"])
    expect(asked).toEqual(["a", "b"])
  })

  test("skips a session that cannot be read", async () => {
    const { reader: sessions } = reader({
      a: { updated: 900, messages: new Error("gone") },
      b: { updated: 800, messages: [assistant(tool("kept"))] },
    })
    expect(await recentCommands(sessions, 50)).toEqual(["kept"])
  })
})

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
