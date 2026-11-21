import { describe, expect, test } from "bun:test"
import { parseDuration } from "../src/duration.ts"

describe("parseDuration", () => {
  test.each([
    ["250ms", 250],
    ["15s", 15_000],
    ["5m", 300_000],
    ["1h", 3_600_000],
    ["2d", 172_800_000],
    ["1w", 604_800_000],
    [" 30s ", 30_000],
    ["0s", 0],
  ])("reads %p as %p ms", (text, ms) => {
    expect(parseDuration(text)).toBe(ms)
  })

  test.each([[""], ["15"], ["s"], ["1.5h"], ["-5m"], ["5 m"], ["5x"], ["1h30m"], ["soon"]])("rejects %p", (text) => {
    expect(parseDuration(text)).toBeUndefined()
  })
})
