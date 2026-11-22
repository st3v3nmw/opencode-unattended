import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { DEFAULT_DATA_DIR, readEntries } from "../src/auditlog.ts"
import { readRules } from "../src/config.ts"
import { DEFAULT_DB, readHistory } from "../src/history-db.ts"
import { parseWhen } from "../src/stats.ts"
import { formatSuggestions } from "../src/suggest.ts"
import { ACTIONS, reviewedCounts, reviewedSessions, shellResolver, suggestAll, withoutUnresolved } from "../src/suggest-actions.ts"

const DAY_MS = 86_400_000
const GLOBAL_CONFIG = join(homedir(), ".config", "opencode", "opencode.jsonc")

const USAGE = `usage: opencode-unattended suggest [--since 7d] [--config PATH]... [--data-dir PATH] [--db PATH] [--no-history] [--min-uses N] [--action NAME]... [--json]

  --since       window start: 30d, 4w, 12h, or a date like 2026-11-01 (default 7d)
  --config      opencode config to read shell rules from, in order; repeat for several
                (default ${GLOBAL_CONFIG}, then ./opencode.jsonc or ./opencode.json if present)
  --data-dir    data directory (default ${DEFAULT_DATA_DIR})
  --db          opencode database for recent session history (default ${DEFAULT_DB})
  --no-history  skip the database and use the audit log alone
  --min-uses    times the judge must have allowed a command (default 3)
  --action      only look at this action: ${ACTIONS.join(", ")}; repeat for several (default all)
  --json        print the candidates as JSON`

const args = process.argv.slice(2)
if (args.includes("--help") || args.includes("-h")) {
  console.log(USAGE)
  process.exit(0)
}
const options = (name: string) => args.flatMap((a, i) => (a === name && args[i + 1] !== undefined ? [args[i + 1]!] : []))
const option = (name: string) => options(name)[0]

try {
  const now = Date.now()
  const since = parseWhen(option("--since") ?? "7d", now)
  const days = Math.max(1, Math.ceil((now - since) / DAY_MS))
  const minUses = Number(option("--min-uses") ?? 3)
  if (!Number.isInteger(minUses) || minUses < 1) throw new Error("--min-uses must be a whole number, 1 or more")

  const configs = options("--config")
  const paths = configs.length ? configs : [GLOBAL_CONFIG, ...["opencode.jsonc", "opencode.json"].filter((f) => existsSync(f))]
  const rules = readRules(paths)
  const actions = options("--action")
  const unknown = actions.find((a) => !(ACTIONS as readonly string[]).includes(a))
  if (unknown) throw new Error(`--action must be one of ${ACTIONS.join(", ")}, not ${unknown}`)

  const entries = readEntries(option("--data-dir") ?? DEFAULT_DATA_DIR, { since }).filter((e) => e.time >= since)
  const history = args.includes("--no-history") ? { commands: [] as string[] } : readHistory(option("--db") ?? DEFAULT_DB, since)
  const { candidates, skipped } = withoutUnresolved(
    suggestAll(entries, history.commands, rules, minUses, actions.length ? actions : ACTIONS),
    shellResolver(),
  )
  const reviewed = reviewedCounts(entries)
  const judged = reviewed.shell!

  if (args.includes("--json")) {
    console.log(JSON.stringify({ days, judged, reviewed, runs: history.commands.length, skipped, ...("error" in history ? { warning: history.error } : {}), candidates }, null, 2))
  } else {
    const out = [formatSuggestions(candidates, { reviewed, sessions: reviewedSessions(entries), skipped })]
    if ("error" in history) out.push("", `warning: ${history.error}. Based on the audit log alone, so redirects in commands the judge never saw are not checked.`)
    console.log(out.join("\n"))
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
