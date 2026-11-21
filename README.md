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
