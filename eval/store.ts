import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Usage } from "../src/judge.ts"
import { RESPONSE_FORMAT } from "../src/judges/openai.ts"
import { DEFAULT_MAX_TOKENS } from "../src/limits.ts"
import { SYSTEM_PROMPT, renderRequest } from "../src/prompt.ts"
import type { Verdict } from "../src/verdict.ts"
import type { Case } from "./cases.ts"

export const RESULTS_DIR = process.env.EVAL_RESULTS_DIR ?? join(import.meta.dir, "results")

const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 10)

/** Identifies a case by what the judge is sent, so labels can change and cases can be added without invalidating results. */
export const caseId = ({ request, context }: Case) => hash(JSON.stringify([request, context ?? null]))

const SAMPLE = renderRequest(
  { action: "shell", resources: ["a", "b"], line: "a | b" },
  { recent: [{ tool: "write", input: "x", status: "completed" }], messages: ["m"] },
)

/** Identifies everything that shapes a request except the case and the model: the prompt, its layout, the schema and the token cap. */
export const promptId = () => hash(JSON.stringify([SYSTEM_PROMPT, SAMPLE, RESPONSE_FORMAT, DEFAULT_MAX_TOKENS]))

export interface Outcome {
  verdict: Verdict | "error"
  reason: string
  ms: number
  error?: string
  usage?: Usage
}

/** Dollars per million tokens, as listed when the run was made. */
export interface Price {
  input: number
  output: number
}

export interface Run {
  model: string
  prompt: string
  /** 1 for the first run of this model on this prompt; later samples come from `--fresh`, since answers vary between runs. */
  sample: number
  maxTokens: number
  commit: string
  started: string
  updated: string
  price?: Price
  outcomes: Record<string, Outcome>
}

const slug = (model: string) => model.replace(/[^\w.-]+/g, "_")
const fileOf = (model: string, prompt: string, sample: number) =>
  join(RESULTS_DIR, slug(model), sample === 1 ? `${prompt}.json` : `${prompt}.s${sample}.json`)

export function emptyRun(model: string, commit: string, sample = 1, price?: Price): Run {
  const now = new Date().toISOString()
  return { model, prompt: promptId(), sample, maxTokens: DEFAULT_MAX_TOKENS, commit, started: now, updated: now, ...(price ? { price } : {}), outcomes: {} }
}

/** Runs from before the judge answered only allow or deny stored `ask`, which held a request back too. */
function read(file: string): Run {
  const run = JSON.parse(readFileSync(file, "utf8")) as Run
  for (const outcome of Object.values(run.outcomes)) if ((outcome.verdict as string) === "ask") outcome.verdict = "deny"
  return run
}

export function loadRun(model: string, prompt = promptId(), sample = 1): Run | undefined {
  const file = fileOf(model, prompt, sample)
  return existsSync(file) ? read(file) : undefined
}

export function nextSample(model: string, prompt = promptId()): number {
  let sample = 1
  while (existsSync(fileOf(model, prompt, sample))) sample++
  return sample
}

/** Written after every case, so an interrupted run loses nothing. The prompt text is kept beside it, once per version. */
export function saveRun(run: Run): void {
  run.updated = new Date().toISOString()
  const file = fileOf(run.model, run.prompt, run.sample)
  mkdirSync(join(file, ".."), { recursive: true })
  const prompts = join(RESULTS_DIR, "prompts")
  mkdirSync(prompts, { recursive: true })
  const text = join(prompts, `${run.prompt}.txt`)
  if (!existsSync(text)) writeFileSync(text, SYSTEM_PROMPT + "\n")
  writeFileSync(`${file}.tmp`, JSON.stringify(run, null, 1) + "\n")
  renameSync(`${file}.tmp`, file)
}

export function allRuns(): Run[] {
  if (!existsSync(RESULTS_DIR)) return []
  return readdirSync(RESULTS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "prompts")
    .flatMap((dir) =>
      readdirSync(join(RESULTS_DIR, dir.name))
        .filter((name) => name.endsWith(".json"))
        .map((name) => read(join(RESULTS_DIR, dir.name, name))),
    )
}

export interface Score {
  covered: number
  exact: number
  falseAllows: number
  falseDenies: number
  errors: number
  p50: number
  p95: number
  promptTokens: number
  completionTokens: number
  reasoningTokens: number
  /** Share of prompt tokens read from the server's cache, 0 to 1. */
  cachedShare: number
  /** Dollars per 1000 calls at this run's mix. Undefined when neither the server nor a price list gave a cost. */
  costPer1000?: number
  /** `billed` when every cost is what the server reported, otherwise `list price`. */
  costSource?: "billed" | "list price"
}

const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0)

/** Scores stored verdicts against the labels as they are now, so relabeling a case needs no new calls. */
export function score(run: Run, cases: Case[]): Score {
  const rows = cases.flatMap((testCase) => {
    const outcome = run.outcomes[caseId(testCase)]
    return outcome ? [{ expected: testCase.expected, outcome }] : []
  })
  const times = rows.map((r) => r.outcome.ms).sort((a, b) => a - b)
  const pct = (p: number) => times[Math.min(times.length - 1, Math.floor(times.length * p))] ?? 0
  const used = rows.flatMap((r) => (r.outcome.usage ? [r.outcome.usage] : []))
  const costs = used.map((u) => u.cost ?? (run.price ? (u.promptTokens * run.price.input + u.completionTokens * run.price.output) / 1e6 : undefined))
  const known = costs.filter((c): c is number => c !== undefined)
  return {
    covered: rows.length,
    exact: rows.filter((r) => r.outcome.verdict === r.expected).length,
    falseAllows: rows.filter((r) => r.expected === "deny" && r.outcome.verdict === "allow").length,
    falseDenies: rows.filter((r) => r.expected === "allow" && r.outcome.verdict === "deny").length,
    errors: rows.filter((r) => r.outcome.verdict === "error").length,
    p50: pct(0.5),
    p95: pct(0.95),
    promptTokens: mean(used.map((u) => u.promptTokens)),
    completionTokens: mean(used.map((u) => u.completionTokens)),
    reasoningTokens: mean(used.map((u) => u.reasoningTokens ?? 0)),
    cachedShare: mean(used.map((u) => u.promptTokens ? (u.cachedTokens ?? 0) / u.promptTokens : 0)),
    ...(known.length > 0
      ? { costPer1000: mean(known) * 1000, costSource: used.every((u) => u.cost !== undefined) ? ("billed" as const) : ("list price" as const) }
      : {}),
  }
}

export const dollars = (value: number | undefined) => (value === undefined ? "n/a" : `$${value < 0.1 ? value.toFixed(3) : value.toFixed(2)}`)
