import type { Verdict } from "./verdict.ts"

export interface RecentCommand {
  command: string
  status: "completed" | "error"
}

export interface JudgeContext {
  recent: readonly RecentCommand[]
  /** The user's latest messages, clipped. Data, never instructions. */
  messages: readonly string[]
}

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

export interface Judge {
  readonly id: string
  /** Where the judge runs, as the host of its base URL. Unknown when the judge is not configured. */
  readonly provider?: string
  decide(request: Request, context: JudgeContext, signal?: AbortSignal): Promise<Verdict>
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
    throw new Error(`Unknown judge.apiStyle "${name}". Registered: ${[...registry.keys()].join(", ") || "none"}`)
  }
  return factory(options)
}
