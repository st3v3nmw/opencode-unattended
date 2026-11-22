import { describe, expect, test } from "bun:test"
import { DEFAULT_DATA_DIR } from "../src/audit/audit.ts"
import { parseOptions } from "../src/options.ts"

const JUDGE = { model: "a/b", baseURL: "https://x.example/v1" }

describe("parseOptions defaults", () => {
  test("only the judge options are needed; everything else has a default", () => {
    expect(parseOptions({ judge: JUDGE })).toEqual({
      apiStyle: "openai",
      judge: JUDGE,
      escalateAfter: 5,
      dataDir: DEFAULT_DATA_DIR,
      auditLog: { enabled: true },
    })
  })

  test("a missing judge is left for the API style to report", () => {
    expect(parseOptions({}).judge).toEqual({})
  })

  test("apiStyle and escalateAfter are taken out of the options handed to the style", () => {
    const settings = parseOptions({ judge: { ...JUDGE, apiStyle: "other", escalateAfter: 5 } })
    expect(settings.apiStyle).toBe("other")
    expect(settings.judge).toEqual(JUDGE)
  })
})

describe("parseOptions overrides", () => {
  test("every option can be set", () => {
    expect(
      parseOptions({ judge: { ...JUDGE, escalateAfter: 7 }, dataDir: "/tmp/data", auditLog: { enabled: false } }),
    ).toMatchObject({ escalateAfter: 7, dataDir: "/tmp/data", auditLog: { enabled: false } })
  })

  test("the options of earlier versions still work", () => {
    expect(parseOptions({ judge: JUDGE, escalateAfter: 7 }).escalateAfter).toBe(7)
    expect(parseOptions({ judge: JUDGE, auditDir: "/tmp/audit" })).toMatchObject({ dataDir: "/tmp/audit", auditLog: { enabled: true } })
    expect(parseOptions({ judge: JUDGE, auditDir: false }).auditLog.enabled).toBe(false)
  })

  test("the newer options win over the earlier ones", () => {
    const settings = parseOptions({
      judge: { ...JUDGE, escalateAfter: 4 },
      escalateAfter: 9,
      dataDir: "/tmp/data",
      auditDir: "/tmp/audit",
      auditLog: { enabled: true },
    })
    expect(settings).toMatchObject({ escalateAfter: 4, dataDir: "/tmp/data", auditLog: { enabled: true } })
    expect(parseOptions({ judge: JUDGE, auditDir: false, auditLog: { enabled: true } }).auditLog.enabled).toBe(true)
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
    fails({ judge: { ...JUDGE, escalateAfter: value } }, "judge.escalateAfter must be an integer of at least 1")
    fails({ judge: JUDGE, escalateAfter: value }, "judge.escalateAfter must be an integer of at least 1")
  })

  test.each([[true], [""], [5]])("dataDir rejects %p", (value) => {
    fails({ judge: JUDGE, dataDir: value }, "dataDir must be a directory path")
  })

  test.each([[true], [""]])("auditDir rejects %p", (value) => {
    fails({ judge: JUDGE, auditDir: value }, "auditDir must be a directory path or false")
  })

  test.each([[true], ["off"], [[]]])("auditLog rejects %p", (value) => {
    fails({ judge: JUDGE, auditLog: value }, "auditLog must be an object")
  })

  test.each([["yes"], [1], [null]])("auditLog.enabled rejects %p", (value) => {
    fails({ judge: JUDGE, auditLog: { enabled: value } }, "auditLog.enabled must be true or false")
  })

  test("apiStyle must be a non-empty string", () => {
    fails({ judge: { ...JUDGE, apiStyle: "" } }, "judge.apiStyle must be a non-empty string")
    fails({ judge: { ...JUDGE, apiStyle: 1 } }, "judge.apiStyle must be a non-empty string")
  })
})
