import { readFileSync } from "node:fs"
import type { Effect } from "../audit/audit.ts"
import { rulesFor, type ActionRule, type ShellRule } from "./rules.ts"

const EFFECTS: readonly unknown[] = ["allow", "ask", "deny"]

/** Drops comments and trailing commas outside strings, then parses. */
export function parseJsonc(text: string): unknown {
  let out = ""
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (c === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1
      out += text.slice(i, j + 1)
      i = j
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++
      out += "\n"
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2)
      i = end === -1 ? text.length : end + 1
      out += " "
    } else if (c === ",") {
      let j = i + 1
      while (/\s/.test(text[j] ?? "")) j++
      if (text[j] !== "]" && text[j] !== "}") out += c
    } else out += c
  }
  return JSON.parse(out)
}

/** Every well-formed permission rule, in file order. */
export function permissionRules(config: unknown): ActionRule[] {
  const list = (config as { permissions?: unknown } | null)?.permissions
  if (!Array.isArray(list)) return []
  const rules: ActionRule[] = []
  for (const rule of list) {
    if (typeof rule?.action !== "string" || typeof rule.resource !== "string" || !EFFECTS.includes(rule.effect)) continue
    rules.push({ action: rule.action, resource: rule.resource, effect: rule.effect as Effect })
  }
  return rules
}

/**
 * The rules that can decide a shell command, in file order: rules for `shell` and for every action, because a
 * pattern like `*.env` applies to both.
 */
export const shellRules = (config: unknown): ShellRule[] => rulesFor(permissionRules(config), "shell")

/** Reads each config in turn. Later files come later in the list, so they win, as the last match does. */
export function readRules(paths: readonly string[]): ActionRule[] {
  return paths.flatMap((path) => {
    try {
      return permissionRules(parseJsonc(readFileSync(path, "utf8")))
    } catch (error) {
      throw new Error(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
}

export const readShellRules = (paths: readonly string[]): ShellRule[] => rulesFor(readRules(paths), "shell")
