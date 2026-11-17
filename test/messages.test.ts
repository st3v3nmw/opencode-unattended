import { describe, expect, test } from "bun:test"
import { lastUserMessages } from "../src/messages.ts"

const msgs = [
  { type: "user", text: "first" },
  { type: "assistant" },
  { type: "synthetic", text: "not from the user" },
  { type: "user", text: "   " },
  { type: "user", text: "second" },
  { type: "user", text: "third" },
  { type: "user", text: "x".repeat(50) },
]

describe("lastUserMessages", () => {
  test("keeps only the last N non-empty user messages, oldest first", () => {
    expect(lastUserMessages(msgs, 2, 100)).toEqual(["third", "x".repeat(50)])
    expect(lastUserMessages(msgs.slice(0, 5), 5, 100)).toEqual(["first", "second"])
  })

  test("clips long messages with an ellipsis", () => {
    expect(lastUserMessages(msgs, 1, 10)).toEqual(["xxxxxxxxxx…"])
  })

  test("returns nothing when disabled or when there are no user messages", () => {
    expect(lastUserMessages(msgs, 0, 100)).toEqual([])
    expect(lastUserMessages([{ type: "assistant" }], 3, 100)).toEqual([])
  })
})
