import { describe, expect, test } from "bun:test"
import { DEFAULT_AUDIT_DIR } from "../src/auditlog.ts"
import { parseOptions } from "../src/options.ts"

const JUDGE = { model: "a/b", baseURL: "https://x.example/v1" }

describe("parseOptions defaults", () => {
  test("only the judge options are needed; everything else has a default", () => {
    expect(parseOptions({ judge: JUDGE })).toEqual({
      apiStyle: "openai",
      judge: JUDGE,
      escalateAfter: 3,
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
  test("every option can be set", () => {
    expect(parseOptions({ judge: JUDGE, escalateAfter: 5, auditDir: "/tmp/audit" })).toMatchObject({
      escalateAfter: 5,
      auditDir: "/tmp/audit",
    })
  })

  test("auditDir false turns the log off", () => {
    expect(parseOptions({ judge: JUDGE, auditDir: false }).auditDir).toBe(false)
  })

  test("unknown options are ignored, so options from earlier versions do not break a config", () => {
    expect(parseOptions({ judge: JUDGE, context: { maxUserMessages: 2 } })).toEqual(parseOptions({ judge: JUDGE }))
  })
})

describe("parseOptions rejections", () => {
  const fails = (options: Record<string, unknown>, message: string) =>
    expect(() => parseOptions(options)).toThrow(message)

  test("a string judge from the old format gets a clear message", () => {
    fails({ judge: "openai" }, "judge must be an object")
  })

  test.each([[0], [1.5], ["3"]])("escalateAfter rejects %p", (value) => {
    fails({ judge: JUDGE, escalateAfter: value }, "escalateAfter must be an integer of at least 1")
  })

  test.each([[true], [""]])("auditDir rejects %p", (value) => {
    fails({ judge: JUDGE, auditDir: value }, "auditDir must be a directory path or false")
  })

  test("apiStyle must be a non-empty string", () => {
    fails({ judge: { ...JUDGE, apiStyle: "" } }, "judge.apiStyle must be a non-empty string")
    fails({ judge: { ...JUDGE, apiStyle: 1 } }, "judge.apiStyle must be a non-empty string")
  })
})
