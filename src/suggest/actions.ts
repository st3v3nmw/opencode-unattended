import type { AuditEntry } from "../audit/audit.ts"
import { isSpecific, lastMatch, matches, rulesFor, type ActionRule, type ShellRule } from "./rules.ts"
import { MAX_EXAMPLES, MIN_USES, MULTIPLEXERS, shorten, suggest, type Candidate } from "./suggest.ts"

export const ACTIONS = ["shell", "webfetch"] as const

/** Hosts where the first path segments name an owner, so a rule for the whole host would trust every user's content. */
const OWNER_SEGMENTS: Record<string, number> = {
  "github.com": 1,
  "gist.github.com": 1,
  "raw.githubusercontent.com": 1,
  "gist.githubusercontent.com": 1,
  "api.github.com": 2,
  "gitlab.com": 1,
  "bitbucket.org": 1,
  "codeberg.org": 1,
  "huggingface.co": 1,
}

const PRIVATE_HOST = /^(?:localhost|.*\.(?:local|localhost|internal|lan|home|corp)|\d{1,3}(?:\.\d{1,3}){3}|\[.*)$/i

interface Stat {
  allows: number
  blocked: boolean
  sessions: Set<string>
  examples: Set<string>
}

const newStat = (): Stat => ({ allows: 0, blocked: false, sessions: new Set(), examples: new Set() })

/**
 * The rule a URL would be covered by, and whether the URL itself rules that out. Plain http, credentials and a query
 * string are what a `/*` rule would let through without the judge, since a query can carry data out. Private
 * hosts and anything that is not a URL give no rule at all.
 */
function webfetchRule(raw: string): { rule: string; tainted: boolean } | undefined {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined
  if (PRIVATE_HOST.test(url.hostname)) return undefined
  const owner = OWNER_SEGMENTS[url.hostname] ?? 0
  const segments = url.pathname.split("/").filter(Boolean)
  if (segments.length < owner) return undefined
  const prefix = segments.slice(0, owner).map((s) => `${s}/`).join("")
  return {
    rule: `https://${url.host}/${prefix}*`,
    tainted: url.protocol !== "https:" || url.search !== "" || url.username !== "" || url.password !== "",
  }
}

const examplesOf = (s: Stat) => [...s.examples].sort((a, b) => a.length - b.length).slice(0, MAX_EXAMPLES).map(shorten)

/**
 * Proposes webfetch allow rules from the URLs the judge has allowed. A rule covers an origin (`https://docs.example.com/*`),
 * or an owner on hosts that serve many people's content (`https://github.com/canonical/*`). It is proposed only if the
 * judge never asked or denied a URL it would cover, no allowed use carried a query, credentials or plain http, it was
 * allowed at least `minUses` times, and no specific ask or deny rule overlaps it.
 */
export function suggestWebfetch(entries: readonly AuditEntry[], rules: readonly ShellRule[], minUses = MIN_USES): Candidate[] {
  const stats = new Map<string, Stat>()
  for (const entry of entries) {
    if (entry.by !== "judge" || entry.action !== "webfetch") continue
    for (const url of entry.resources) {
      const rule = lastMatch(rules, url)
      if (rule && (rule.effect === "allow" || isSpecific(rule))) continue
      const found = webfetchRule(url)
      if (!found) continue
      let s = stats.get(found.rule)
      if (!s) stats.set(found.rule, (s = newStat()))
      if (entry.effect !== "allow" || found.tainted) s.blocked = true
      else {
        s.allows++
        s.sessions.add(entry.sessionID)
        s.examples.add(url)
      }
    }
  }

  const guarded = rules.filter((r) => r.effect !== "allow" && isSpecific(r))
  const out: Candidate[] = []
  for (const [pattern, s] of stats) {
    if (s.blocked || s.allows < minUses) continue
    const base = pattern.slice(0, -1)
    if (guarded.some((g) => matches(g.resource, pattern) || g.resource.startsWith(base))) continue
    out.push({ action: "webfetch", pattern, allows: s.allows, sessions: s.sessions.size, historyRuns: 0, examples: examplesOf(s) })
  }
  return out.sort((a, b) => b.allows - a.allows || a.pattern.localeCompare(b.pattern))
}

/** How many requests the judge reviewed for each action, including those it did not allow. */
export function reviewedCounts(entries: readonly AuditEntry[]): Record<string, number> {
  const counts: Record<string, number> = Object.fromEntries(ACTIONS.map((a) => [a, 0]))
  for (const e of entries) if (e.by === "judge" && e.action in counts) counts[e.action]!++
  return counts
}

/** How many sessions the judge reviewed at least one request in, for each action. */
export function reviewedSessions(entries: readonly AuditEntry[]): Record<string, number> {
  const seen: Record<string, Set<string>> = Object.fromEntries(ACTIONS.map((a) => [a, new Set<string>()]))
  for (const e of entries) if (e.by === "judge" && e.action in seen) seen[e.action]!.add(e.sessionID)
  return Object.fromEntries(Object.entries(seen).map(([action, ids]) => [action, ids.size]))
}

const words = (rule: string) => rule.split(" ").filter(Boolean)

/**
 * Facts about how a shell pattern relates to the config, for whoever reviews it. Nothing here vetoes a candidate: it
 * cannot tell what a command does, only where the pattern and the rules are written differently.
 */
function shellNotes(pattern: string, rules: readonly ShellRule[]): string[] {
  const rule = words(pattern.replace(/ \*$/, ""))
  const notes: string[] = []
  if (MULTIPLEXERS.has(rule[0] ?? "") && rule[1]?.startsWith("-")) {
    notes.push(
      `An option comes before the subcommand, so ask and deny rules written as \`${rule[0]} <subcommand> *\` do not match commands under this rule. Check whether \`*\` can stand for the subcommand.`,
    )
  }
  const lead = rule.slice(0, 2)
  const related = rules
    .filter((r) => r.effect !== "allow" && isSpecific(r))
    .filter((r) => {
      const other = words(r.resource.replace(/ \*$/, ""))
      return other.join(" ") !== rule.join(" ") && lead.every((w, i) => other[i] === w)
    })
  if (related.length) {
    const list = related.map((r) => `\`${r.resource}\``).join(", ")
    notes.push(`Ask or deny rules nearby: ${list}. \`*\` can carry those flags after the ones in the pattern, and those rules would not match.`)
  }
  return notes
}

/** Adds the notes to each candidate that has any, after the note it already carries. */
function annotate(candidates: readonly Candidate[], rules: readonly ActionRule[]): Candidate[] {
  return candidates.map((c) => {
    if (c.action !== "shell") return c
    const added = shellNotes(c.pattern, rulesFor(rules, "shell"))
    return added.length ? { ...c, note: added.join(" ") } : c
  })
}

/**
 * Candidates for each of `actions`, shell first. `rules` is the whole config; each action sees its own and the `*` rules.
 * A candidate that an allow rule already covers is dropped, so a suggestion only ever widens what the config allows.
 */
export function suggestAll(
  entries: readonly AuditEntry[],
  history: readonly string[],
  rules: readonly ActionRule[],
  minUses = MIN_USES,
  actions: readonly string[] = ACTIONS,
): Candidate[] {
  const candidates = [
    ...(actions.includes("shell") ? suggest(entries, history, rulesFor(rules, "shell"), minUses) : []),
    ...(actions.includes("webfetch") ? suggestWebfetch(entries, rulesFor(rules, "webfetch"), minUses) : []),
  ]
  return annotate(
    candidates.filter((c) => lastMatch(rulesFor(rules, c.action), c.pattern)?.effect !== "allow"),
    rules,
  )
}

/** Whether a command name resolves to something a shell can run. */
export type Resolver = (name: string) => boolean

/**
 * Asks the user's shell, `command -v`, since that is the lookup opencode's non-interactive shell makes. Aliases and
 * functions from an rc file are not found, and a rule for one could not match there either. Anything with a `/` is a
 * path, which depends on the working directory, so it is taken as found. A shell that cannot start falls back to `sh`.
 */
export function shellResolver(shell = process.env.SHELL || "sh"): Resolver {
  const cache = new Map<string, boolean>()
  return (name) => {
    if (name.includes("/")) return true
    let found = cache.get(name)
    if (found === undefined) {
      const run = (sh: string) => Bun.spawnSync([sh, "-c", 'command -v -- "$1"', "_", name], { stdout: "ignore", stderr: "ignore" }).exitCode === 0
      try {
        found = run(shell)
      } catch {
        found = run("sh")
      }
      cache.set(name, found)
    }
    return found
  }
}

/** Splits off the shell candidates whose command name does not resolve. Other actions pass through. */
export function withoutUnresolved(candidates: readonly Candidate[], resolves: Resolver): { candidates: Candidate[]; skipped: string[] } {
  const skipped = new Set<string>()
  const kept = candidates.filter((c) => {
    if (c.action !== "shell") return true
    const name = c.pattern.split(" ")[0]!
    if (resolves(name)) return true
    skipped.add(name)
    return false
  })
  return { candidates: kept, skipped: [...skipped] }
}
