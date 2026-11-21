import { describe, expect, test } from "bun:test"
import { isSpecific, lastMatch, matches } from "../src/rules.ts"

describe("matches", () => {
  test.each([
    ["git status *", "git status --short", true],
    ["git status *", "git status", true],
    ["git status *", "git statusx", false],
    ["git *", "git diff a/b.ts", true],
    ["*.env", "cat prod.env", true],
    ["*.env", "cat prod.env.bak", false],
    ["ls?", "lsx", true],
    ["ls?", "ls", false],
    ["a.b", "axb", false],
    ["x [1]", "x [1]", true],
    ["cat *", "cat a\nb", true],
  ])("%p against %p is %p", (pattern, text, expected) => {
    expect(matches(pattern, text)).toBe(expected)
  })
})

describe("lastMatch", () => {
  const rules = [
    { resource: "*", effect: "ask" as const },
    { resource: "git *", effect: "allow" as const },
    { resource: "git push *", effect: "deny" as const },
  ]

  test("the last matching rule wins", () => {
    expect(lastMatch(rules, "git push origin")).toBe(rules[2])
    expect(lastMatch(rules, "git status")).toBe(rules[1])
    expect(lastMatch(rules, "make")).toBe(rules[0])
    expect(lastMatch([], "make")).toBeUndefined()
  })

  test("only the bare * is a catch-all", () => {
    expect(rules.map(isSpecific)).toEqual([false, true, true])
  })
})
