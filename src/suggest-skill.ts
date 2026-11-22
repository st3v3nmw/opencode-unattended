import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { SUGGEST_TOOL } from "./suggest-tool.ts"

export const SUGGEST_SKILL = {
  id: "suggest-allow-rules",
  name: "suggest-allow-rules",
  description:
    "Use when the user wants fewer judge calls or asks which shell commands, webfetch URLs or searches could become allow rules in their opencode permissions, based on the audit log and recent history.",
  path: dirname(fileURLToPath(import.meta.url)),
  content: `# Suggest allow rules

The opencode-unattended judge decides every shell command, webfetch and websearch your permission rules do not already settle. Each call costs time and money. Commands the judge keeps allowing are candidates for a plain allow rule in the user's opencode config.

The tool reports what the judge allowed. It cannot tell what a command does, so it does not say a rule is safe. That review is your job, and it is the point of this skill.

1. Ask the user how far back to look if they have not said. A week or a month are the usual answers.
2. Run \`opencode-unattended suggest --since 7d\` (use 30d for a month). If that command is not installed, run \`bun run suggest --since 7d\` from the plugin's directory, the base directory of this skill's package. It is read-only: it reads the audit log, the shell, webfetch, websearch and \`*\` rules in the user's opencode config (every rule, including deny and ask, in file order), and recent session history from opencode's database. Add \`--config PATH\` if the config is somewhere else, or \`--action webfetch\` to look at one action. If it cannot run, call \`${SUGGEST_TOOL}\` instead with \`days\` and every shell, webfetch, websearch and \`*\` rule from the config as \`rules\`, each with its \`action\`.
3. Review every candidate before showing it. A rule covers every command it matches, not only the ones the judge saw. For each one, work out:
   - What the command does. If you do not know it, find out: \`type\`, \`command -v\`, \`--help\`, or read the alias or function body. Do not guess from the name. Personal aliases and scripts are the usual unknowns.
   - The worst command the pattern could match. Replace the \`*\` with the most harmful arguments or subcommand that fit, such as a delete flag, a force flag or a write subcommand.
   - Whether the config's deny and ask rules still cover that worst command. They match text literally from the start, so a deny rule for \`git commit *\` does not match \`git -C repo commit\`, and one for \`git branch -D *\` does not match \`git branch -a -D x\`. The tool's \`note\` lines point at these, but it cannot find them all.
   - Whether it writes files, moves or deletes them, reaches the network, or touches paths outside the project. Evidence from a single session is thin; say so.
4. Report each candidate as accept, narrow or reject, with one line of reasoning:
   - Accept: the rule is safe as written.
   - Narrow: write a tighter rule that keeps the evidence and drops the risk, such as \`git -C snapd log *\` in place of \`git -C snapd *\`. A narrower rule must still match what the judge saw. A candidate may list an alternative at the other width; use it when it fits.
   - Merge: several candidates may collapse into one rule you have checked, such as \`git grep *\` for \`git grep -c *\` and \`git grep -il *\`, but only once you have confirmed the whole command is read-only.
   - Reject: say why, so the user can disagree.
5. Show the accepted and narrowed rules ready to paste, for example:
   { "action": "shell", "resource": "git status *", "effect": "allow" }
   Webfetch rules use \`"action": "webfetch"\` and a URL pattern such as \`https://docs.example.com/*\`. A websearch rule is just \`*\`. Say how often the judge allowed the pattern and in how many sessions. Tell the user where each rule must sit: after the broad ask rule for that action, and before any more specific ask or deny rule it should not override.
6. If the output says it skipped names not found on PATH, tell the user which ones. Those are usually functions or aliases defined inside a single command, which no rule can match. If a name is a real tool the script's shell could not see, the user can run it again from the right environment.
7. Mention that a pattern ending in \` *\` also matches the bare command, and that \`*\` matches any characters, including \`..\` and redirects. The tool already withholds prefixes seen with those. If the output says history could not be read, say the check for redirects in commands the judge never saw was skipped.

Never edit the config yourself. Only propose, and let the user decide which rules to add. Propose only rules that widen what the config allows; never suggest narrowing or replacing an allow rule that is already there. Every rule you propose must come from a candidate, whether as is, narrowed or merged. If the tool returns no candidates, say so and stop.

The tool covers shell, webfetch and websearch only; edit and external_directory requests are not analyzed. For shell it proposes literal prefixes, never programs that run arbitrary code (sed, awk, xargs, interpreters). For webfetch it proposes an origin, or an owner on hosts like github.com that serve many people's content, and withholds any host where a URL carried a query string, credentials or plain http, or where the judge refused something. For every action it never proposes anything the judge asked about or denied.`,
}
