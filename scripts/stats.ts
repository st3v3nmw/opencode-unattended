import { readFileSync } from "node:fs"
import type { AuditEntry } from "../src/audit.ts"
import { DEFAULT_AUDIT_LOG } from "../src/index.ts"
import { format, summarize } from "../src/stats.ts"

const args = process.argv.slice(2)
const option = (name: string) => {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args[i + 1]
}

const file = option("--file") ?? DEFAULT_AUDIT_LOG
const project = option("--project")

const entries = readFileSync(file, "utf8")
  .split("\n")
  .flatMap((line) => {
    try {
      return line ? [JSON.parse(line) as AuditEntry] : []
    } catch {
      return []
    }
  })
  .filter((e) => !project || e.directory?.includes(project) || e.project === project)

console.log(format(summarize(entries)))
