import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { AuditEntry } from "./audit.ts"

export const DEFAULT_AUDIT_DIR = join(homedir(), ".local", "state", "opencode-unattended")

const KEEP_MONTHS = 6
const MAX_RESOURCE_CHARS = 500
const FILE = /^audit-(\d{4})-(0[1-9]|1[0-2])\.jsonl$/

/** The calendar month (UTC) containing `time`, as `2026-11`. */
export const monthLabel = (time: number) => {
  const date = new Date(time)
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`
}

export const monthFile = (time: number) => `audit-${monthLabel(time)}.jsonl`

/** First instant (UTC) of the given month, counting months from 1. Months past 12 roll into the next year. */
const monthStart = (year: number, month: number) => Date.UTC(year, month - 1, 1)

function tildify(text: string): string {
  const home = homedir()
  if (!home || home === "/") return text
  let out = ""
  let from = 0
  for (let at = text.indexOf(home); at !== -1; at = text.indexOf(home, from)) {
    const next = text[at + home.length]
    out += text.slice(from, at)
    out += next === undefined || next === "/" ? "~" : home
    from = at + home.length
  }
  return out + text.slice(from)
}

function stripUrlDetail(text: string): string {
  try {
    const url = new URL(text)
    url.search = ""
    url.hash = ""
    return url.toString()
  } catch {
    return text.replace(/[?#].*$/, "")
  }
}

const truncate = (text: string) => (text.length > MAX_RESOURCE_CHARS ? text.slice(0, MAX_RESOURCE_CHARS) + "…" : text)

/**
 * Shortens what the log keeps: home becomes `~`, URLs lose query strings, long commands are cut. Entries your config
 * decided keep no resources at all, because nothing reads them.
 */
export function sanitize(entry: AuditEntry): AuditEntry {
  const resources =
    entry.by === "config"
      ? []
      : entry.resources.map((r) => truncate(tildify(entry.action === "webfetch" ? stripUrlDetail(r) : r)))
  return { ...entry, directory: tildify(entry.directory), resources, ...(entry.why ? { why: tildify(entry.why) } : {}) }
}

export const LATEST_LINK = "audit.jsonl"

function repoint(dir: string, name: string): boolean {
  const tmp = join(dir, `.${LATEST_LINK}.${process.pid}`)
  try {
    rmSync(tmp, { force: true })
    symlinkSync(name, tmp)
    renameSync(tmp, join(dir, LATEST_LINK))
    return true
  } catch {
    rmSync(tmp, { force: true })
    return false
  }
}

export function createWriter(dir: string): (entry: AuditEntry) => void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  let linked = ""
  return (entry) => {
    const name = monthFile(entry.time)
    try {
      appendFileSync(join(dir, name), JSON.stringify(sanitize(entry)) + "\n", { mode: 0o600 })
    } catch {
      return
    }
    if (name > linked && repoint(dir, name)) linked = name
  }
}

/**
 * Deletes monthly files whose month ended more than 6 months ago, so entries live for 6 to 7 months. Other files are
 * left alone.
 */
export function prune(dir: string, now: number = Date.now()): string[] {
  const removed: string[] = []
  let names: string[]
  try {
    names = readdirSync(dir).sort()
  } catch {
    return removed
  }
  for (const name of names) {
    const match = FILE.exec(name)
    if (!match) continue
    if (monthStart(Number(match[1]), Number(match[2]) + 1 + KEEP_MONTHS) > now) continue
    try {
      unlinkSync(join(dir, name))
      removed.push(name)
    } catch {}
  }
  return removed
}

export interface ReadOptions {
  since?: number
  until?: number
}

/** Reads every monthly file that can overlap the window, skipping unreadable lines. */
export function readEntries(dir: string, { since = 0, until = Infinity }: ReadOptions = {}): AuditEntry[] {
  let names: string[]
  try {
    names = readdirSync(dir).sort()
  } catch {
    return []
  }
  const entries: AuditEntry[] = []
  for (const name of names) {
    const match = FILE.exec(name)
    if (!match) continue
    const start = monthStart(Number(match[1]), Number(match[2]))
    if (monthStart(Number(match[1]), Number(match[2]) + 1) <= since || start > until) continue
    let text: string
    try {
      text = readFileSync(join(dir, name), "utf8")
    } catch {
      continue
    }
    for (const line of text.split("\n")) {
      if (!line) continue
      try {
        const entry = JSON.parse(line) as AuditEntry
        if (typeof entry.time === "number" && entry.time >= since && entry.time <= until) entries.push(entry)
      } catch {}
    }
  }
  return entries.sort((a, b) => a.time - b.time)
}
