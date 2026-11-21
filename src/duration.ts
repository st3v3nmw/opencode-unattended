const UNITS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }

/** `15s`, `5m` or `1h`: a whole number and a unit (ms, s, m, h, d, w), as milliseconds. Undefined for anything else. */
export function parseDuration(text: string): number | undefined {
  const match = /^(\d+)(ms|s|m|h|d|w)$/.exec(text.trim())
  return match ? Number(match[1]) * UNITS[match[2]!]! : undefined
}
