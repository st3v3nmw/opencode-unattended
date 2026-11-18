import { DEFAULT_AUDIT_DIR } from "./auditlog.ts"
import type { JudgeOptions } from "./judge.ts"

export const DEFAULT_API_STYLE = "openai-compatible"

export interface Settings {
  apiStyle: string
  /** Everything under `judge` except `apiStyle`; the selected API style validates it. */
  judge: JudgeOptions
  maxCommandChars: number
  maxRecentCommands: number
  maxUserMessages: number
  maxUserMessageChars: number
  consecutiveDenies: number
  auditDir: string | false
}

type Raw = Readonly<Record<string, unknown>>

const isRecord = (value: unknown): value is Raw =>
  typeof value === "object" && value !== null && !Array.isArray(value)

function rejectUnknown(value: Raw, allowed: readonly string[], path?: string) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) {
    throw new Error(`unknown options: ${unknown.map((key) => (path ? `${path}.${key}` : key)).join(", ")}`)
  }
}

function group(raw: Raw, name: string, allowed: readonly string[]): Raw {
  const value = raw[name]
  if (value === undefined) return {}
  if (!isRecord(value)) throw new Error(`${name} must be an object`)
  rejectUnknown(value, allowed, name)
  return value
}

function integer(values: Raw, path: string, key: string, fallback: number, min: number): number {
  const value = values[key]
  if (value === undefined) return fallback
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    throw new Error(`${path}.${key} must be an integer of at least ${min}`)
  }
  return value
}

export function parseOptions(raw: Raw): Settings {
  rejectUnknown(raw, ["judge", "context", "escalation", "auditDir"])

  if (raw.judge !== undefined && !isRecord(raw.judge)) {
    throw new Error(`judge must be an object with model and baseURL, not ${typeof raw.judge}`)
  }
  const { apiStyle = DEFAULT_API_STYLE, ...judge } = raw.judge ?? {}
  if (typeof apiStyle !== "string" || !apiStyle) throw new Error("judge.apiStyle must be a non-empty string")

  const context = group(raw, "context", ["maxCommandChars", "maxRecentCommands", "maxUserMessages", "maxUserMessageChars"])
  const escalation = group(raw, "escalation", ["consecutiveDenies"])

  const auditDir = raw.auditDir === undefined ? DEFAULT_AUDIT_DIR : raw.auditDir
  if (auditDir !== false && (typeof auditDir !== "string" || !auditDir)) {
    throw new Error("auditDir must be a directory path or false")
  }

  return {
    apiStyle,
    judge,
    maxCommandChars: integer(context, "context", "maxCommandChars", 8000, 1),
    maxRecentCommands: integer(context, "context", "maxRecentCommands", 10, 0),
    maxUserMessages: integer(context, "context", "maxUserMessages", 5, 0),
    maxUserMessageChars: integer(context, "context", "maxUserMessageChars", 500, 1),
    consecutiveDenies: integer(escalation, "escalation", "consecutiveDenies", 3, 1),
    auditDir,
  }
}
