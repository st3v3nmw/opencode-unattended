import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, readdirSync, readlinkSync, statSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { createWriter, monthFile, prune, readEntries, sanitize, type AuditEntry } from "../../src/audit/audit.ts"

const at = (iso: string) => Date.parse(iso)

const entry = (over: Partial<AuditEntry> = {}): AuditEntry => ({
  time: at("2026-11-17T07:00:00Z"),
  sessionID: "s",
  directory: "/work/app",
  action: "shell",
  resources: ["ls"],
  effect: "allow",
  by: "judge",
  ...over,
})

const tempDir = () => mkdtempSync(join(tmpdir(), "unattended-log-"))

describe("sanitize", () => {
  const home = homedir()

  test("turns the home directory into ~ in the directory and every resource", () => {
    const result = sanitize(entry({ directory: `${home}/Projects/app`, resources: [`cat ${home}/x`, `ls ${home}`] }))
    expect(result.directory).toBe("~/Projects/app")
    expect(result.resources).toEqual(["cat ~/x", "ls ~"])
  })

  test("leaves a sibling path that merely starts with the home path", () => {
    expect(sanitize(entry({ resources: [`${home}2/x`] })).resources).toEqual([`${home}2/x`])
  })

  test("cuts long resources", () => {
    const [resource] = sanitize(entry({ resources: ["x".repeat(600)] })).resources
    expect(resource).toBe("x".repeat(500) + "…")
  })

  test("cuts a long reason, and leaves a short one alone", () => {
    expect(sanitize(entry({ why: "y".repeat(600) })).why).toBe("y".repeat(500) + "…")
    expect(sanitize(entry({ why: "Reads a file." })).why).toBe("Reads a file.")
  })

  test("drops the query string and fragment from webfetch URLs only", () => {
    expect(sanitize(entry({ action: "webfetch", resources: ["https://a.example/p?token=1#frag"] })).resources).toEqual([
      "https://a.example/p",
    ])
    expect(sanitize(entry({ action: "shell", resources: ["curl https://a.example/p?x=1"] })).resources).toEqual([
      "curl https://a.example/p?x=1",
    ])
  })

  test("entries your config decided keep no resources", () => {
    const result = sanitize(entry({ by: "config", resources: ["cat ~/.ssh/id_rsa"] }))
    expect(result.resources).toEqual([])
    expect(result.action).toBe("shell")
  })

  test("entries the judge or the plugin decided keep theirs", () => {
    expect(sanitize(entry({ by: "judge", resources: ["ls"] })).resources).toEqual(["ls"])
    expect(sanitize(entry({ by: "plugin", effect: "ask", reason: "error", resources: ["ls"] })).resources).toEqual(["ls"])
  })
})

describe("monthly files", () => {
  test.each([
    ["2026-11-17T07:00:00Z", "audit-2026-11.jsonl"],
    ["2026-11-30T23:59:59Z", "audit-2026-11.jsonl"],
    ["2027-01-01T00:00:00Z", "audit-2027-01.jsonl"],
  ])("%s goes to %s", (iso, name) => {
    expect(monthFile(at(iso))).toBe(name)
  })
})

describe("writer", () => {
  test("creates a private directory and file, and appends sanitized lines to the month's file", () => {
    const dir = join(tempDir(), "nested", "log")
    const write = createWriter(dir)
    write(entry())
    write(entry({ time: at("2026-12-24T07:00:00Z") }))
    write(entry({ resources: ["pwd"] }))

    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(readdirSync(dir).sort()).toEqual(["audit-2026-11.jsonl", "audit-2026-12.jsonl", "audit.jsonl"])
    expect(statSync(join(dir, "audit-2026-11.jsonl")).mode & 0o777).toBe(0o600)
    expect(readEntries(dir).map((e) => e.resources)).toEqual([["ls"], ["pwd"], ["ls"]])
  })
})

