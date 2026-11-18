import { describe, expect, test } from "bun:test"
import { DEFAULT_AUDIT_DIR } from "../src/auditlog.ts"
import { parseOptions } from "../src/options.ts"

const JUDGE = { model: "a/b", baseURL: "https://x.example/v1" }

describe("parseOptions defaults", () => {
  test("only the judge options are needed; everything else keeps its default", () => {
    expect(parseOptions({ judge: JUDGE })).toEqual({
      apiStyle: "openai-compatible",
      judge: JUDGE,
      maxCommandChars: 8000,
      maxRecentCommands: 10,
      maxUserMessages: 5,
      maxUserMessageChars: 500,
      consecutiveDenies: 3,
      auditDir: DEFAULT_AUDIT_DIR,
    })
  })

  test("a missing judge is left for the API style to report", () => {
    expect(parseOptions({}).judge).toEqual({})
  })

  test("apiStyle is taken out of the options handed to the style", () => {
    const settings = parseOptions({ judge: { ...JUDGE, apiStyle: "other" } })
    expect(settings.apiStyle).toBe("other")
    expect(settings.judge).toEqual(JUDGE)
  })
})

describe("parseOptions overrides", () => {
  test("every grouped option can be set", () => {
    const settings = parseOptions({
      judge: JUDGE,
      context: { maxCommandChars: 100, maxRecentCommands: 0, maxUserMessages: 0, maxUserMessageChars: 20 },
      escalation: { consecutiveDenies: 1 },
      auditDir: "/tmp/audit",
    })
    expect(settings).toMatchObject({
      maxCommandChars: 100,
      maxRecentCommands: 0,
      maxUserMessages: 0,
      maxUserMessageChars: 20,
      consecutiveDenies: 1,
      auditDir: "/tmp/audit",
    })
  })

  test("auditDir false turns the log off", () => {
    expect(parseOptions({ judge: JUDGE, auditDir: false }).auditDir).toBe(false)
  })

  test("a partial group keeps the other defaults in it", () => {
    expect(parseOptions({ judge: JUDGE, context: { maxUserMessages: 1 } })).toMatchObject({
      maxUserMessages: 1,
      maxUserMessageChars: 500,
      maxCommandChars: 8000,
    })
  })
})

describe("parseOptions rejections", () => {
  const fails = (options: Record<string, unknown>, message: string) =>
    expect(() => parseOptions(options)).toThrow(message)

  test("old flat names are unknown", () => {
    fails({ judge: JUDGE, denyStreak: 2 }, "unknown options: denyStreak")
    fails({ judge: JUDGE, judgeOptions: {} }, "unknown options: judgeOptions")
    fails({ judge: JUDGE, userMessageChars: 5 }, "unknown options: userMessageChars")
    fails({ judge: JUDGE, auditLog: "/tmp/audit.jsonl" }, "unknown options: auditLog")
  })

  test("typos inside a group are named with their path", () => {
    fails({ judge: JUDGE, context: { maxUserMessage: 2 } }, "unknown options: context.maxUserMessage")
    fails({ judge: JUDGE, escalation: { denyStreak: 2 } }, "unknown options: escalation.denyStreak")
  })

  test("a string judge from the old format gets a clear message", () => {
    fails({ judge: "openai-compatible" }, "judge must be an object")
  })

  test("a group that is not a plain object is rejected", () => {
    fails({ judge: JUDGE, context: [] }, "context must be an object")
  })

  test.each([[0], ["3"]])("maxCommandChars rejects %p", (value) => {
    fails({ judge: JUDGE, context: { maxCommandChars: value } }, "context.maxCommandChars must be an integer of at least 1")
  })

  test("zero is allowed for counts but not for consecutiveDenies", () => {
    expect(() => parseOptions({ judge: JUDGE, context: { maxRecentCommands: 0, maxUserMessages: 0 } })).not.toThrow()
    fails({ judge: JUDGE, escalation: { consecutiveDenies: 0 } }, "escalation.consecutiveDenies must be an integer of at least 1")
    fails({ judge: JUDGE, context: { maxRecentCommands: -1 } }, "context.maxRecentCommands must be an integer of at least 0")
  })

  test.each([[true], [""]])("auditDir rejects %p", (value) => {
    fails({ judge: JUDGE, auditDir: value }, "auditDir must be a directory path or false")
  })

  test("apiStyle must be a non-empty string", () => {
    fails({ judge: { ...JUDGE, apiStyle: "" } }, "judge.apiStyle must be a non-empty string")
    fails({ judge: { ...JUDGE, apiStyle: 1 } }, "judge.apiStyle must be a non-empty string")
  })
})
