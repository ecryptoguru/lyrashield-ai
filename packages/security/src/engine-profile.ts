type ReasoningEffort = "medium" | "high"

export interface EngineProfile {
  model?: string
  reasoningEffort: ReasoningEffort
  delegateModel?: string
  delegateReasoningEffort: ReasoningEffort
}

function assertSupportedRepositoryModel(model: string | undefined): void {
  const normalizedModel = model?.toLowerCase().replaceAll("_", "-")
  if (!normalizedModel) return
  const parts = normalizedModel.split("/")
  const deployment = parts.pop()
  const provider = parts.shift()
  const validProvider =
    parts.length === 0 && provider === undefined
      ? true
      : (provider === "openai" || provider === "azure" || provider === "azure-ai") &&
        parts.length <= 1 &&
        parts.every(Boolean)
  if (!validProvider || (deployment !== "gpt-6-sol" && deployment !== "gpt-6-luna")) {
    throw new Error("LyraShield scans require a GPT-6 Sol or Luna deployment")
  }
}

export function resolveEngineProfile(
  mode: string,
  routingEnv: {
    [key: string]: string | undefined
    LYRASHIELD_LUNA_LLM?: string
    LYRASHIELD_SOL_LLM?: string
    LYRASHIELD_LLM?: string
  } = process.env
): EngineProfile {
  const deep = mode.toUpperCase() === "DEEP" || mode.toUpperCase() === "CUSTOM"
  const selectedModel = deep ? routingEnv.LYRASHIELD_SOL_LLM : routingEnv.LYRASHIELD_LUNA_LLM
  const model = selectedModel?.trim() || routingEnv.LYRASHIELD_LLM?.trim() || undefined
  const delegateModel = routingEnv.LYRASHIELD_LUNA_LLM?.trim() || model
  assertSupportedRepositoryModel(model)
  assertSupportedRepositoryModel(delegateModel)
  const modelId = model?.toLowerCase().replaceAll("_", "-")
  const delegateId = delegateModel?.toLowerCase().replaceAll("_", "-")
  if (deep && (!routingEnv.LYRASHIELD_SOL_LLM?.trim() || !modelId?.endsWith("gpt-6-sol"))) {
    throw new Error("Deep/Custom scans require LYRASHIELD_SOL_LLM=gpt-6-sol")
  }
  if (!delegateId?.endsWith("gpt-6-luna") || (!deep && !modelId?.endsWith("gpt-6-luna"))) {
    throw new Error("LyraShield scan specialists and standard modes require GPT-6 Luna")
  }

  // DEEP/CUSTOM: Sol/medium coordinator + Luna/high specialists.
  // SAFE/QUICK/STANDARD: Luna/medium throughout.
  // Root and specialist models remain distinct, with Luna/high as the
  // content-filter fallback (see strix/core/runner.py).
  return {
    model,
    reasoningEffort: "medium",
    delegateModel,
    delegateReasoningEffort: deep ? "high" : "medium",
  }
}
