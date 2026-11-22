import type { Effect } from "../audit/audit.ts"

export interface ShellRule {
  resource: string
  effect: Effect
}

export interface ActionRule extends ShellRule {
  action: string
}

/** The rules that can decide a request for `action`, in order: its own and those for every action (`*`). */
export const rulesFor = (rules: readonly ActionRule[], action: string): ShellRule[] =>
  rules.filter((r) => r.action === action || r.action === "*").map(({ resource, effect }) => ({ resource, effect }))

const compiled = new Map<string, RegExp>()

/** OpenCode's wildcard: `*` is any characters including `/`, `?` is one, and a trailing ` *` also matches the bare command. */
export function matches(pattern: string, text: string): boolean {
  let regex = compiled.get(pattern)
  if (!regex) {
    const bare = pattern.endsWith(" *")
    const body = (bare ? pattern.slice(0, -2) : pattern)
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, "[\\s\\S]*")
      .replace(/\?/g, "[\\s\\S]")
    regex = new RegExp(`^${body}${bare ? "(?: [\\s\\S]*)?" : ""}$`)
    compiled.set(pattern, regex)
  }
  return regex.test(text)
}

/** The rule OpenCode applies: the last one that matches. */
export const lastMatch = (rules: readonly ShellRule[], command: string): ShellRule | undefined =>
  rules.findLast((rule) => matches(rule.resource, command))

/** A rule narrower than the catch-all `*`. */
export const isSpecific = (rule: ShellRule) => rule.resource.trim() !== "*"
