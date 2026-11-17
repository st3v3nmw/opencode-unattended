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

export interface Chain {
  /** The subcommands, in order, as opencode extracted them. */
  commands: readonly string[]
  /** The full command line, when known. Pipes and operators survive here. */
  line?: string
}

export interface Judge {
  readonly id: string
  decide(chain: Chain, context: JudgeContext, signal?: AbortSignal): Promise<Verdict>
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
    throw new Error(`Unknown judge "${name}". Registered: ${[...registry.keys()].join(", ") || "none"}`)
  }
  return factory(options)
}
