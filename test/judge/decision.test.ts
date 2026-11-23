import { describe, expect, test } from "bun:test"
import { ALLOW_AT, createDecisionJudge, endpoint } from "../../src/judge/decision.ts"
import { INSTRUCTIONS } from "../../src/judge/prompt.ts"
import { JudgeUnavailable } from "../../src/judge/judge.ts"

const none = { recent: [], messages: ["fix the failing test"] }
const request = { action: "shell", resources: ["go test ./..."], line: "go test ./..." }

const answering = (body: unknown, status = 200) => {
  const seen: { url: string; init: RequestInit }[] = []
  const fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, init })
    return new Response(JSON.stringify(body), { status })
  }) as unknown as typeof globalThis.fetch
  return { fetch, seen }
}

const probability = (noul: unknown) => ({ answers: { allow: { type: "noul", noul } }, usage: { input_tokens: 1282, output_tokens: 4, cost: 0.00005 } })
const judgeFor = (fetch: typeof globalThis.fetch, env: Record<string, string | undefined> = {}) =>
  createDecisionJudge({ model: "typesafe/jev-1.14", baseURL: "https://openrouter.ai/api/alpha", fetch, env })

describe("decision judge", () => {
  test("asks one question: the prompt without its answer format as the instructions, the request as the state", async () => {
    const { fetch, seen } = answering(probability(0.98))
    await judgeFor(fetch, { OPENCODE_UNATTENDED_API_KEY: "k" }).decide(request, none)
    expect(seen[0]!.url).toBe("https://openrouter.ai/api/alpha/decisions")
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer k")
    const body = JSON.parse(seen[0]!.init.body as string)
    expect(body.model).toBe("typesafe/jev-1.14")
    expect(body.state).toEqual({ action: "shell", command_line: "go test ./...", recent_tool_calls: [], user_messages: ["fix the failing test"] })
    expect(Object.keys(body.questions)).toEqual(["allow"])
    expect(body.questions.allow.type).toBe("noul")
    expect(body.questions.allow.instructions.startsWith(INSTRUCTIONS)).toBe(true)
    expect(body.questions.allow.instructions).not.toContain("Respond with JSON")
  })

  test("allows at or above the cutoff, denies below it, and keeps the score", async () => {
    for (const [noul, verdict] of [[0.98, "allow"], [ALLOW_AT, "allow"], [0.49, "deny"], [0.04, "deny"]] as const) {
      const judgement = await judgeFor(answering(probability(noul)).fetch).decide(request, none)
      expect(judgement).toMatchObject({ verdict, reason: "", score: noul })
    }
  })

  test("usage is the tokens and cost the server reported", async () => {
    const judgement = await judgeFor(answering(probability(0.9)).fetch).decide(request, none)
    expect(judgement.usage).toEqual({ promptTokens: 1282, completionTokens: 4, cost: 0.00005 })
    expect((await judgeFor(answering({ answers: { allow: { noul: 0.9 } } }).fetch).decide(request, none)).usage).toBeUndefined()
  })

  test.each([[undefined], ["0.9"], [1.2], [-0.1], [Number.NaN]])("a probability of %p is an error, not a verdict", async (noul) => {
    await expect(judgeFor(answering(probability(noul)).fetch).decide(request, none)).rejects.toThrow("no probability for allow")
    await expect(judgeFor(answering({}).fetch).decide(request, none)).rejects.toThrow("no probability for allow")
  })

  test("a rejected request is an error, and a struggling service is retried then unavailable", async () => {
    await expect(judgeFor(answering({}, 400).fetch).decide(request, none)).rejects.toThrow("judge HTTP 400")
    const sleeps: number[] = []
    const judge = createDecisionJudge({
      model: "m",
      baseURL: "https://x.example/alpha",
      fetch: (async () => new Response("", { status: 503 })) as unknown as typeof fetch,
      sleep: async (ms) => void sleeps.push(ms),
      env: {},
    })
    await expect(judge.decide(request, none)).rejects.toBeInstanceOf(JudgeUnavailable)
    expect(sleeps).toEqual([15_000, 30_000, 60_000])
  })

  test("the endpoint is the base URL plus /decisions, however the base is written", () => {
    expect(endpoint("https://x.example/alpha")).toBe("https://x.example/alpha/decisions")
    expect(endpoint(" https://x.example/alpha/ ")).toBe("https://x.example/alpha/decisions")
    expect(endpoint("https://x.example/alpha/decisions")).toBe("https://x.example/alpha/decisions")
  })
})
