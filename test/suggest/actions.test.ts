import { describe, expect, test } from "bun:test"
import type { AuditEntry } from "../../src/audit/audit.ts"
import type { ActionRule, ShellRule } from "../../src/suggest/rules.ts"
import { formatSuggestions } from "../../src/suggest/suggest.ts"
import { reviewedCounts, reviewedSessions, shellResolver, suggestAll, suggestWebfetch, withoutUnresolved } from "../../src/suggest/actions.ts"

let n = 0
const judged = (action: string, effect: AuditEntry["effect"], ...resources: string[]): AuditEntry => ({
  time: 1,
  sessionID: `s${n++ % 2}`,
  directory: "~/app",
  action,
  resources,
  effect,
  by: "judge",
})
const fetched = (url: string, times = 3, effect: AuditEntry["effect"] = "allow") =>
  Array.from({ length: times }, () => judged("webfetch", effect, url))
const shelled = (command: string, times = 3) => Array.from({ length: times }, () => judged("shell", "allow", command))
const rule = (resource: string, effect: ShellRule["effect"]): ShellRule => ({ resource, effect })
const patterns = (entries: AuditEntry[], rules: ShellRule[] = []) => suggestWebfetch(entries, rules).map((c) => c.pattern)

describe("suggestWebfetch", () => {
  test("proposes an origin the judge allowed often enough, with its evidence", () => {
    const [candidate] = suggestWebfetch([...fetched("https://docs.example.com/a"), ...fetched("https://docs.example.com/b", 1)], [])
    expect(candidate).toMatchObject({
      action: "webfetch",
      pattern: "https://docs.example.com/*",
      allows: 4,
      sessions: 2,
      historyRuns: 0,
      examples: ["https://docs.example.com/a", "https://docs.example.com/b"],
    })
  })

  test("needs at least three allows", () => {
    expect(patterns(fetched("https://docs.example.com/a", 2))).toEqual([])
  })

  test("separate hosts, subdomains and ports are separate rules", () => {
    const entries = [...fetched("https://a.example.com/x"), ...fetched("https://example.com/x"), ...fetched("https://example.com:8443/x")]
    expect(patterns(entries).sort()).toEqual(["https://a.example.com/*", "https://example.com/*", "https://example.com:8443/*"])
  })

  test("hosts that serve many owners stop at the owner", () => {
    const entries = [
      ...fetched("https://github.com/canonical/snapd"),
      ...fetched("https://raw.githubusercontent.com/canonical/snapd/main/README.md"),
      ...fetched("https://api.github.com/repos/canonical/snapd/contents/x"),
    ]
    expect(patterns(entries).sort()).toEqual([
      "https://api.github.com/repos/canonical/*",
      "https://github.com/canonical/*",
      "https://raw.githubusercontent.com/canonical/*",
    ])
  })

  test("owners are counted apart, and a bare host root says nothing about an owner", () => {
    expect(patterns([...fetched("https://github.com/a/x", 2), ...fetched("https://github.com/b/x", 2), ...fetched("https://github.com/", 5)])).toEqual([])
  })

  test.each(["https://docs.example.com/a?q=secret", "https://me:pw@docs.example.com/a", "http://docs.example.com/a"])(
    "%p vetoes the host",
    (bad) => {
      expect(patterns([...fetched("https://docs.example.com/x"), ...fetched(bad, 1)])).toEqual([])
    },
  )

  test("an ask or a deny on the host vetoes it", () => {
    expect(patterns([...fetched("https://docs.example.com/x"), ...fetched("https://docs.example.com/login", 1, "ask")])).toEqual([])
    expect(patterns([...fetched("https://docs.example.com/x"), ...fetched("https://docs.example.com/y", 1, "deny")])).toEqual([])
  })

  test("a refusal on one owner leaves the others alone", () => {
    expect(patterns([...fetched("https://github.com/a/x"), ...fetched("https://github.com/b/x", 1, "ask")])).toEqual(["https://github.com/a/*"])
  })

  test.each(["http://localhost:3000/a", "https://127.0.0.1/a", "https://10.0.0.5/a", "https://wiki.internal/a", "https://[::1]/a", "not a url"])(
    "never proposes %p",
    (url) => {
      expect(patterns(fetched(url, 5))).toEqual([])
    },
  )

  describe("with the config's rules", () => {
    test("URLs a rule already allows are not evidence", () => {
      expect(patterns(fetched("https://docs.example.com/a"), [rule("*", "ask"), rule("https://docs.example.com/*", "allow")])).toEqual([])
      expect(patterns(fetched("https://docs.example.com/a"), [rule("*", "ask")])).toEqual(["https://docs.example.com/*"])
    })

    test("a URL a specific ask or deny rule covers is never evidence", () => {
      expect(patterns(fetched("https://docs.example.com/a"), [rule("https://docs.example.com/*", "deny")])).toEqual([])
      expect(patterns(fetched("https://example.com/.env"), [rule("*.env", "ask")])).toEqual([])
    })

    test("a specific rule inside the proposed rule's reach vetoes it", () => {
      expect(patterns(fetched("https://docs.example.com/a"), [rule("https://docs.example.com/admin/*", "ask")])).toEqual([])
      expect(patterns(fetched("https://docs.example.com/a"), [rule("https://other.example.com/*", "ask")])).toEqual(["https://docs.example.com/*"])
    })
  })

  test("most-allowed first", () => {
    expect(patterns([...fetched("https://a.example.com/x", 3), ...fetched("https://b.example.com/x", 5)])).toEqual([
      "https://b.example.com/*",
      "https://a.example.com/*",
    ])
  })
})

