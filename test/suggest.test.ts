import { describe, expect, test } from "bun:test"
import type { AuditEntry } from "../src/audit.ts"
import type { ShellRule } from "../src/rules.ts"
import { MIN_USES, formatSuggestions, shorten, suggest } from "../src/suggest.ts"

let n = 0
const judged = (effect: AuditEntry["effect"], ...resources: string[]): AuditEntry => ({
  time: 1,
  sessionID: `s${n++ % 2}`,
  directory: "~/app",
  action: "shell",
  resources,
  effect,
  by: "judge",
})
const allowed = (command: string, times = MIN_USES) => Array.from({ length: times }, () => judged("allow", command))
const rule = (resource: string, effect: ShellRule["effect"]): ShellRule => ({ resource, effect })
const patterns = (entries: AuditEntry[], history: string[] = [], rules: ShellRule[] = []) =>
  suggest(entries, history, rules).map((c) => c.pattern)

describe("suggest", () => {
  test("proposes a prefix the judge allowed often enough, with its evidence", () => {
    const [candidate] = suggest(allowed("git branch --contains abc"), [], [])
    expect(candidate).toMatchObject({ pattern: "git branch --contains *", allows: 3, sessions: 2, historyRuns: 0, examples: ["git branch --contains abc"] })
  })

  test("needs at least three allows", () => {
    expect(patterns(allowed("make lint", 2))).toEqual([])
  })

  describe("with the config's rules", () => {
    const chain = (effect: AuditEntry["effect"]) => Array.from({ length: 3 }, () => judged(effect, "cd app", "make lint"))

    test("commands a rule already allows are not evidence, but the rest of a chain is", () => {
      expect(patterns(chain("allow"), [], [rule("*", "ask"), rule("cd *", "allow")])).toEqual(["make lint *"])
      expect(patterns(chain("allow"))).toEqual(["cd app *", "make lint *"])
    })

    test("a chain that was asked about only vetoes the commands the rules did not already allow", () => {
      const entries = [...allowed("cd app"), ...allowed("make lint"), judged("ask", "cd app", "make lint", "git push")]
      expect(patterns(entries, [], [rule("cd *", "allow")])).toEqual([])
      expect(patterns([...allowed("cd app"), judged("ask", "cd app", "git push")], [], [rule("cd *", "allow")])).toEqual([])
      expect(patterns([...allowed("make lint"), judged("ask", "cd app", "git push")], [], [rule("cd *", "allow")])).toEqual(["make lint *"])
    })

    test("a command a specific ask or deny rule covers is never evidence, and its rule vetoes overlapping proposals", () => {
      expect(patterns(allowed("cat notes.env"), [], [rule("*.env", "ask")])).toEqual([])
      expect(patterns(allowed("cat notes.txt"), [], [rule("cat *", "deny")])).toEqual([])
      expect(patterns([...allowed("cat a.txt"), ...allowed("cat b.txt", 1)], [], [rule("cat *.env", "ask")])).toEqual(["cat *"])
      expect(patterns(allowed("git branch --contains abc"), [], [rule("git branch *", "ask")])).toEqual([])
    })
  })

  test("numbers and filenames are arguments, not part of the rule", () => {
    expect(patterns([...allowed("head -20 a.txt", 1), ...allowed("head -5 b.txt", 1), ...allowed("head -n x", 1)])).toEqual(["head *"])
  })

  test("a tool with subcommands gets a rule only for exactly what was observed", () => {
    expect(patterns([...allowed("lxc profile list"), ...allowed("lxc profile show x", 1)])).toEqual(["lxc profile list *"])
  })

  test("the shortest qualifying prefix covers the longer ones", () => {
    expect(patterns([...allowed("ls -la"), ...allowed("ls src")])).toEqual(["ls *"])
  })

  test("a longer prefix is proposed when the shorter one was ever asked about", () => {
    const entries = [...allowed("git branch --contains abc"), judged("ask", "git branch -m old new")]
    expect(patterns(entries)).toEqual(["git branch --contains *"])
  })

  test("a multi-command line that was asked about vetoes every prefix in it", () => {
    expect(patterns([...allowed("make lint"), judged("ask", "make lint", "git push")])).toEqual([])
  })

  test("tools with subcommands are never proposed by their first word alone", () => {
    expect(patterns([...allowed("git status"), ...allowed("git diff"), ...allowed("git log")])).toEqual(["git diff *", "git log *", "git status *"])
  })

  test.each([
    ["an interpreter", "python3 script.py"],
    ["sed", "sed s/a/b/ file"],
    ["a destructive tool", "rm build"],
    ["a risky verb", "lxc launch ubuntu"],
    ["a path as the command", "./run.sh now"],
    ["a wrapper that runs its arguments", "time make lint"],
    ["a database shell", "sqlite3 -readonly app.db"],
  ])("never proposes %s", (_name, command) => {
    expect(patterns(allowed(command))).toEqual([])
  })

  test.each([
    ["a redirect", "echo ok", "echo ok > out.txt"],
    ["traversal", "cat a.txt", "cat a.txt ../secrets"],
    ["substitution", "echo ok", "echo ok $(whoami)"],
    ["text that was truncated", "cat a.txt", "cat a.txt notes…"],
  ])("%s vetoes the prefix", (_name, clean, risky) => {
    expect(patterns([...allowed(clean), judged("allow", risky)])).toEqual([])
  })

  test.each(["du -sh src 2>/dev/null", "du -sh src 2>&1", "du -sh src >/dev/null 2>&1", "du -sh src &>/dev/null"])(
    "discarding or merging output does not veto: %p",
    (command) => {
      expect(patterns([...allowed("du -sh src"), judged("allow", command)])).toEqual(["du *"])
    },
  )

  describe("flags", () => {
    test("the rule stops at the first flag, whatever flags and order were used", () => {
      const entries = [...allowed("ls -la", 1), ...allowed("ls -1 src", 1), ...allowed("ls -lh /tmp", 1)]
      expect(suggest(entries, [], [])).toMatchObject([{ pattern: "ls *", allows: 3 }])
    })

    test("a single repeated command is widened past its flags, and the literal form is offered as the narrower one", () => {
      const [candidate] = suggest(allowed("du -sh src"), [], [])
      expect(candidate).toMatchObject({ pattern: "du *", alternative: { pattern: "du -sh src *", kind: "narrower" } })
      expect(candidate!.note).toBeUndefined()
    })

    test("no narrower form is offered when there were no flags to drop", () => {
      expect(suggest(allowed("cd app"), [], [])[0]!.alternative).toBeUndefined()
    })

    test("a tool with subcommands keeps its flags, because they pick what the command does", () => {
      expect(patterns(allowed("git branch --contains abc"))).toEqual(["git branch --contains *"])
      expect(patterns(allowed("snap logs clef-flash -n 30"))).toEqual(["snap logs clef-flash *"])
    })

    test("a flag that rewrites files in place keeps the narrower rule first until the judge has allowed it", () => {
      const [candidate] = suggest(allowed("gofmt -s -l pkg"), [], [])
      expect(candidate).toMatchObject({ pattern: "gofmt -s -l *", alternative: { pattern: "gofmt *", kind: "wider" } })
      expect(candidate!.note).toContain("-w")
    })

    test("the wide rule leads once the judge has allowed the in-place flag too", () => {
      const entries = [...allowed("gofmt -s -l pkg", 2), ...allowed("gofmt -w pkg", 1)]
      const [candidate] = suggest(entries, [], [])
      expect(candidate).toMatchObject({ pattern: "gofmt *" })
      expect(candidate).not.toHaveProperty("alternative")
      expect(candidate).not.toHaveProperty("note")
    })

    test("with no narrower form to lead with, the wide rule is proposed with a note about the flag", () => {
      const [candidate] = suggest(allowed("gofmt a.go"), [], [])
      expect(candidate).toMatchObject({ pattern: "gofmt *" })
      expect(candidate!.note).toContain("-w")
    })

    test("when the judge asked about the command with other flags, only the narrower rule survives", () => {
      const entries = [...allowed("grep -n a.txt"), judged("ask", "grep -r a.txt /etc")]
      expect(patterns(entries)).toEqual(["grep -n *"])
    })

    test("a risky history run of the command vetoes the wide rule but not a narrower one that was never run that way", () => {
      const entries = allowed("grep -n a.txt")
      expect(patterns(entries, ["grep a.txt > out.txt"])).toEqual(["grep -n *"])
      expect(patterns(entries, ["grep -n a.txt > out.txt"])).toEqual([])
    })

    test("a specific rule that covers the wide form leaves the narrower one", () => {
      expect(patterns(allowed("grep -n a.txt"), [], [rule("grep -n *", "ask")])).toEqual([])
      expect(patterns(allowed("grep -n a.txt"), [], [rule("grep", "ask")])).toEqual(["grep -n *"])
    })
  })

  test("a rule never reaches past what all its allowed uses share", () => {
    expect(patterns([...allowed("git branch --contains abc"), ...allowed("git branch --contains def")])).toEqual(["git branch --contains *"])
    expect(patterns([...allowed("make lint"), ...allowed("make test")])).toEqual(["make lint *", "make test *"])
  })

  test("only the judge's shell decisions count", () => {
    const other = (patch: Partial<AuditEntry>) => allowed("make lint").map((e) => ({ ...e, ...patch }))
    expect(patterns([...other({ by: "config" }), ...other({ by: "plugin" }), ...other({ action: "webfetch" })])).toEqual([])
  })

  describe("with history", () => {
    test("counts how often the prefix ran, across compound commands", () => {
      const [candidate] = suggest(allowed("make lint"), ["make lint && make test", "cd app; make lint", "ls"], [])
      expect(candidate!.historyRuns).toBe(2)
    })

    test("a risky run of the same prefix vetoes it", () => {
      expect(patterns(allowed("make lint"), ["make lint > /etc/motd"])).toEqual([])
    })

    test("never proposes a prefix the judge has not allowed", () => {
      expect(patterns([], ["make lint", "make lint", "make lint"])).toEqual([])
    })
  })
})

