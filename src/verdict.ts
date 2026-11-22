/** What the judge answers. A request it does not allow is turned back to the agent, so there is no third answer. */
export const VERDICTS = ["allow", "deny"] as const

export type Verdict = (typeof VERDICTS)[number]

export const isVerdict = (value: unknown): value is Verdict =>
  typeof value === "string" && (VERDICTS as readonly string[]).includes(value)
