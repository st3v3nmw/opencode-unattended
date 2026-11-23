/** What the judge answers. A request it does not allow is turned back to the agent, so there is no third answer. */
export const VERDICTS = ["allow", "deny"] as const

export type Verdict = (typeof VERDICTS)[number]

export const isVerdict = (value: unknown): value is Verdict =>
  typeof value === "string" && (VERDICTS as readonly string[]).includes(value)

/** An earlier call by the agent: what it was, as far as the judge needs to see, and how it ended. */
export interface RecentCall {
  tool: string
  /** The command for a shell call, otherwise the call's input as JSON. Truncated, with a trailing … when cut. */
  input: string
  /** `rejected` is a call that was turned back, by the judge, your config, or you. */
  status: "completed" | "error" | "rejected"
}

export interface JudgeContext {
  recent: readonly RecentCall[]
  /** The user's latest messages, truncated. The only instructions the judge takes. */
  messages: readonly string[]
}

/** What a call used, as the server reported it. `cost` is in dollars and only present when the server bills per call. */
export interface Usage {
  promptTokens: number
  completionTokens: number
  /** Part of `completionTokens` spent thinking. */
  reasoningTokens?: number
  /** Part of `promptTokens` read from the server's prompt cache. */
  cachedTokens?: number
  /** Part of `promptTokens` written to the cache, which some servers bill at a premium. */
  cacheWriteTokens?: number
  cost?: number
}

export interface Judgement {
  verdict: Verdict
  /** One short sentence on why. For a deny it is addressed to the agent. Empty when the model gave none. */
  reason: string
  /** For a model that scores instead of writing: its probability that the request should be allowed, 0 to 1. */
  score?: number
  usage?: Usage
}

/** What a scoring judge has instead of a reason, for the audit log. It is never sent to the agent. */
export const scoreNote = (score: number) => `allow probability ${score.toFixed(2)}`

export interface Request {
  /** What is being asked for: `shell`, `webfetch`, `edit`, an MCP tool name, or any other action string. */
  action: string
  /** What the action touches: commands, URLs, queries, paths, IDs, or `*` when the tool gives no detail. */
  resources: readonly string[]
  /** For `shell`, the full command line when known. Pipes and operators survive here. */
  line?: string
}

/** The judge cannot run because required settings are missing. Distinct from a call that failed. */
export class JudgeNotConfigured extends Error {
  override readonly name = "JudgeNotConfigured"
}

/** The judge could not be reached in time, after retrying. Distinct from a judge that answered badly. */
export class JudgeUnavailable extends Error {
  override readonly name = "JudgeUnavailable"
}

export interface Judge {
  readonly id: string
  /** Where the judge runs, as the host of its base URL. Unknown when the judge is not configured. */
  readonly provider?: string
  decide(request: Request, context: JudgeContext, signal?: AbortSignal): Promise<Judgement>
}

export type JudgeOptions = Record<string, unknown>
export type JudgeFactory = (options: JudgeOptions) => Judge

const registry = new Map<string, JudgeFactory>()

export function registerJudge(name: string, factory: JudgeFactory): void {
  registry.set(name, factory)
}

export function createJudge(name: string, options: JudgeOptions): Judge {
  const factory = registry.get(name)
  if (!factory) {
    throw new Error(`Unknown judge.provider "${name}". Registered: ${[...registry.keys()].join(", ") || "none"}`)
  }
  return factory(options)
}