describe("shorten", () => {
  test("leaves short examples alone", () => {
    expect(shorten("git status")).toBe("git status")
  })

  test("cuts at a space outside quotes, so a quoted argument is not split", () => {
    const long = `git --no-pager grep -n "defaultRetryStrategy" "upload-confdb-control-assertions" -- some/long/path.go`
    const cut = shorten(long)
    expect(cut).toBe(`git --no-pager grep -n "defaultRetryStrategy"…`)
    expect(cut.length).toBeLessThanOrEqual(81)
  })

  test("falls back to a hard cut when there is no space to cut at", () => {
    expect(shorten("x".repeat(200))).toBe("x".repeat(80) + "…")
  })
})

describe("formatSuggestions", () => {
  const scope = { days: 7, judged: 12, runs: 40 }

  test("names what it skipped for not being on PATH", () => {
    expect(formatSuggestions([], { ...scope, skipped: ["g", "p"] })).toContain(
      "40 shell commands ran in recent sessions.\nSkipped 2 names not found on PATH and not a shell builtin: g, p.\n\nNo pattern qualifies",
    )
  })

  test("lists each candidate with its evidence", () => {
    const text = formatSuggestions(suggest(allowed("make lint"), ["make lint"], []), scope)
    expect(text).toBe(
      [
        "Last 7 days: 12 shell requests went to the judge, and 40 shell commands ran in recent sessions.",
        "",
        "These are patterns the judge allowed, not recommendations. A rule covers every command it matches, not only the ones the judge saw, so review each before it goes in a config.",
        "",
        "make lint *",
        "  allowed by the judge 3 times in 2 sessions; ran 1 time in recent sessions",
        "  e.g. `make lint`",
      ].join("\n"),
    )
  })

  test("shows the other width and any note under the candidate", () => {
    const text = formatSuggestions(suggest(allowed("gofmt -s -l pkg"), [], []), scope)
    expect(text).toContain("gofmt -s -l *\n  allowed by the judge 3 times in 2 sessions; ran 0 times in recent sessions\n  e.g. `gofmt -s -l pkg`\n  wider: gofmt *\n  note: ")
    expect(formatSuggestions(suggest(allowed("du -sh src"), [], []), scope)).toContain("du *\n")
    expect(formatSuggestions(suggest(allowed("du -sh src"), [], []), scope)).toContain("  narrower: du -sh src *")
  })

  test("says so when nothing qualifies", () => {
    expect(formatSuggestions([], { days: 1, judged: 1, runs: 1 })).toBe(
      "Last 1 day: 1 shell request went to the judge, and 1 shell command ran in recent sessions.\n\nNo pattern qualifies: none was allowed by the judge at least 3 times without an ask, a deny, or a risky variant.",
    )
  })
})
