import { describe, expect, test } from "bun:test"
import { recentToolCalls } from "../src/calls.ts"

const tool = (name: string, input: unknown, status = "completed", extra: Record<string, unknown> = {}, id = `id-${name}-${Math.random()}`) => ({
  type: "tool",
  id,
  name,
  state: { status, input, ...extra },
})
const assistant = (...content: unknown[]) => ({ type: "assistant", content })

describe("recentToolCalls", () => {
  test("keeps every kind of tool, oldest first, with the command of a shell call and the JSON of anything else", () => {
    const messages = [
      assistant(tool("shell", { command: "ls -la" }), tool("write", { path: "a.py", content: "print(1)" })),
      assistant(tool("webfetch", { url: "https://example.com" }), tool("grep", { pattern: "TODO" })),
    ]
    expect(recentToolCalls(messages, undefined, 10, 1000)).toEqual([
      { tool: "shell", input: "ls -la", status: "completed" },
      { tool: "write", input: '{"path":"a.py","content":"print(1)"}', status: "completed" },
      { tool: "webfetch", input: '{"url":"https://example.com"}', status: "completed" },
      { tool: "grep", input: '{"pattern":"TODO"}', status: "completed" },
    ])
  })

  test("keeps real newlines in a shell command, so a heredoc stays readable", () => {
    const command = "cat > x.py <<'EOF'\nprint(1)\nEOF"
    expect(recentToolCalls([assistant(tool("shell", { command }))], undefined, 10, 1000)[0]!.input).toBe(command)
  })

  test("keeps only the last N calls", () => {
    const messages = [assistant(tool("shell", { command: "a" }), tool("shell", { command: "b" })), assistant(tool("shell", { command: "c" }))]
    expect(recentToolCalls(messages, undefined, 2, 1000).map((c) => c.input)).toEqual(["b", "c"])
    expect(recentToolCalls(messages, undefined, 0, 1000)).toEqual([])
  })

  test("truncates each call with an ellipsis", () => {
    const [call] = recentToolCalls([assistant(tool("shell", { command: "x".repeat(50) }))], undefined, 10, 10)
    expect(call!.input).toBe("xxxxxxxxxx…")
  })

  test("a call that was turned back is rejected, and other failures are errors", () => {
    const messages = [
      assistant(
        tool("shell", { command: "rm -rf /" }, "error", { error: { type: "permission.rejected", message: "Blocked: do not do this" } }),
        tool("shell", { command: "false" }, "error", { error: { type: "tool.execution", message: "exit 1" } }),
        tool("shell", { command: "true" }),
      ),
    ]
    expect(recentToolCalls(messages, undefined, 10, 1000).map((c) => c.status)).toEqual(["rejected", "error", "completed"])
  })

  test("leaves out calls that are still running and the call being judged", () => {
    const messages = [
      assistant(
        tool("shell", { command: "earlier" }),
        tool("shell", { command: "running" }, "running"),
        tool("shell", { command: "this one" }, "completed", {}, "call-now"),
      ),
    ]
    expect(recentToolCalls(messages, "call-now", 10, 1000).map((c) => c.input)).toEqual(["earlier"])
  })

  test("never carries a tool's output or the text of an error", () => {
    const messages = [
      assistant(tool("shell", { command: "cat notes" }, "completed", { content: [{ text: "SECRET OUTPUT" }], output: "SECRET OUTPUT" })),
      assistant(tool("shell", { command: "x" }, "error", { error: { type: "permission.rejected", message: "SECRET MESSAGE" } })),
    ]
    expect(JSON.stringify(recentToolCalls(messages, undefined, 10, 1000))).not.toContain("SECRET")
  })

  test("skips what is not a tool call, and tolerates odd input", () => {
    const messages = [
      null,
      "text",
      { type: "user", text: "hi" },
      { type: "assistant" },
      assistant({ type: "reasoning", text: "thinking" }, null, tool("custom", undefined), { type: "tool", state: { status: "completed" } }),
    ]
    expect(recentToolCalls(messages, undefined, 10, 1000)).toEqual([{ tool: "custom", input: "", status: "completed" }])
  })
})
