# opencode-unattended

An opencode plugin that lets an agent keep working while you are away from the keyboard.

Left alone, opencode stops at every permission prompt and waits for you. Pre-approving everything avoids the wait but gives the agent free rein. This plugin sits between the two. When a request would normally ask you, it goes to a language model acting as a reviewer, which decides whether a careful colleague would wave it through.

The reviewer sees the request, your latest messages and the agent's recent tool calls. It answers allow, ask or deny, with a short reason. Reading, building, testing and editing project files go through. Pushing, publishing, touching credentials, installing system-wide or running code it hasn't seen do not, unless you plainly asked for that very action. Your messages are the only instructions it takes; anything the agent reads along the way, from file contents to web pages, is treated as data.

A refusal doesn't stall the session. The reason goes back to the agent, which can rework the approach or stop and tell you what it needs. You only see a prompt when the plugin can't decide: the reviewer is unreachable, the request can't be parsed, or the agent has been turned back several times in a row. Anything your own permission rules allow or deny is left to those rules.

```
agent request
    |
    v
your permission rules
    |
    +-- allow ---------------> runs
    +-- deny ----------------> blocked
    +-- ask
         |
         v
       reviewer
         |
         +-- allow ----------> runs
         +-- ask or deny ----> reason goes back to the agent, which reworks or stops
         |                     (turned back repeatedly: you are asked instead)
         +-- cannot decide --> you are asked
```

Every decision is written to a local audit log, and a small CLI turns the log into usage stats and suggests shell commands that could become permanent allow rules in your config.

## Install

Add the plugin to your opencode config, for example `~/.config/opencode/opencode.jsonc`. opencode fetches it from npm on the next start.

```jsonc
{
  "plugin": [
    [
      "opencode-unattended",
      { "judge": { "model": "anthropic/claude-haiku-5.5", "baseURL": "https://openrouter.ai/api/v1" } }
    ]
  ]
}
```

The reviewer is any OpenAI-compatible chat completions endpoint. If `judge.model` or `judge.baseURL` is left out of the options, the plugin reads `OPENCODE_UNATTENDED_MODEL` and `OPENCODE_UNATTENDED_API_URL` instead; options win when both are set. The key comes from `OPENCODE_UNATTENDED_API_KEY` and can be omitted for a local server that needs none. With a required setting missing, the plugin still loads, and every request that reaches it goes to you.

Other options:

- `judge.timeout`: how long one review may take, as a duration such as `"30s"`.
- `judge.promptCache`: `{ "ttl": "1h" }` asks the endpoint to cache the system prompt; `ttl` is `"5m"` or `"1h"`.
- `escalateAfter`: how many requests in a row, or denies in a session, the reviewer may turn back before you are asked. Default 3.
- `auditDir`: where the audit log goes, `~/.local/state/opencode-unattended` by default. `false` turns the log off, along with the rule-suggestion tool and skill that depend on it.

The plugin and the CLI below run on Bun, which opencode already uses.

## CLI

```
opencode-unattended stats [--since 180d] [--project TEXT] [--top ask|deny|error]
opencode-unattended suggest [--since 7d] [--action NAME] [--json]
```

`stats` summarizes the audit log: how many requests your rules settled, how many the reviewer allowed, turned back or failed on, and how long it took. `suggest` reads the same log and your opencode config and lists shell commands, webfetch origins and searches the reviewer keeps allowing, as candidates for permanent allow rules. Both accept `--help` for the full option list.

Install it with `bun add -g opencode-unattended`, which also provides the shorter `unattended` command, or run it once with `bunx opencode-unattended stats`.
