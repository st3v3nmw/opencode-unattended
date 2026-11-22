import { parseDuration } from "../duration.ts"
import {
  JudgeUnavailable,
  registerJudge,
  type Judge,
  type JudgeOptions,
  type Judgement,
  type Usage,
} from "../judge.ts"
import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_TIMEOUT_MS,
  MAX_RETRY_AFTER_MS,
  MAX_RETRY_TIME_MS,
  RETRY_DELAYS_MS,
} from "../limits.ts"
import { SYSTEM_PROMPT, renderRequest } from "../prompt.ts"
import { VERDICTS, isVerdict } from "../verdict.ts"

export const DEFAULT_CACHE_TTL = "1h"

export interface PromptCache {
  enabled: boolean
  /** A duration such as `5m` or `1h`, sent as is. The provider decides which values it accepts. */
  ttl: string
}

export interface OpenAIOptions {
  model: string
  baseURL: string
  timeoutMs: number
  maxTokens: number
  /** Marks the system prompt cacheable and pins routing, so a provider that supports it can reuse the prompt between calls. */
  promptCache: PromptCache
  fetch: typeof fetch
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  now: () => number
  env: Record<string, string | undefined>
}

const CONFIG_KEYS = ["model", "baseURL"] as const
type ConfigKey = (typeof CONFIG_KEYS)[number]
type JudgeConfig = Pick<OpenAIOptions, ConfigKey> & Partial<Pick<OpenAIOptions, "timeoutMs" | "promptCache">>

/** One id for every call, so OpenRouter keeps routing them to the provider whose cache is warm. */
export const CACHE_SESSION_ID = "opencode-unattended"


export const RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "decision",
    strict: true,
    schema: {
      type: "object",
      properties: { decision: { type: "string", enum: [...VERDICTS] }, reason: { type: "string" } },
      required: ["decision", "reason"],
      additionalProperties: false,
    },
  },
} as const

export function parseJudgement(content: unknown): Judgement {
  if (typeof content !== "string") throw new Error("judge response has no text content")
  const text = content.trim().replace(/^```(?:json)?\s*|\s*```$/g, "")
  const parsed = JSON.parse(text) as { decision?: unknown; reason?: unknown } | null
  // A model that still answers `ask` is holding the request back, which is a deny.
  const decision = parsed?.decision === "ask" ? "deny" : parsed?.decision
  if (!isVerdict(decision)) throw new Error(`judge returned unknown decision: ${JSON.stringify(decision)}`)
  const reason = typeof parsed?.reason === "string" ? parsed.reason.replace(/\s+/g, " ").trim() : ""
  return { verdict: decision, reason }
}

const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined)

interface RawUsage {
  prompt_tokens?: unknown
  completion_tokens?: unknown
  cost?: unknown
  completion_tokens_details?: { reasoning_tokens?: unknown }
  prompt_tokens_details?: { cached_tokens?: unknown; cache_write_tokens?: unknown }
}

function usageOf(raw: RawUsage | undefined): Usage | undefined {
  const promptTokens = count(raw?.prompt_tokens)
  const completionTokens = count(raw?.completion_tokens)
  if (promptTokens === undefined || completionTokens === undefined) return undefined
  const optional = {
    reasoningTokens: count(raw?.completion_tokens_details?.reasoning_tokens),
    cachedTokens: count(raw?.prompt_tokens_details?.cached_tokens),
    cacheWriteTokens: count(raw?.prompt_tokens_details?.cache_write_tokens),
    cost: count(raw?.cost),
  }
  return {
    promptTokens,
    completionTokens,
    ...Object.fromEntries(Object.entries(optional).filter(([, value]) => value !== undefined)),
  }
}

/** Failures worth another try: the service is limited or struggling, not the request being wrong. */
const transient = (status: number) => status === 429 || status >= 500

export const endpoint = (baseURL: string) =>
  `${baseURL.trim().replace(/\/+$/, "").replace(/\/chat\/completions$/, "")}/chat/completions`

/** The host and port of a base URL, without scheme, credentials, path or query. */
export function hostOf(baseURL: string): string | undefined {
  try {
    return new URL(baseURL.trim()).host || undefined
  } catch {
    return undefined
  }
}

export const API_KEY_ENV = "OPENCODE_UNATTENDED_API_KEY"

/** A Retry-After value, in seconds or as an HTTP date, as milliseconds from now. */
function retryAfterMs(header: string | null): number | undefined {
  if (!header?.trim()) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(header)
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now())
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal!.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal?.addEventListener("abort", onAbort, { once: true })
  })

function promptCacheConfig(value: unknown): PromptCache {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`judge.promptCache must be an object such as { "ttl": "${DEFAULT_CACHE_TTL}" }`)
  }
  const { enabled = true, ttl = DEFAULT_CACHE_TTL } = value as Record<string, unknown>
  if (typeof enabled !== "boolean") throw new Error("judge.promptCache.enabled must be true or false")
  if (typeof ttl !== "string" || !parseDuration(ttl)) throw new Error('judge.promptCache.ttl must be a duration like "5m" or "1h"')
  return { enabled, ttl: ttl.trim() }
}

