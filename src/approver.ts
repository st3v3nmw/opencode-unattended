import type { ApproverEntry, Reason } from "./audit.ts"
import { JudgeNotConfigured, JudgeUnavailable, type Judge, type JudgeContext, type Judgement, type Request } from "./judge.ts"
import { BREAKER_COOLDOWN_MS, MAX_TOOL_CALL_CHARS, MAX_TRACKED, SNIPPET_CHARS } from "./limits.ts"
import type { Verdict } from "./verdict.ts"

export interface Review {
  decision: Verdict
  message?: string
}

export interface ApproverOptions {
  judge: Judge
  audit?: (entry: ApproverEntry) => void
  /** After this many requests in a row that the judge does not allow, the next one goes to the user. */
  consecutiveLimit?: number
  /** After this many judge denies in a session, whatever came between them, the next one goes to the user. */
  denyLimit?: number
  /** How long requests skip a judge that just failed and go to the user instead. */
  cooldownMs?: number
  now?: () => number
}

export const TOO_LONG = "Split the work into smaller steps, or write the code to a file in pieces and run that."

/** A request whose resources are empty or all `*` tells the judge nothing, so there is nothing to judge. */
const hasDetail = (resources: readonly string[]) => resources.some((r) => r.trim() !== "" && r.trim() !== "*")

interface Refusal {
  verdict: "ask" | "deny"
  /** What the agent is told. */
  message: string
  /** A short reason for the user, if they end up seeing a request that was turned back. */
  why: string
}

interface Cached extends Refusal {
  /** The last user message when the judge answered. A new message may now cover what was refused. */
  basis: string
}

interface Session {
  /** Requests in a row the judge has not allowed. An allow resets it. */
  streak: number
  /** Judge denies since the user last saw a request. Allows do not reset it. */
  denies: number
  turnedBack: Map<string, Cached>
}

const refusalFor = (verdict: "ask" | "deny", why: string): Refusal => ({
  verdict,
  why,
  message:
    verdict === "ask"
      ? `${why ? `${why} ` : ""}This needs the user's approval. Do not reach the same effect another way; if it is essential, stop and tell the user what you need and why.`
      : `${why || "This is not something to do unattended."} Do not attempt it or an equivalent.`,
})

/**
 * A judge that is not allowing something turns it back to the agent with a reason, and the agent reworks. The user sees a
 * request only when the plugin cannot decide, or when the agent keeps being turned back. The agent is never told about the
 * limits or the cache: a repeated request gets the same words as the first.
 */
export function createApprover({
  judge,
  audit,
  consecutiveLimit = 3,
  denyLimit = 3,
  cooldownMs = BREAKER_COOLDOWN_MS,
  now = Date.now,
}: ApproverOptions) {
  const sessions = new Map<string, Session>()
  let unavailableUntil = 0
  let lastFailure = ""

  const keyOf = (request: Request) => JSON.stringify([request.action, request.resources, request.line ?? null])

  const sessionOf = (sessionID: string) => {
    let session = sessions.get(sessionID)
    if (!session) sessions.set(sessionID, (session = { streak: 0, denies: 0, turnedBack: new Map() }))
    return session
  }

  return {
    /** The user approved this request when it was put to them, so the agent repeating it is not turned back again. */
    forget(sessionID: string, request: Request) {
      sessions.get(sessionID)?.turnedBack.delete(keyOf(request))
    },

    async review(sessionID: string, request: Request, { messages = [], recent = [] }: Partial<JudgeContext> = {}): Promise<Review> {
      const noun = request.action === "shell" ? "command" : "request"
      const write = (effect: Verdict, extra: Partial<ApproverEntry>) =>
        audit?.({
          time: now(),
          sessionID,
          action: request.action,
          resources: request.resources,
          effect,
          by: "judge",
          ...extra,
        })
      const plugin = (reason: Reason, extra: Partial<ApproverEntry> = {}) =>
        write("ask", { by: "plugin", reason, ...extra })

      if (!hasDetail(request.resources)) {
        plugin("unparsed")
        return { decision: "ask" }
      }

      const session = sessionOf(sessionID)

      /**
       * Hands a refusal back to the agent, unless the agent has been refused enough that the user should see this one.
       * `info` says which judge was consulted, and goes in whichever entry is written; `entry` is only for the refusal.
       */
      const turnBack = (refusal: Refusal, info: Partial<ApproverEntry>, entry: Partial<ApproverEntry>): Review => {
        session.streak++
        if (refusal.verdict === "deny") session.denies++
        const reason: Reason | undefined =
          session.denies >= denyLimit ? "deny_limit" : session.streak >= consecutiveLimit ? "ask_limit" : undefined
        if (reason) {
          session.streak = 0
          session.denies = 0
          plugin(reason, info)
          return {
            decision: "ask",
            message: `opencode-unattended turned back recent requests, and is asking you about this one.${refusal.why ? ` ${refusal.why}` : ""}`,
          }
        }
        write("deny", { ...info, ...entry })
        return { decision: "deny", message: refusal.message }
      }
      const entryFor = ({ verdict, why }: Refusal): Partial<ApproverEntry> => ({
        ...(verdict === "ask" ? { verdict: "ask" as const } : {}),
        ...(why ? { why } : {}),
      })

      const text = request.line ?? request.resources.join(" ; ")
      if (text.length > MAX_TOOL_CALL_CHARS) {
        return turnBack({ verdict: "ask", message: TOO_LONG, why: "It was too long to review." }, {}, { by: "plugin", reason: "too_long" })
      }

      const key = keyOf(request)
      const basis = messages.at(-1) ?? ""
      const earlier = session.turnedBack.get(key)
      if (earlier && earlier.basis === basis) return turnBack(earlier, {}, entryFor(earlier))
      session.turnedBack.delete(key)

      if (now() < unavailableUntil) {
        plugin("unavailable")
        return { decision: "ask", message: `opencode-unattended is not reviewing this ${noun} because its reviewer is unavailable (${lastFailure}), so it is asking you.` }
      }

      const started = now()
      const consulted = { judge: judge.id, ...(judge.provider ? { provider: judge.provider } : {}) }
      let judgement: Judgement
      try {
        judgement = await judge.decide(request, { recent, messages })
      } catch (error) {
        const reason = (error instanceof Error ? error.message : String(error)).slice(0, SNIPPET_CHARS)
        if (error instanceof JudgeNotConfigured) plugin("unconfigured")
        else {
          if (error instanceof JudgeUnavailable) {
            unavailableUntil = now() + cooldownMs
            lastFailure = reason
          }
          plugin("error", { ...consulted, latency: now() - started, error: reason })
        }
        return { decision: "ask", message: `opencode-unattended could not review this ${noun}, so it is asking you: ${reason}` }
      }
      const info = { ...consulted, latency: now() - started }

      if (judgement.verdict === "allow") {
        session.streak = 0
        write("allow", info)
        return { decision: "allow" }
      }

      const refusal = refusalFor(judgement.verdict, judgement.reason)
      const review = turnBack(refusal, info, entryFor(refusal))
      if (review.decision === "deny") {
        session.turnedBack.set(key, { ...refusal, basis })
        if (session.turnedBack.size > MAX_TRACKED) session.turnedBack.delete(session.turnedBack.keys().next().value!)
      }
      return review
    },
  }
}
