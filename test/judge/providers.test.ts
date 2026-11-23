import { describe, expect, test } from "bun:test"
import { createJudge } from "../../src/judge/judge.ts"
import "../../src/judge/providers.ts"

describe("providers", () => {
  test("openrouter supplies its own baseURL, so only the model is needed", () => {
    expect(createJudge("openrouter", { model: "a/b" })).toMatchObject({ id: "a/b", provider: "openrouter.ai" })
    expect(() => createJudge("openrouter", {})).toThrow("missing required options: judge.model")
  })

  test("a baseURL given in the config replaces the provider's", () => {
    expect(createJudge("openrouter", { model: "a/b", baseURL: "http://localhost:8080/v1" }).provider).toBe("localhost:8080")
  })

  test("openai-compatible has no default, so it needs a baseURL", () => {
    expect(() => createJudge("openai-compatible", { model: "a/b" })).toThrow("missing required options: judge.baseURL")
    expect(createJudge("openai-compatible", { model: "a/b", baseURL: "http://localhost:11434/v1" }).provider).toBe("localhost:11434")
  })

  test("modality defaults to completion, and a modality the provider lacks is refused", () => {
    expect(createJudge("openrouter", { model: "a/b", modality: "completion" }).id).toBe("a/b")
    const local = { model: "a/b", baseURL: "http://localhost:8080/v1" }
    expect(() => createJudge("openai-compatible", { ...local, modality: "decision" })).toThrow(
      'judge.modality "decision" is not supported by openai-compatible. Supported: completion',
    )
    expect(() => createJudge("openrouter", { model: "a/b", modality: "scores" })).toThrow('judge.modality "scores" is not supported by openrouter')
  })

  test("the decision modality has its own default baseURL, and takes no promptCache", () => {
    expect(createJudge("openrouter", { model: "a/b", modality: "decision" })).toMatchObject({ id: "a/b", provider: "openrouter.ai" })
    expect(() => createJudge("openrouter", { model: "a/b", modality: "decision", promptCache: { ttl: "1h" } })).toThrow("not supported by the decision modality")
  })
})
