import { CASES } from "./cases.ts"
import { allRuns, dollars, promptId, score } from "./store.ts"

const currentOnly = process.argv.includes("--current")
const current = promptId()
const runs = allRuns()
  .filter((run) => !currentOnly || run.prompt === current)
  .sort((a, b) => a.model.localeCompare(b.model) || b.updated.localeCompare(a.updated))

if (runs.length === 0) {
  console.log("no stored runs; `bun run eval` creates them")
  process.exit(0)
}

const header = ["model", "prompt", "n", "date", "commit", "exact", "FA", "FD", "err", "p50", "p95", "tok in/out", "cached", "$/1000"]
const rows = runs.map((run) => {
  const s = score(run, CASES)
  return [
    run.model,
    `${run.prompt}${run.prompt === current ? "*" : ""}${run.sample > 1 ? `#${run.sample}` : ""}`,
    `${s.covered}/${CASES.length}`,
    run.updated.slice(0, 10),
    run.commit,
    String(s.exact),
    String(s.falseAllows),
    String(s.falseDenies),
    String(s.errors),
    `${s.p50}ms`,
    `${s.p95}ms`,
    `${Math.round(s.promptTokens)}/${Math.round(s.completionTokens)}`,
    `${Math.round(s.cachedShare * 100)}%`,
    `${dollars(s.costPer1000)}${s.costSource === "list price" ? "~" : ""}`,
  ]
})
const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)))
const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd()
console.log(line(header))
for (const row of rows) console.log(line(row))
console.log(`\n* current prompt, #n a later sample, FA false allows, FD false denies, ~ cost from list price, not billed`)
