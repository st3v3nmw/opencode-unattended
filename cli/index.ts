#!/usr/bin/env bun
export {}

const USAGE = `usage: opencode-unattended <command> [options]

  stats     summarize the audit log
  suggest   propose permission rules from audit and session history

Run a command with --help for its options.`

const commands: Record<string, () => Promise<unknown>> = {
  stats: () => import("./stats.ts"),
  suggest: () => import("./suggest.ts"),
}

const name = process.argv[2]
if (!name || name === "--help" || name === "-h") {
  console.log(USAGE)
  process.exit(0)
}
const load = commands[name]
if (!load) {
  console.error(`opencode-unattended: unknown command "${name}"\n\n${USAGE}`)
  process.exit(1)
}
process.argv.splice(2, 1)
await load()
