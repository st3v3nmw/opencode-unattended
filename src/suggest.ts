import type { AuditEntry } from "./audit.ts"
import { isSpecific, lastMatch, matches, type ShellRule } from "./rules.ts"

export const MIN_USES = 3
const MAX_DEPTH = 3
export const MAX_EXAMPLES = 2
const MAX_EXAMPLE_CHARS = 80

export interface Candidate {
  action: string
  pattern: string
  allows: number
  sessions: number
  historyRuns: number
  examples: string[]
  note?: string
}

/** Programs that run whatever they are handed, or whose arguments reach outside the project. */
const NEVER = new Set(
  "sh bash zsh dash fish env eval exec xargs time timeout nice nohup ionice command builtin watch stdbuf setsid flock set export source find awk gawk sed perl python python3 node nodejs bun deno ruby php lua sqlite3 psql mysql npx bunx uvx pipx sudo su doas ssh scp nc ncat socat curl wget rm rmdir shred dd mkfs wipefs truncate chmod chown chgrp kill killall pkill reboot shutdown poweroff halt mount umount".split(
    " ",
  ),
)

const RISKY_VERBS = new Set(
  "delete remove rm destroy purge prune push publish upload release apply install uninstall exec run launch shell start stop restart kill".split(
    " ",
  ),
)

/** Tools whose first word is not enough to say what a command does. */
export const MULTIPLEXERS = new Set(
  "git gh uv npm pnpm yarn cargo go docker podman lxc snap snapcraft charmcraft rockcraft kubectl helm juju systemctl apt pip make".split(
    " ",
  ),
)