/**
 * Validates the `judge` options from config: `model` and `baseURL` are required, `timeout` (a duration like `15s`) and
 * `promptCache` (`{ enabled, ttl }`) are optional, anything else is ignored. The key is not an option: it is always read
 * from OPENCODE_UNATTENDED_API_KEY.
 */
export function judgeConfig(options: JudgeOptions): JudgeConfig {
  const missing = CONFIG_KEYS.filter((key) => options[key] === undefined)
  if (missing.length > 0) throw new Error(`missing required options: ${missing.map((key) => `judge.${key}`).join(", ")}`)

  const config = {} as JudgeConfig
  for (const key of CONFIG_KEYS) {
    const value = options[key]
    if (typeof value !== "string" || !value.trim()) throw new Error(`judge.${key} must be a non-empty string`)
    config[key] = value.trim()
  }
  // TODO: remove this check once configs have moved from timeoutMs to timeout.
  if (options.timeoutMs !== undefined) throw new Error('judge.timeoutMs is now judge.timeout, a duration like "15s"')
  if (options.timeout !== undefined) {
    const ms = typeof options.timeout === "string" ? parseDuration(options.timeout) : undefined
    if (!ms) throw new Error('judge.timeout must be a duration like "15s" or "1m"')
    config.timeoutMs = ms
  }
  if (options.promptCache !== undefined) config.promptCache = promptCacheConfig(options.promptCache)
  return config
}

export function createOpenAIJudge(partial: Pick<OpenAIOptions, ConfigKey> & Partial<OpenAIOptions>): Judge {
  const env = partial.env ?? process.env
  const options: OpenAIOptions = {
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxTokens: DEFAULT_MAX_TOKENS,
    promptCache: { enabled: false, ttl: DEFAULT_CACHE_TTL },
    fetch: globalThis.fetch,
    sleep,
    now: Date.now,
    ...partial,
    env,
  }

  return {
    id: options.model,
    provider: hostOf(options.baseURL),
    async decide(request, context, signal) {
      const apiKey = options.env[API_KEY_ENV]?.trim()

      const { enabled: cached, ttl } = options.promptCache
      const payload = JSON.stringify({
        model: options.model,
        max_tokens: options.maxTokens,
        response_format: RESPONSE_FORMAT,
        ...(cached ? { session_id: CACHE_SESSION_ID } : {}),
        messages: [
          {
            role: "system",
            content: cached
              ? [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral", ttl } }]
              : SYSTEM_PROMPT,
          },
          { role: "user", content: renderRequest(request, context) },
        ],
      })
      let spent = 0
      let response: Response
      for (let attempt = 0; ; attempt++) {
        const started = options.now()
        const timeout = AbortSignal.timeout(options.timeoutMs)
        let failure: string
        let retryAfter: number | undefined
        try {
          response = await options.fetch(endpoint(options.baseURL), {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
            },
            body: payload,
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          })
          spent += options.now() - started
          if (!transient(response.status)) break
          failure = `judge HTTP ${response.status}`
          retryAfter = retryAfterMs(response.headers.get("retry-after"))
          await response.body?.cancel()
        } catch (error) {
          if (signal?.aborted) throw error
          spent += options.now() - started
          failure = timeout.aborted ? `judge timed out after ${options.timeoutMs / 1000}s` : `judge unreachable: ${error instanceof Error ? error.message : String(error)}`
        }
        if (attempt >= RETRY_DELAYS_MS.length) throw new JudgeUnavailable(failure)
        const wait = retryAfter ?? RETRY_DELAYS_MS[attempt]!
        if (wait > MAX_RETRY_AFTER_MS || spent + wait > MAX_RETRY_TIME_MS) {
          throw new JudgeUnavailable(`${failure} (retry after ${Math.ceil(wait / 1000)}s)`)
        }
        spent += wait
        await options.sleep(wait, signal)
      }
      if (!response.ok) throw new Error(`judge HTTP ${response.status}`)
      const body = (await response.json()) as {
        choices?: { finish_reason?: unknown; message?: { content?: unknown; refusal?: unknown } }[]
        usage?: RawUsage
      }
      const choice = body.choices?.[0]
      const message = choice?.message
      if (typeof message?.refusal === "string" && message.refusal) {
        throw new Error(`judge refused: ${message.refusal.slice(0, 120)}`)
      }
      let judgement: Judgement
      try {
        judgement = parseJudgement(message?.content)
      } catch (error) {
        if (choice?.finish_reason === "length") throw new Error(`judge ran out of tokens (max_tokens ${options.maxTokens}) before answering`)
        throw error
      }
      const usage = usageOf(body.usage)
      return usage ? { ...judgement, usage } : judgement
    },
  }
}

registerJudge("openai", (options: JudgeOptions) => createOpenAIJudge(judgeConfig(options)))
