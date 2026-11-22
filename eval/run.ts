import { JudgeNotConfigured, JudgeUnavailable } from "../src/judge.ts"
import { DEFAULT_CACHE_TTL, createOpenAIJudge, hostOf } from "../src/judges/openai.ts"
import { VERDICTS } from "../src/verdict.ts"
import { CASES, type Case } from "./cases.ts"
import { caseId, dollars, emptyRun, loadRun, nextSample, saveRun, score, type Price, type Run } from "./store.ts"

const DEFAULT_MODELS = [
  "anthropic/claude-haiku-5.5",
  "minimax/minimax-m3",
  "deepseek/deepseek-v4.1-flash",
  "openai/gpt-6-luna",
  "google/gemini-3.5-flash-lite",
  "anthropic/claude-sonnet-5.5",
  "z-ai/glm-5.3-flash",
  "openai/gpt-oss-20b",
  "google/gemma-4-26b-a4b-it",
  "qwen/qwen3.8-27b",
]

const args = process.argv.slice(2)
const flags = new Set(args.filter((arg) => arg.startsWith("--")))
const models = (args.find((arg) => !arg.startsWith("--")) ?? DEFAULT_MODELS.join(",")).split(",")
const fresh = flags.has("--fresh")
const retryErrors = flags.has("--retry-errors")
const promptCache = flags.has("--cache")

const API_URL = process.env.EVAL_API_URL ?? ""
if (!API_URL) {
  console.error("set EVAL_API_URL to an OpenAI-compatible base URL, such as https://openrouter.ai/api/v1")
  process.exit(1)
}

// Slow by default: one request at a time, a pause after each, and a longer one between models.
const CONCURRENCY = Number(process.env.EVAL_CONCURRENCY ?? 1)
const DELAY_MS = Number(process.env.EVAL_DELAY_MS ?? 1000)
const COOLDOWN_S = Number(process.env.EVAL_COOLDOWN_S ?? 120)
const MAX_CONSECUTIVE_FAILURES = 5

const none = { recent: [], messages: [] }
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const label = ({ request }: Case) =>
  request.action === "shell" ? (request.line ?? request.resources.join(" ; ")) : `${request.action} ${request.resources.join(" ; ")}`
const log = (text: string) => console.error(`[${new Date().toTimeString().slice(0, 8)}] ${text}`)

function commit(): string {
  const run = (...cmd: string[]) => Bun.spawnSync(cmd, { cwd: import.meta.dir })
  const sha = run("git", "rev-parse", "--short", "HEAD").stdout.toString().trim() || "unknown"
  return run("git", "diff", "--quiet", "HEAD").exitCode === 0 ? sha : `${sha}+dirty`
}

async function prices(): Promise<Map<string, Price>> {
  const found = new Map<string, Price>()
  if (hostOf(API_URL) !== "openrouter.ai") return found
  try {
    const body = (await (await fetch("https://openrouter.ai/api/v1/models")).json()) as { data: { id: string; pricing: { prompt: string; completion: string } }[] }
    for (const m of body.data) found.set(m.id, { input: Number(m.pricing.prompt) * 1e6, output: Number(m.pricing.completion) * 1e6 })
  } catch {
    log("could not fetch the price list; costs will only show where the server reports them")
  }
  return found
}

