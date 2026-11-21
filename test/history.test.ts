import { describe, expect, test } from "bun:test"
import { recentCommands, type SessionReader } from "../src/history.ts"

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