describe("suggestAll", () => {
  const entries = [...fetched("https://docs.example.com/a"), ...shelled("make lint")]
  const rules: ActionRule[] = [
    { action: "*", resource: "*", effect: "ask" },
    { action: "webfetch", resource: "https://docs.example.com/*", effect: "allow" },
    { action: "shell", resource: "cd *", effect: "allow" },
  ]

  test("each action sees only its own rules and the every-action ones", () => {
    expect(suggestAll(entries, [], rules).map((c) => [c.action, c.pattern])).toEqual([["shell", "make lint *"]])
    expect(suggestAll(entries, [], rules.slice(0, 1)).map((c) => [c.action, c.pattern])).toEqual([
      ["shell", "make lint *"],
      ["webfetch", "https://docs.example.com/*"],
    ])
  })

  test("never proposes a narrower rule than an allow the config already has", () => {
    const wide: ActionRule[] = [
      { action: "*", resource: "*", effect: "ask" },
      { action: "shell", resource: "make *", effect: "allow" },
      { action: "webfetch", resource: "https://docs.example.com/*", effect: "allow" },
    ]
    expect(suggestAll([...entries, ...shelled("make lint --fix")], [], wide)).toEqual([])
  })

  describe("notes for the reviewer", () => {
    const denied: ActionRule[] = [
      { action: "shell", resource: "*", effect: "ask" },
      { action: "shell", resource: "git commit *", effect: "deny" },
      { action: "shell", resource: "git branch -D *", effect: "deny" },
    ]
    const noteOf = (command: string, rules: ActionRule[] = denied) =>
      suggestAll(shelled(command), [], rules).find((c) => c.action === "shell")?.note

    test("ask and deny rules that start the same way are named", () => {
      expect(noteOf("git branch -a --contains HEAD")).toContain("Ask or deny rules nearby: `git branch -D *`")
      expect(noteOf("git status -s")).toBeUndefined()
    })

    test("a note never removes the candidate", () => {
      const [c] = suggestAll(shelled("git -C app log"), [], denied)
      expect(c!.pattern).toBe("git -C app *")
    })
  })

  test("can be limited to some actions", () => {
    expect(suggestAll(entries, [], [], 3, ["webfetch"]).map((c) => c.action)).toEqual(["webfetch"])
  })
})