/** Calls the model for each case without an outcome, saving after every one. Returns false if it gave up. */
async function fill(run: Run, todo: Case[]): Promise<boolean> {
  const judge = createOpenAIJudge({ model: run.model, baseURL: API_URL, promptCache: { enabled: promptCache, ttl: DEFAULT_CACHE_TTL } })
  let next = 0
  let done = 0
  let streak = 0
  let gaveUp = false
  const worker = async () => {
    while (next < todo.length && !gaveUp) {
      const testCase = todo[next++]!
      const started = Date.now()
      try {
        const { verdict, reason, usage } = await judge.decide(testCase.request, { ...none, ...testCase.context })
        run.outcomes[caseId(testCase)] = { verdict, reason, ms: Date.now() - started, ...(usage ? { usage } : {}) }
        streak = 0
      } catch (error) {
        const message = String(error instanceof Error ? error.message : error)
        // Outages and rejected requests say nothing about the model, so they are retried next time instead of stored.
        const model = !(error instanceof JudgeUnavailable || error instanceof JudgeNotConfigured || message.startsWith("judge HTTP"))
        if (model) run.outcomes[caseId(testCase)] = { verdict: "error", reason: "", ms: Date.now() - started, error: message }
        else log(`${run.model}: ${message}`)
        if (++streak >= MAX_CONSECUTIVE_FAILURES) gaveUp = true
      }
      saveRun(run)
      if (++done % 25 === 0) log(`${run.model}: ${done}/${todo.length}`)
      await sleep(DELAY_MS)
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  if (gaveUp) log(`${run.model}: stopped after ${MAX_CONSECUTIVE_FAILURES} failures in a row; run again to continue`)
  return !gaveUp
}

function report(run: Run, cached: boolean) {
  const s = score(run, CASES)
  const rows = CASES.flatMap((testCase) => {
    const outcome = run.outcomes[caseId(testCase)]
    return outcome ? [{ testCase, outcome }] : []
  })
  console.log(`\n== ${run.model}  prompt ${run.prompt}${run.sample > 1 ? ` sample ${run.sample}` : ""}  ${cached ? "stored" : "ran"} ${run.updated.slice(0, 16)} ==`)
  console.log(`exact ${s.exact}/${s.covered} of ${CASES.length}  false allows ${s.falseAllows}  false denies ${s.falseDenies}  errors ${s.errors}`)
  console.log(`latency p50 ${s.p50}ms  p95 ${s.p95}ms`)
  console.log(
    `tokens per call ${Math.round(s.promptTokens)} in, ${Math.round(s.completionTokens)} out (${Math.round(s.reasoningTokens)} reasoning)  ${Math.round(s.cachedShare * 100)}% cached  cost per 1000 calls ${dollars(s.costPer1000)}${s.costSource ? ` (${s.costSource})` : ""}`,
  )
  console.log(["expected\\predicted", ...VERDICTS, "error"].join("\t"))
  for (const expected of VERDICTS) {
    const row = [...VERDICTS, "error"].map((p) => rows.filter((r) => r.testCase.expected === expected && r.outcome.verdict === p).length || ".")
    console.log([expected, ...row].join("\t"))
  }
  const why = (r: { outcome: { reason: string } }) => (r.outcome.reason ? `  -> ${r.outcome.reason}` : "")
  for (const r of rows.filter((r) => r.testCase.expected === "deny" && r.outcome.verdict === "allow")) console.log(`FALSE ALLOW  ${label(r.testCase)}${why(r)}`)
  for (const r of rows.filter((r) => r.testCase.expected === "allow" && r.outcome.verdict === "deny")) console.log(`FALSE DENY   ${label(r.testCase)}${why(r)}`)
  for (const r of rows.filter((r) => r.outcome.verdict === "error")) console.log(`error        ${label(r.testCase)}  ${r.outcome.error}`)
  return s.falseAllows
}

const list = await prices()
const sha = commit()
let falseAllows = 0
let ranBefore = false
for (const model of models) {
  const run = (fresh ? undefined : loadRun(model)) ?? emptyRun(model, sha, fresh ? nextSample(model) : 1, list.get(model))
  if (!run.price && list.has(model)) run.price = list.get(model)
  const todo = CASES.filter((testCase) => {
    const outcome = run.outcomes[caseId(testCase)]
    return !outcome || (retryErrors && outcome.verdict === "error")
  })
  if (todo.length === 0) {
    falseAllows += report(run, true)
    continue
  }
  if (ranBefore && COOLDOWN_S > 0) {
    log(`cooling down ${COOLDOWN_S}s before ${model}`)
    await sleep(COOLDOWN_S * 1000)
  }
  ranBefore = true
  log(`${model}: ${todo.length} cases to run, ${CASES.length - todo.length} stored`)
  await fill(run, todo)
  falseAllows += report(run, false)
}

process.exit(falseAllows > 0 ? 1 : 0)
