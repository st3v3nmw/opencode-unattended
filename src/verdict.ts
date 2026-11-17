export const VERDICTS = ["allow", "ask", "deny"] as const

export type Verdict = (typeof VERDICTS)[number]

export const isVerdict = (value: unknown): value is Verdict =>
  typeof value === "string" && (VERDICTS as readonly string[]).includes(value)