/** Redirects, command substitution and traversal are what a ` *` rule would let through without the judge. */
const TAINT = /[<>`]|\$\(|\.\.|…$/

/** Discarding output or merging stderr into stdout touches no file, so it is not a redirect worth vetoing. */
const HARMLESS_REDIRECT = /(?:^|\s)(?:[12&]?>>?\s*\/dev\/null|[12]>&[12])(?=\s|$)/g
const tainted = (command: string) => TAINT.test(command.replace(HARMLESS_REDIRECT, " "))

const PLAIN = /^-{0,2}[a-z][a-z0-9_-]*$/i

function prefixes(command: string): string[] {
  const tokens = command.trim().split(/\s+/)
  const out: string[] = []
  for (let i = 0; i < Math.min(MAX_DEPTH, tokens.length); i++) {
    if (!PLAIN.test(tokens[i]!)) break
    out.push(tokens.slice(0, i + 1).join(" "))
  }
  return out
}

const unsafe = (prefix: string) => {
  const tokens = prefix.split(" ")
  if (NEVER.has(tokens[0]!)) return true
  if (tokens.length === 1 && MULTIPLEXERS.has(tokens[0]!)) return true
  return tokens.slice(1).some((t) => RISKY_VERBS.has(t))
}

const splitCommands = (line: string) => line.split(/&&|\|\||[|;\n]/).map((c) => c.trim()).filter(Boolean)

interface Stat {
  allows: number
  blocked: boolean
  sessions: Set<string>
  examples: Set<string>
  /** The longest run of leading words all of this prefix's allowed uses share. */
  common?: string[]
  /** Whether every allowed use had exactly the same words. */
  uniform: boolean
}

interface Option {
  rule: string
  allows: number
  sessions: number
  examples: string[]
  historyRuns: number
  blocked: boolean
}

const sharedWords = (a: string[], b: string[]) => {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return a.slice(0, i)
}

const startsWith = (command: string, prefix: string) => command === prefix || command.startsWith(prefix + " ")

/** Cuts at the last space outside quotes before the limit, so a quoted argument is never split. */
export function shorten(example: string): string {
  if (example.length <= MAX_EXAMPLE_CHARS) return example
  let quote = ""
  let cut = -1
  for (let i = 0; i < MAX_EXAMPLE_CHARS; i++) {
    const c = example[i]!
    if (quote) {
      if (c === quote) quote = ""
    } else if (c === '"' || c === "'") quote = c
    else if (c === " ") cut = i
  }
  return example.slice(0, cut > 0 ? cut : MAX_EXAMPLE_CHARS) + "…"
}

const option = (rule: string, s: Stat): Option => ({
  rule,
  allows: s.allows,
  sessions: s.sessions.size,
  examples: [...s.examples].sort((a, b) => a.length - b.length).slice(0, MAX_EXAMPLES).map(shorten),
  historyRuns: 0,
  blocked: false,
})
/** The command words before the first flag, which is how wide a rule for a tool without subcommands can be. */
function wideRule(rule: string): string | undefined {
  const words = rule.split(" ")
  if (MULTIPLEXERS.has(words[0]!)) return undefined
  const at = words.findIndex((w) => w.startsWith("-"))
  return at > 0 ? words.slice(0, at).join(" ") : undefined
}

/**
 * Proposes shell allow rules from what the judge has already allowed. A rule for a tool without subcommands stops at
 * the first flag (`du *`), since flags vary in order and number between runs, unless that is ruled out, in which case
 * the literal form with the flags observed (`du -sh *`) is proposed. For tools with subcommands the rule is the longest
 * prefix all allowed uses share, and must be exactly what was observed, because their flags pick what the command
 * does. A request lists every command in a chain, including ones the config already allows, so `rules` (the config's
 * shell rules, in order) filters those out and leaves the commands that reached the judge. A rule is proposed only if
 * the judge never asked or denied a request containing its prefix, no use of it (in the audit log or the history)
 * carried a redirect, substitution, traversal or truncated text, it was allowed at least `minUses` times, and no
 * specific ask or deny rule overlaps it. A shorter rule covers a longer one. History only adds counts and can only
 * veto.
 */
export function suggest(
  entries: readonly AuditEntry[],
  history: readonly string[],
  rules: readonly ShellRule[],
  minUses = MIN_USES,
): Candidate[] {
  const stats = new Map<string, Stat>()
  const stat = (prefix: string) => {
    let s = stats.get(prefix)
    if (!s) stats.set(prefix, (s = { allows: 0, blocked: false, sessions: new Set(), examples: new Set(), uniform: true }))
    return s
  }

  for (const entry of entries) {
    if (entry.by !== "judge" || entry.action !== "shell") continue
    for (const command of entry.resources) {
      const rule = lastMatch(rules, command)
      if (rule && (rule.effect === "allow" || isSpecific(rule))) continue
      const clean = entry.effect === "allow" && !tainted(command)
      const all = prefixes(command)
      const words = all.at(-1)?.split(" ") ?? []
      for (const prefix of all) {
        const s = stat(prefix)
        if (!clean) s.blocked = true
        else {
          s.allows++
          s.sessions.add(entry.sessionID)
          s.examples.add(command)
          const shared = s.common ? sharedWords(s.common, words) : words
          if (s.common && (shared.length !== s.common.length || shared.length !== words.length)) s.uniform = false
          s.common = shared
        }
      }
    }
  }

  const options = new Map<string, Option>()
  const optionFor = (rule: string, s: Stat) => {
    let o = options.get(rule)
    if (!o) options.set(rule, (o = option(rule, s)))
    return o
  }
  const qualifies = (s: Stat | undefined): s is Stat & { common: string[] } => !!s && !s.blocked && s.allows >= minUses && !!s.common

  const proposals = new Map<string, { narrow: Option; wide?: Option }>()
  for (const s of stats.values()) {
    if (!qualifies(s)) continue
    if (!s.uniform && MULTIPLEXERS.has(s.common[0]!)) continue
    const rule = s.common.join(" ")
    if (unsafe(rule) || proposals.has(rule)) continue
    const lead = wideRule(rule)
    const leadStat = lead === undefined ? undefined : stats.get(lead)
    const wide = lead !== undefined && qualifies(leadStat) && !unsafe(lead) ? optionFor(lead, leadStat) : undefined
    proposals.set(rule, { narrow: optionFor(rule, s), ...(wide ? { wide } : {}) })
  }

  for (const line of history) {
    for (const command of splitCommands(line)) {
      for (const o of options.values()) {
        if (!startsWith(command, o.rule)) continue
        o.historyRuns++
        if (tainted(command)) o.blocked = true
      }
    }
  }

  const guarded = rules.filter((r) => r.effect !== "allow" && isSpecific(r))
  const viable = (o: Option | undefined) =>
    o && !o.blocked && !guarded.some((g) => matches(g.resource, o.rule) || o.examples.some((e) => matches(g.resource, e))) ? o : undefined
  const pattern = (o: Option) => `${o.rule} *`
  const candidate = (o: Option): Candidate => ({
    action: "shell",
    pattern: pattern(o),
    allows: o.allows,
    sessions: o.sessions,
    historyRuns: o.historyRuns,
    examples: o.examples,
  })

  const chosen = new Map<string, Candidate>()
  for (const p of proposals.values()) {
    const o = viable(p.wide) ?? viable(p.narrow)
    if (!o) continue
    const picked = candidate(o)
    const rule = picked.pattern.slice(0, -2)
    const seen = chosen.get(rule)
    if (!seen || picked.allows > seen.allows) chosen.set(rule, picked)
  }

  return [...chosen]
    .filter(([rule]) => ![...chosen.keys()].some((other) => other !== rule && startsWith(rule, other)))
    .map(([, c]) => c)
    .sort((a, b) => b.allows - a.allows || a.pattern.localeCompare(b.pattern))
}

export interface Scope {
  /** Requests the judge reviewed for each action. */
  reviewed: Readonly<Record<string, number>>
  /** Sessions in which the judge reviewed at least one request, for each action. */
  sessions: Readonly<Record<string, number>>
  /** Shell names left out because they are not on PATH and not a shell builtin. */
  skipped?: readonly string[]
}

const times = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`

const share = (part: number, whole: number) => (whole > 0 ? `${((Math.min(part, whole) / whole) * 100).toFixed(1)}%` : "-")

const HEADERS = ["PATTERN", "% OF JUDGED", "% OF SESSIONS", "EXAMPLE"]

function table(candidates: readonly Candidate[], { reviewed, sessions }: Scope): string {
  const rows = candidates.map((c) => [
    c.pattern,
    share(c.allows, reviewed[c.action] ?? 0),
    share(c.sessions, sessions[c.action] ?? 0),
    c.examples[0] ?? "",
  ])
  const widths = HEADERS.map((h, i) => Math.max(h.length, ...rows.map((cells) => cells[i]!.length)))
  const line = (cells: string[]) =>
    cells
      .map((cell, i) => (i === 0 || i === 3 ? cell.padEnd(widths[i]!) : cell.padStart(widths[i]!)))
      .join("  ")
      .trimEnd()
  return [line(HEADERS), ...candidates.flatMap((c, i) => [line(rows[i]!), ...(c.note ? [`  note: ${c.note}`] : [])])].join("\n")
}

export function formatSuggestions(candidates: readonly Candidate[], scope: Scope): string {
  const skipped = scope.skipped ?? []
  const footer = skipped.length ? [`Skipped ${times(skipped.length, "name")} not found on PATH and not a shell builtin: ${skipped.join(", ")}.`] : []
  if (candidates.length === 0) {
    return [`No pattern qualifies: none was allowed by the judge at least ${MIN_USES} times without an ask, a deny, or a risky variant.`, ...footer].join("\n")
  }
  const groups = new Map<string, Candidate[]>()
  for (const c of candidates) groups.set(c.action, [...(groups.get(c.action) ?? []), c])
  const lone = groups.size === 1 && groups.has("shell")
  const sections = [...groups].map(([action, list]) => (lone ? table(list, scope) : `[${action}]\n${table(list, scope)}`))
  return [sections.join("\n\n"), ...(footer.length ? ["", ...footer] : [])].join("\n")
}
