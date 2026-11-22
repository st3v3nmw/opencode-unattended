import type { AuditEntry, Effect } from "../audit/audit.ts"
import type { ActionRule } from "./rules.ts"
import { formatSuggestions } from "./suggest.ts"
import { reviewedCounts, reviewedSessions, shellResolver, suggestAll, withoutUnresolved, type Resolver } from "./actions.ts"

export const SUGGEST_TOOL = "unattended_suggest"

const DAY_MS = 86_400_000
const MAX_DAYS = 180
const EFFECTS: readonly Effect[] = ["allow", "ask", "deny"]

const isRules = (value: unknown): value is { action?: string; resource: string; effect: Effect }[] =>
  Array.isArray(value) &&
  value.every(
    (r) => typeof r?.resource === "string" && EFFECTS.includes(r?.effect) && (r?.action === undefined || typeof r.action === "string"),
  )

export interface SuggestDeps {
  entries: (since: number) => AuditEntry[]
  commands: (since: number) => Promise<string[]>
  now?: () => number
  resolves?: Resolver
}

export function suggestTool({ entries, commands, now = Date.now, resolves = shellResolver() }: SuggestDeps) {
  return {
    name: SUGGEST_TOOL,
    description:
      "Lists the shell commands and webfetch URLs the unattended judge keeps allowing, with the evidence, as candidates for allow rules that would stop costing a judge call. The candidates are not recommendations and need review. Read-only: it reads the audit log and recent session history and changes nothing.",
    input: {
      type: "object",
      properties: {
        days: { type: "integer", minimum: 1, maximum: MAX_DAYS, description: "How many days back to look, such as 7 or 30." },
        rules: {
          type: "array",
          description:
            "Every shell, webfetch and * permission rule from the user's opencode config, in file order (the last match wins), each with its action. Pass [] only if there are none.",
          items: {
            type: "object",
            properties: { action: { type: "string" }, resource: { type: "string" }, effect: { enum: EFFECTS } },
            required: ["resource", "effect"],
            additionalProperties: false,
          },
        },
      },
      required: ["days", "rules"],
      additionalProperties: false,
    },
    async execute(input: unknown) {
      const { days, rules } = (input ?? {}) as { days?: unknown; rules?: unknown }
      if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
        return { content: `days must be a whole number from 1 to ${MAX_DAYS}.` }
      }
      if (!isRules(rules)) return { content: "rules must be a list of { action, resource, effect } with effect allow, ask or deny." }
      const since = now() - days * DAY_MS
      const audited = entries(since).filter((e) => e.time >= since)
      const history = await commands(since)
      const reviewed = reviewedCounts(audited)
      const sessions = reviewedSessions(audited)
      const configured: ActionRule[] = rules.map((r) => ({ action: r.action ?? "shell", resource: r.resource, effect: r.effect }))
      const { candidates, skipped } = withoutUnresolved(suggestAll(audited, history, configured), resolves)
      return { content: formatSuggestions(candidates, { reviewed, sessions, skipped }) }
    },
  }
}