describe("reviewedCounts", () => {
  test("counts what the judge reviewed per action, refusals included", () => {
    const entries = [...fetched("https://a.example.com/x", 2), ...fetched("https://a.example.com/y", 1, "ask"), ...shelled("ls", 1), judged("edit", "allow", "x")]
    expect(reviewedCounts(entries)).toEqual({ shell: 1, webfetch: 3 })
  })
})

describe("reviewedSessions", () => {
  test("counts the sessions the judge reviewed each action in, refusals included", () => {
    const entries = [
      { ...judged("shell", "allow", "ls"), sessionID: "a" },
      { ...judged("shell", "ask", "ls"), sessionID: "a" },
      { ...judged("shell", "allow", "ls"), sessionID: "b" },
      { ...judged("webfetch", "allow", "https://x.example/"), sessionID: "a" },
      { ...judged("edit", "allow", "f"), sessionID: "c" },
    ]
    expect(reviewedSessions(entries)).toEqual({ shell: 2, webfetch: 1 })
  })
})

describe("formatSuggestions with several actions", () => {
  const cells = (text: string) => text.split("\n").map((line) => line.trim().split(/\s{2,}/))

  test("groups candidates under their action, each with its own table", () => {
    const entries = [...fetched("https://docs.example.com/a"), ...shelled("make lint")]
    const scope = { reviewed: { shell: 12, webfetch: 3 }, sessions: { shell: 4, webfetch: 2 } }
    expect(cells(formatSuggestions(suggestAll(entries, [], []), scope))).toEqual([
      ["[shell]"],
      ["PATTERN", "% OF JUDGED", "% OF SESSIONS", "EXAMPLE"],
      ["make lint *", "25.0%", "50.0%", "make lint"],
      [""],
      ["[webfetch]"],
      ["PATTERN", "% OF JUDGED", "% OF SESSIONS", "EXAMPLE"],
      ["https://docs.example.com/*", "100.0%", "100.0%", "https://docs.example.com/a"],
    ])
  })

  test("a lone webfetch group still gets its heading", () => {
    const text = formatSuggestions(suggestWebfetch(fetched("https://docs.example.com/a"), []), { reviewed: {}, sessions: {} })
    expect(text.startsWith("[webfetch]\nPATTERN")).toBe(true)
  })
})

describe("shellResolver", () => {
  const resolves = shellResolver("sh")

  test("finds programs and builtins, and not names nothing defines", () => {
    expect(resolves("ls")).toBe(true)
    expect(resolves("cd")).toBe(true)
    expect(resolves("definitely-not-a-command-xyz")).toBe(false)
  })

  test("takes a path as found, since it depends on the working directory", () => {
    expect(resolves("./tools/run")).toBe(true)
  })

  test("a shell that cannot start falls back to sh", () => {
    expect(shellResolver("/no/such/shell")("ls")).toBe(true)
  })
})

describe("withoutUnresolved", () => {
  const candidates = [
    ...suggestAll(shelled("g file pattern"), [], []),
    ...suggestAll(shelled("make lint"), [], []),
    ...suggestWebfetch(fetched("https://docs.example.com/a"), []),
  ]
  const only = (...found: string[]) => (name: string) => found.includes(name)

  test("drops shell candidates whose name does not resolve and lists the names", () => {
    const result = withoutUnresolved(candidates, only("make"))
    expect(result.candidates.map((c) => c.pattern)).toEqual(["make lint *", "https://docs.example.com/*"])
    expect(result.skipped).toEqual(["g"])
  })

  test("keeps everything when everything resolves, and never judges other actions", () => {
    expect(withoutUnresolved(candidates, only("g", "make"))).toEqual({ candidates, skipped: [] })
    expect(withoutUnresolved(candidates, only()).candidates.map((c) => c.action)).toEqual(["webfetch"])
  })
})
