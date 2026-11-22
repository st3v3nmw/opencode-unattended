import { DEFAULT_DATA_DIR } from "./auditlog.ts"
import type { JudgeOptions } from "./judge.ts"

export const DEFAULT_API_STYLE = "openai"

export interface Settings {
  apiStyle: string
  /** Everything under `judge` except `apiStyle` and `escalateAfter`; the selected API style validates it. */
  judge: JudgeOptions
  /** Requests in a row, or denies in a session, the judge may turn back before the next one goes to you. */
  escalateAfter: number
  dataDir: string
  auditLog: { enabled: boolean }
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
  const { apiStyle = DEFAULT_API_STYLE, escalateAfter, ...judge } = raw.judge ?? {}
  if (typeof apiStyle !== "string" || !apiStyle) throw new Error("judge.apiStyle must be a non-empty string")

  if (raw.auditLog !== undefined && !isRecord(raw.auditLog)) {
    throw new Error('auditLog must be an object such as { "enabled": false }')
  }
  const { enabled } = raw.auditLog ?? {}
  if (enabled !== undefined && typeof enabled !== "boolean") throw new Error("auditLog.enabled must be true or false")

  // TODO: remove auditDir, which dataDir and auditLog.enabled replace.
  const { auditDir } = raw
  if (auditDir !== undefined && auditDir !== false && (typeof auditDir !== "string" || !auditDir)) {
    throw new Error("auditDir must be a directory path or false")
  }
  const dataDir = raw.dataDir ?? (typeof auditDir === "string" ? auditDir : DEFAULT_DATA_DIR)
  if (typeof dataDir !== "string" || !dataDir) throw new Error("dataDir must be a directory path")

  return {
    apiStyle,
    judge,
    // TODO: remove the top-level escalateAfter, which judge.escalateAfter replaces.
    escalateAfter: integer(escalateAfter ?? raw.escalateAfter, "judge.escalateAfter", 5, 1),
    dataDir,
    auditLog: { enabled: enabled ?? auditDir !== false },
  }
}
