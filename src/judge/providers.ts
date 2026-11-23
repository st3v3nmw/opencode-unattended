import { createCompletionJudge, judgeConfig } from "./completion.ts"
import { createDecisionJudge } from "./decision.ts"
import { registerJudge, type Judge, type JudgeOptions } from "./judge.ts"

type Modality = "completion" | "decision"
type Factory = (options: JudgeOptions) => Judge

/** `completion` is a model that writes its answer, `decision` one that scores yes/no questions. */
const FACTORIES: Record<Modality, Factory> = {
  completion: (options) => createCompletionJudge(judgeConfig(options)),
  decision: (options) => {
    const config = judgeConfig(options)
    if (config.promptCache) throw new Error("judge.promptCache is not supported by the decision modality")
    return createDecisionJudge(config)
  },
}

/**
 * A provider is a name for where the judge runs. For each modality it offers, it supplies the default `baseURL`, and
 * the config's `modality` picks one (`completion` if absent).
 */
function provider(name: string, offers: Partial<Record<Modality, string | null>>) {
  registerJudge(name, ({ modality = "completion", ...options }: JudgeOptions) => {
    if (typeof modality !== "string" || !(modality in offers)) {
      throw new Error(`judge.modality ${JSON.stringify(modality)} is not supported by ${name}. Supported: ${Object.keys(offers).join(", ")}`)
    }
    const baseURL = offers[modality as Modality]
    return FACTORIES[modality as Modality]({ ...(baseURL ? { baseURL } : {}), ...options })
  })
}

provider("openrouter", { completion: "https://openrouter.ai/api/v1", decision: "https://openrouter.ai/api/alpha" })
provider("openai-compatible", { completion: null })
