import { API_KEY_ENV, hostOf, post, sleep } from "./http.ts"
import type { Judge, Judgement, Usage } from "./judge.ts"
import { DEFAULT_TIMEOUT_MS } from "./limits.ts"
import { INSTRUCTIONS, requestState } from "./prompt.ts"

/** A request is allowed when the model puts its probability of "allow" at or above this. */
export const ALLOW_AT = 0.5

const QUESTION = `${INSTRUCTIONS}\n\nShould this request be allowed? Answer yes to allow and no to deny.`

export interface DecisionOptions {
  model: string
  baseURL: string
  timeoutMs: number
  fetch: typeof fetch
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  now: () => number
  env: Record<string, string | undefined>
}

export const endpoint = (baseURL: string) => `${baseURL.trim().replace(/\/+$/, "").replace(/\/decisions$/, "")}/decisions`

const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined)

function usageOf(raw: { input_tokens?: unknown; output_tokens?: unknown; cost?: unknown } | undefined): Usage | undefined {
  const promptTokens = count(raw?.input_tokens)
  const completionTokens = count(raw?.output_tokens)
  if (promptTokens === undefined || completionTokens === undefined) return undefined
  const cost = count(raw?.cost)
  return { promptTokens, completionTokens, ...(cost !== undefined ? { cost } : {}) }
}

/**
 * A judge that asks a decision model one yes/no question, with the system prompt as its instructions and the request
 * as its state. The model answers with a probability and no text, so a judgement has a score and no reason.
 */
export function createDecisionJudge(partial: Pick<DecisionOptions, "model" | "baseURL"> & Partial<DecisionOptions>): Judge {
  const options: DecisionOptions = {
    timeoutMs: DEFAULT_TIMEOUT_MS,
    fetch: globalThis.fetch,
    sleep,
    now: Date.now,
    env: process.env,
    ...partial,
  }

  return {
    id: options.model,
    provider: hostOf(options.baseURL),
    async decide(request, context, signal): Promise<Judgement> {
      const apiKey = options.env[API_KEY_ENV]?.trim()
      const response = await post({
        url: endpoint(options.baseURL),
        headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({
          model: options.model,
          state: requestState(request, context),
          questions: { allow: { type: "noul", instructions: QUESTION } },
        }),
        timeoutMs: options.timeoutMs,
        signal,
        fetch: options.fetch,
        sleep: options.sleep,
        now: options.now,
      })
      if (!response.ok) throw new Error(`judge HTTP ${response.status}`)
      const body = (await response.json()) as { answers?: { allow?: { noul?: unknown } }; usage?: Parameters<typeof usageOf>[0] }
      const score = body.answers?.allow?.noul
      if (typeof score !== "number" || !(score >= 0 && score <= 1)) throw new Error("judge returned no probability for allow")
      const usage = usageOf(body.usage)
      return { verdict: score >= ALLOW_AT ? "allow" : "deny", reason: "", score, ...(usage ? { usage } : {}) }
    },
  }
}
