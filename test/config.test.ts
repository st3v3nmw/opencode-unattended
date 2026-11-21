import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseJsonc, permissionRules, readRules, readShellRules, shellRules } from "../src/config.ts"

describe("parseJsonc", () => {
  test("reads comments and trailing commas", () => {
    const text = `// header
{
  /* block */ "a": [1, 2,], // tail
  "b": { "c": true, },
}`
    expect(parseJsonc(text)).toEqual({ a: [1, 2], b: { c: true } })
  })

  test("leaves comment markers and commas inside strings alone", () => {
    expect(parseJsonc(`{ "url": "https://example.com/*", "s": "a, ]", "q": "say \\"//\\"" }`)).toEqual({
      url: "https://example.com/*",
      s: "a, ]",
      q: 'say "//"',
    })
  })

  test("rejects text that is not JSON", () => {
    expect(() => parseJsonc("{ nope")).toThrow()
  })
})

describe("shellRules", () => {
  test("keeps shell and every-action rules in file order and drops the rest", () => {
    const config = {
      permissions: [
        { action: "*", resource: "*", effect: "ask" },
        { action: "shell", resource: "ls *", effect: "allow" },
        { action: "edit", resource: "*", effect: "allow" },
        { action: "shell", resource: "rm -rf *", effect: "deny" },
        { action: "*", resource: "*.env", effect: "ask" },
      ],
    }
    expect(shellRules(config)).toEqual([
      { resource: "*", effect: "ask" },
      { resource: "ls *", effect: "allow" },
      { resource: "rm -rf *", effect: "deny" },
      { resource: "*.env", effect: "ask" },
    ])
  })

  test("skips malformed entries and tolerates a missing list", () => {
    expect(shellRules({ permissions: [null, { action: "shell" }, { action: "shell", resource: "ls *", effect: "maybe" }] })).toEqual([])
    expect(shellRules({})).toEqual([])
    expect(shellRules(null)).toEqual([])
  })
})

describe("permissionRules", () => {
  test("keeps every well-formed rule with its action, in file order", () => {
    const permissions = [
      { action: "webfetch", resource: "https://a.example.com/*", effect: "allow" },
      { action: "shell", resource: "ls *", effect: "deny" },
      { resource: "x", effect: "allow" },
      { action: "edit", resource: "x", effect: "nope" },
    ]
    expect(permissionRules({ permissions })).toEqual([
      { action: "webfetch", resource: "https://a.example.com/*", effect: "allow" },
      { action: "shell", resource: "ls *", effect: "deny" },
    ])
  })
})

describe("readRules", () => {
  test("reads every action", () => {
    const dir = mkdtempSync(join(tmpdir(), "unattended-config-"))
    const path = join(dir, "c.jsonc")
    writeFileSync(path, `{ "permissions": [{ "action": "websearch", "resource": "*", "effect": "allow" }] }`)
    expect(readRules([path])).toEqual([{ action: "websearch", resource: "*", effect: "allow" }])
  })
})

describe("readShellRules", () => {
  const write = (name: string, text: string) => {
    const dir = mkdtempSync(join(tmpdir(), "unattended-config-"))
    const path = join(dir, name)
    writeFileSync(path, text)
    return path
  }

  test("reads each file in turn, so later files override earlier ones", () => {
    const global = write("a.jsonc", `{ "permissions": [{ "action": "shell", "resource": "ls *", "effect": "allow" },] }`)
    const project = write("b.json", `{ "permissions": [{ "action": "shell", "resource": "ls *", "effect": "deny" }] }`)
    expect(readShellRules([global, project])).toEqual([
      { resource: "ls *", effect: "allow" },
      { resource: "ls *", effect: "deny" },
    ])
  })

  test("names the file that cannot be read", () => {
    expect(() => readShellRules([join(tmpdir(), "unattended-missing.jsonc")])).toThrow("unattended-missing.jsonc")
    expect(() => readShellRules([write("bad.jsonc", "{ nope")])).toThrow("bad.jsonc")
  })
})