describe("latest link", () => {
  const link = (dir: string) => join(dir, "audit.jsonl")

  test("audit.jsonl points at the newest month's file, relative to the directory", () => {
    const dir = tempDir()
    const write = createWriter(dir)
    write(entry())
    expect(readlinkSync(link(dir))).toBe("audit-2026-11.jsonl")
    write(entry({ time: at("2026-12-01T07:00:00Z") }))
    expect(readlinkSync(link(dir))).toBe("audit-2026-12.jsonl")
    expect(readFileSync(link(dir), "utf8")).toBe(readFileSync(join(dir, "audit-2026-12.jsonl"), "utf8"))
    expect(readdirSync(dir).sort()).toEqual(["audit-2026-11.jsonl", "audit-2026-12.jsonl", "audit.jsonl"])
  })

  test("a late entry from an earlier month does not move it back", () => {
    const dir = tempDir()
    const write = createWriter(dir)
    write(entry({ time: at("2026-12-01T07:00:00Z") }))
    write(entry({ time: at("2026-11-30T23:59:59Z") }))
    expect(readlinkSync(link(dir))).toBe("audit-2026-12.jsonl")
  })

  test("is ignored by prune and readEntries", () => {
    const dir = tempDir()
    createWriter(dir)(entry())
    expect(prune(dir, at("2027-07-01T00:00:00Z"))).toEqual(["audit-2026-11.jsonl"])
    expect(readEntries(dir)).toEqual([])
    expect(readdirSync(dir)).toEqual(["audit.jsonl"])
  })
})

describe("prune", () => {
  const now = at("2026-11-17T07:00:00Z")

  test("deletes months that ended more than 6 months ago and nothing else", () => {
    const dir = tempDir()
    const names = [
      "audit-2026-03.jsonl",
      "audit-2026-04.jsonl",
      "audit-2026-05.jsonl",
      "audit-2026-11.jsonl",
      "audit-2026-W40.jsonl",
      "audit-2026-13.jsonl",
      "notes.txt",
      "audit.jsonl",
    ]
    for (const name of names) writeFileSync(join(dir, name), "")
    // April ended 2026-05-01 and its 6 months were up on 2026-11-01; May's are up on 2026-12-01.
    expect(prune(dir, now)).toEqual(["audit-2026-03.jsonl", "audit-2026-04.jsonl"])
    expect(readdirSync(dir).sort()).toEqual([
      "audit-2026-05.jsonl",
      "audit-2026-11.jsonl",
      "audit-2026-13.jsonl",
      "audit-2026-W40.jsonl",
      "audit.jsonl",
      "notes.txt",
    ])
  })

  test("a December file is kept until the first instant of the July after", () => {
    const dir = tempDir()
    writeFileSync(join(dir, "audit-2025-12.jsonl"), "")
    expect(prune(dir, at("2026-06-30T23:59:59Z"))).toEqual([])
    expect(prune(dir, at("2026-07-01T00:00:00Z"))).toEqual(["audit-2025-12.jsonl"])
  })

  test("a missing directory is not an error", () => {
    expect(prune(join(tempDir(), "absent"), now)).toEqual([])
  })
})

describe("readEntries", () => {
  test("filters by window across files and skips corrupt lines and unrelated files", () => {
    const dir = tempDir()
    const write = createWriter(dir)
    write(entry({ time: at("2026-10-10T08:00:00Z"), resources: ["old"] }))
    write(entry({ time: at("2026-11-17T08:00:00Z"), resources: ["mid"] }))
    write(entry({ time: at("2026-12-24T08:00:00Z"), resources: ["new"] }))
    writeFileSync(join(dir, "audit-2026-11.jsonl"), "not json\n{}\n", { flag: "a" })
    writeFileSync(join(dir, "stray.jsonl"), JSON.stringify(entry()) + "\n")

    const names = (since?: number, until?: number) => readEntries(dir, { since, until }).map((e) => e.resources[0])
    expect(names()).toEqual(["old", "mid", "new"])
    expect(names(at("2026-11-01T00:00:00Z"))).toEqual(["mid", "new"])
    expect(names(at("2026-10-20T00:00:00Z"), at("2026-12-01T00:00:00Z"))).toEqual(["mid"])
  })

  test("a missing directory reads as empty", () => {
    expect(readEntries(join(tempDir(), "absent"))).toEqual([])
  })
})
