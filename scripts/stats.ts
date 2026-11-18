import { DEFAULT_AUDIT_DIR, readEntries } from "../src/auditlog.ts"
import { byJudge, format, formatJudges, formatMonthly, monthly, parseWhen, summarize, top } from "../src/stats.ts"

const USAGE = `usage: bun run stats [--since 180d] [--until DATE] [--project TEXT] [--top ask|deny|error] [--json] [--dir PATH]

  --since    window start: 30d, 4w, 12h, or a date like 2026-11-01 (default 180d)
  --until    window end, same forms (default now)
  --project  only entries whose directory contains TEXT
  --top      also list the most frequent asks, denies, or judge errors
  --json     print JSON instead of text
  --dir      audit directory (default ${DEFAULT_AUDIT_DIR})`

const args = process.argv.slice(2)
if (args.includes("--help") || args.includes("-h")) {
  console.log(USAGE)
  process.exit(0)
}
const option = (name: string) => {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args[i + 1]
}

try {
  const now = Date.now()
  const dir = option("--dir") ?? DEFAULT_AUDIT_DIR
  const project = option("--project")
  const kind = option("--top")
  if (kind !== undefined && kind !== "ask" && kind !== "deny" && kind !== "error") {
    throw new Error(`--top must be ask, deny or error, not "${kind}"`)
  }
  const since = parseWhen(option("--since") ?? "180d", now)
  const until = option("--until") ? parseWhen(option("--until")!, now) : now

  const entries = readEntries(dir, { since, until }).filter((e) => !project || e.directory.includes(project))
  const stats = summarize(entries)
  const months = monthly(entries)
  const judges = byJudge(entries)
  const ranked = kind ? top(entries, kind) : undefined

  if (args.includes("--json")) {
    console.log(JSON.stringify({ since, until, dir, stats, judges, months, ...(kind ? { top: { [kind]: ranked } } : {}) }, null, 2))
  } else if (entries.length === 0) {
    console.log(`no audit entries in ${dir} for ${new Date(since).toISOString().slice(0, 10)} to ${new Date(until).toISOString().slice(0, 10)}`)
  } else {
    const out = [format(stats)]
    if (judges.length > 0) out.push("", formatJudges(judges))
    out.push("", formatMonthly(months))
    if (ranked) out.push("", `top ${kind}:`, ...(ranked.length ? ranked.map((r) => `  ${String(r.count).padStart(4)}  ${r.label}`) : ["  none"]))
    out.push("", "Requests your rules deny outright never reach the plugin, so they are not counted.")
    console.log(out.join("\n"))
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
