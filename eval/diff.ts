import { CASES } from "./cases.ts"
import { caseId, loadRun, promptId, type Run } from "./store.ts"

const [a, b] = process.argv.slice(2)
if (!a || !b) {
  console.error("usage: bun run eval:diff <model[@prompt[#sample]]> <model[@prompt[#sample]]>  (prompt defaults to the current one)")
  process.exit(2)
}

function load(ref: string): Run {
  const match = /^([^@#]+)(?:@([0-9a-f]+))?(?:#(\d+))?$/.exec(ref)
  const run = match && loadRun(match[1]!, match[2] ?? promptId(), match[3] ? Number(match[3]) : 1)
  if (!run) {
    console.error(`no stored run for ${ref}`)
    process.exit(2)
  }
  return run
}

const name = (run: Run) => `${run.model}@${run.prompt}${run.sample > 1 ? `#${run.sample}` : ""}`
const left = load(a)
const right = load(b)
const label = ({ request }: (typeof CASES)[number]) =>
  request.action === "shell" ? (request.line ?? request.resources.join(" ; ")) : `${request.action} ${request.resources.join(" ; ")}`

const changed = CASES.flatMap((testCase) => {
  const before = left.outcomes[caseId(testCase)]
  const after = right.outcomes[caseId(testCase)]
  return before && after && before.verdict !== after.verdict ? [{ testCase, before: before.verdict, after: after.verdict }] : []
})
const fixed = changed.filter((c) => c.after === c.testCase.expected)
const regressed = changed.filter((c) => c.before === c.testCase.expected)
const other = changed.filter((c) => !fixed.includes(c) && !regressed.includes(c))

console.log(`${name(left)}  ->  ${name(right)}: ${changed.length} verdicts changed (${fixed.length} fixed, ${regressed.length} regressed, ${other.length} wrong either way)`)
if (changed.length <= 2) console.log("two or fewer is within the run-to-run variation, so read it as noise unless it repeats")
for (const [title, group] of [["regressed", regressed], ["fixed", fixed], ["wrong either way", other]] as const) {
  for (const c of group) console.log(`${title.padEnd(16)} ${label(c.testCase)}  expected ${c.testCase.expected}: ${c.before} -> ${c.after}`)
}
