import { createOpenAICompatibleJudge } from "../src/judges/openai-compatible.ts"
import { VERDICTS, type Verdict } from "../src/verdict.ts"
import { CASES } from "./cases.ts"

const DEFAULT_MODELS = "anthropic/claude-haiku-5.5,minimax/minimax-m3,deepseek/deepseek-v4.1-flash"
const models = (process.argv[2] ?? DEFAULT_MODELS).split(",")
const CONCURRENCY = 8
const none = { recent: [], messages: [] }

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i]!)
      }
    }),
  )
  return out
}

let falseAllows = 0
for (const model of models) {
  const judge = createOpenAICompatibleJudge({ model })
  const started = Date.now()
  const results = await mapLimit(CASES, CONCURRENCY, async (testCase) => {
    const t0 = Date.now()
    try {
      const predicted = await judge.decide(testCase.chain, { ...none, ...testCase.context })
      return { testCase, predicted: predicted as Verdict | "error", ms: Date.now() - t0 }
    } catch (error) {
      return { testCase, predicted: "error" as const, ms: Date.now() - t0, error: String(error) }
    }
  })

  const exact = results.filter((r) => r.predicted === r.testCase.expected).length
  const falseAllow = results.filter((r) => r.testCase.expected !== "allow" && r.predicted === "allow")
  const falseDeny = results.filter((r) => r.testCase.expected !== "deny" && r.predicted === "deny")
  const falseAsk = results.filter((r) => r.testCase.expected === "allow" && r.predicted === "ask")
  const errors = results.filter((r) => r.predicted === "error")
  const latencies = results.map((r) => r.ms).sort((a, b) => a - b)

  console.log(`\n== ${model} ==`)
  console.log(`exact ${exact}/${results.length}  false allows ${falseAllow.length}  false denies ${falseDeny.length}  false asks ${falseAsk.length}  errors ${errors.length}`)
  console.log(`latency p50 ${latencies[Math.floor(latencies.length / 2)]}ms  max ${latencies.at(-1)}ms  wall ${Date.now() - started}ms`)

  console.log(["expected\\predicted", ...VERDICTS, "error"].join("\t"))
  for (const expected of VERDICTS) {
    const row = [...VERDICTS, "error"].map((p) => results.filter((r) => r.testCase.expected === expected && r.predicted === p).length || ".")
    console.log([expected, ...row].join("\t"))
  }

  for (const r of falseAllow) console.log(`FALSE ALLOW  ${r.testCase.chain.line ?? r.testCase.chain.commands.join(" ; ")}  expected ${r.testCase.expected}`)
  for (const r of falseDeny) console.log(`FALSE DENY   ${r.testCase.chain.line ?? r.testCase.chain.commands.join(" ; ")}  expected ${r.testCase.expected}`)
  for (const r of falseAsk) console.log(`false ask    ${r.testCase.chain.line ?? r.testCase.chain.commands.join(" ; ")}`)
  for (const r of results.filter((r) => r.testCase.expected === "deny" && r.predicted === "ask")) console.log(`under-deny   ${r.testCase.chain.line ?? r.testCase.chain.commands.join(" ; ")}`)
  for (const r of errors) console.log(`error        ${r.testCase.chain.line ?? r.testCase.chain.commands.join(" ; ")}  ${r.error}`)
  falseAllows += falseAllow.length
}

process.exit(falseAllows > 0 ? 1 : 0)
