# Eval

Labeled requests that measure how a model does as the reviewer. Run it after changing `src/judge/prompt.ts` or when picking a model. Each case in `cases.ts` has a request, its context, and the verdict it should get, `allow` or `deny`.

```sh
export EVAL_API_URL=https://openrouter.ai/api/v1
export OPENCODE_UNATTENDED_API_KEY=...
bun run eval anthropic/claude-haiku-5.5
```

The argument is one model or a comma-separated list. Without it, the models in `run.ts` run in turn. The report shows exact matches, wrongly allowed requests (expected deny, got allow), wrongly denied ones, latency, cost, and each miss with the reviewer's reason. The exit code is 1 on any wrongly allowed request.

Runs are slow to stay under rate limits. `EVAL_CONCURRENCY` (1), `EVAL_DELAY_MS` (1000) and `EVAL_COOLDOWN_S` (120) change that. `EVAL_MODALITY=decision` with `EVAL_API_URL=https://openrouter.ai/api/alpha` runs decision models, which score instead of write. `--cache` enables prompt caching, `--retry-errors` reruns model errors, and `--fresh` starts a new sample.

Answers are saved as they arrive in `results/<provider>/<model>/<prompt id>.json` (git ignores it), so an interrupted run resumes. The prompt id hashes the system prompt, request layout, schema and token cap, so changing any of them starts a new file. Cases are matched by a hash of the request and context, so relabeling or adding cases keeps stored results.

```sh
bun run eval:history [--current]
bun run eval:diff <[provider/]model[@prompt[#sample]]> <[provider/]model[@prompt[#sample]]>
```

`history` lists stored runs, and `diff` lists the cases whose verdict changed between two. The provider is the host of `EVAL_API_URL` unless the reference names one. One or two changes is noise.

To add a case, use the helpers at the top of `cases.ts`, and give it a `context` when the answer depends on the user's messages or recent calls.

## Results

The current prompt over all 250 cases, best accuracy first. Ties go to fewer wrongly allowed requests, then to lower cost. A `decision` model scores a yes/no question and the rest write their answer.

| Provider / model | Modality | Date | Accuracy | Wrongly allowed | Wrongly denied | p50 | p95 | $/1000 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **openrouter.ai** | | | | | | | | |
| meta/muse-ember | completion | 2026-11-22 | 99.2% | 1 | 1 | 2.9s | 5.0s | $0.31 |
| deepseek/deepseek-v4.1-flash | completion | 2026-11-22 | 98.8% | 2 | 1 | 1.4s | 3.4s | $0.18 |
| anthropic/claude-haiku-5.5 | completion | 2026-11-22 | 98.0% | 0 | 5 | 1.5s | 2.3s | $0.21 |
| qwen/qwen3.8-27b | completion | 2026-11-22 | 98.0% | 3 | 2 | 1.6s | 5.9s | $0.67 |
| xiaomi/mimo-v2.6-flash | completion | 2026-11-22 | 97.6% | 5 | 1 | 1.0s | 2.1s | $0.23 |
| google/gemini-3.5-flash-lite | completion | 2026-11-22 | 97.2% | 5 | 2 | 1.2s | 2.3s | $0.42 |
| typesafe/jev-1.14 | decision | 2026-11-22 | 96.8% | 5 | 3 | 0.7s | 1.3s | $0.055 |
| anthropic/claude-sonnet-5.5 | completion | 2026-11-22 | 96.0% | 1 | 2 | 2.0s | 3.3s | $4.13 |
| liquid/d1.2 | decision | 2026-11-22 | 95.6% | 3 | 8 | 0.8s | 1.1s | $0.022 |
| openai/gpt-6-luna | completion | 2026-11-22 | 95.6% | 3 | 8 | 2.4s | 3.6s | $0.15 |
| minimax/minimax-m3.1-flash | completion | 2026-11-22 | 95.2% | 7 | 5 | 0.9s | 4.4s | $0.11 |
| thinkingmachines/inkling-2-mini | completion | 2026-11-22 | 94.8% | 3 | 5 | 1.9s | 20.5s | $0.14 |
| microsoft/microsoft-decision-1.1 | decision | 2026-11-22 | 94.4% | 1 | 13 | 0.7s | 0.8s | $0.046 |
| google/gemma-4-26b-a4b-it | completion | 2026-11-22 | 90.8% | 9 | 14 | 0.8s | 1.8s | $0.076 |
| cloudflare/clef-flash | decision | 2026-11-22 | 89.6% | 8 | 18 | 0.7s | 1.3s | $0.030 |
| baseten/groundhog-1 | decision | 2026-11-22 | 84.4% | 1 | 38 | 0.7s | 1.3s | $0.040 |
| openai/gpt-6-luna-decisions | decision | 2026-11-22 | 71.2% | 70 | 2 | 0.8s | 1.0s | $0.11 |
