import { DEFAULT_AUDIT_DIR } from "./auditlog.ts"
import type { JudgeOptions } from "./judge.ts"

export const DEFAULT_API_STYLE = "openai"

export interface Settings {
  apiStyle: string
  /** Everything under `judge` except `apiStyle`; the selected API style validates it. */
  judge: JudgeOptions
  /** Requests in a row, or denies in a session, the judge may turn back before the next one goes to you. */
  escalateAfter: number
  auditDir: string | false
}

type Raw = Readonly<Record<string, unknown>>

const isRecord = (value: unknown): value is Raw =>
  typeof value === "object" && value !== null && !Array.isArray(value)

function integer(value: unknown, name: string, fallback: number, min: number): number {
  if (value === undefined) return fallback
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    throw new Error(`${name} must be an integer of at least ${min}`)
  }
  return value
}

export function parseOptions(raw: Raw): Settings {
  if (raw.judge !== undefined && !isRecord(raw.judge)) {
    throw new Error(`judge must be an object with model and baseURL, not ${typeof raw.judge}`)
  }
  const { apiStyle = DEFAULT_API_STYLE, ...judge } = raw.judge ?? {}
  if (typeof apiStyle !== "string" || !apiStyle) throw new Error("judge.apiStyle must be a non-empty string")

  const auditDir = raw.auditDir === undefined ? DEFAULT_AUDIT_DIR : raw.auditDir
  if (auditDir !== false && (typeof auditDir !== "string" || !auditDir)) {
    throw new Error("auditDir must be a directory path or false")
  }

  return {
    apiStyle,
    judge,
    escalateAfter: integer(raw.escalateAfter, "escalateAfter", 3, 1),
    auditDir,
  }
}
