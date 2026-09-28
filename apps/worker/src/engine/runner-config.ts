import { env } from "@lyrashield/config"
import { ENGINE_TEMP_ROOT } from "./workspace-path"

export type ReasoningEffort = "medium" | "high"

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
  routingEnv: NodeJS.ProcessEnv = process.env
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

export function resolveEngineSandboxNetwork(runtimeEnv: NodeJS.ProcessEnv = process.env): string {
  const network = runtimeEnv.LYRASHIELD_ENGINE_SANDBOX_NETWORK?.trim()
  if (!network || network.toLowerCase() === "none") {
    throw new Error(
      "LYRASHIELD_ENGINE_SANDBOX_NETWORK must name a routable, egress-restricted Docker network"
    )
  }
  return network
}

export function assertRepositoryScanRuntimeConfigured(
  runtimeEnv: NodeJS.ProcessEnv = process.env
): void {
  requireRepositoryModel(resolveEngineProfile("SAFE", runtimeEnv).model)
  requireRepositoryModel(resolveEngineProfile("DEEP", runtimeEnv).model)
  if (!(
    runtimeEnv.LLM_API_KEY ||
    runtimeEnv.AZURE_OPENAI_API_KEY ||
    runtimeEnv.AZURE_AI_API_KEY ||
    runtimeEnv.OPENAI_API_KEY
  )) {
    throw new Error("A model provider credential must be configured for repository scans")
  }
  resolveEngineSandboxNetwork(runtimeEnv)
  if (runtimeEnv.NODE_ENV === "production") {
    const image = runtimeEnv.LYRASHIELD_IMAGE ?? ""
    if (!/^ghcr\.io\/ecryptoguru\/lyrashield-sandbox@sha256:[a-f0-9]{64}$/.test(image)) {
      throw new Error(
        "LYRASHIELD_IMAGE must be a LyraShield-owned immutable sha256 digest in production"
      )
    }
    const dockerHost = runtimeEnv.DOCKER_HOST?.trim() ?? ""
    // A remote, isolated sandbox host (ssh:// or tls tcp://) is the strongest
    // posture and stays the default. A single-VM deployment — the worker runs
    // the engine against the VM's LOCAL Docker daemon and isolates scans with a
    // dedicated egress-restricted network plus a deny-by-default firewall (see
    // ops/worker/README.md) — is supported as an explicit, name-clear opt-in via
    // LYRASHIELD_ALLOW_LOCAL_SANDBOX_HOST=1. That opt-in is honored ONLY when a
    // routable egress-restricted sandbox network is also configured (the
    // resolveEngineSandboxNetwork check above), so a bare local Docker socket
    // with no network isolation still fails.
    const allowLocalSandboxHost =
      (runtimeEnv.LYRASHIELD_ALLOW_LOCAL_SANDBOX_HOST ?? "").trim().toLowerCase() === "1" ||
      (runtimeEnv.LYRASHIELD_ALLOW_LOCAL_SANDBOX_HOST ?? "").trim().toLowerCase() === "true"
    const isRemoteDockerHost = /^ssh:\/\//.test(dockerHost) || /^tcp:\/\//.test(dockerHost)
    if (!isRemoteDockerHost && !allowLocalSandboxHost) {
      throw new Error(
        "DOCKER_HOST must be an ssh:// or tcp:// endpoint for an isolated sandbox worker in production"
      )
    }
    if (/^tcp:\/\//.test(dockerHost) && runtimeEnv.DOCKER_TLS_VERIFY !== "1") {
      throw new Error("DOCKER_TLS_VERIFY=1 is required for a tcp:// production DOCKER_HOST")
    }
  }
}

function requireRepositoryModel(model: string | undefined): string {
  if (!model) {
    throw new Error("A GPT-6 Sol or Luna deployment must be configured")
  }
  return model
}

const WEB_SEARCH_DEFAULTS: Record<string, string> = {
  LYRASHIELD_WEB_SEARCH_PROVIDER: "parallel",
  LYRASHIELD_WEB_SEARCH_MODE: "turbo",
  LYRASHIELD_WEB_SEARCH_MAX_RESULTS: "5",
  LYRASHIELD_WEB_SEARCH_MAX_CHARS_TOTAL: "4000",
  LYRASHIELD_WEB_SEARCH_MAX_CALLS_PER_SCAN: "50",
  LYRASHIELD_WEB_SEARCH_BUDGET_USD: "1.0",
}
export function buildEngineEnv(
  profile: EngineProfile,
  scanId?: string,
  opts?: {
    runType?: string
    /** Scan-scoped relay for engine-backed URL/API targets. */
    relay?: { url: string; grant: string }
  }
): Record<string, string> {
  const allow = new Set([
    "PATH",
    "HOME",
    "USER",
    "SHELL",
    "LANG",
    "LC_ALL",
    "TERM",
    "DOCKER_HOST",
    "DOCKER_TLS_VERIFY",
    "DOCKER_CERT_PATH",
    "LYRASHIELD_LLM",
    "LLM_API_KEY",
    "LLM_API_BASE",
    "LLM_API_VERSION",
    "LLM_TIMEOUT",
    "LYRASHIELD_MAX_OUTPUT_TOKENS",
    "LYRASHIELD_MAX_INPUT_TOKENS",
    "LYRASHIELD_PROMPT_CACHE_EXPLICIT",
    "LYRASHIELD_PROMPT_CACHE_ROUTING",
    "LYRASHIELD_PROMPT_CACHE",
    "LYRASHIELD_IMAGE",
    "LYRASHIELD_RUNTIME_BACKEND",
    "LYRASHIELD_SERVER_CONVERSATION",
    "LYRASHIELD_MAX_LOCAL_COPY_MB",
    "LYRASHIELD_REASONING_EFFORT",
    "LYRASHIELD_TELEMETRY",
    "LYRASHIELD_WEB_SEARCH_ENABLED",
    "LYRASHIELD_WEB_SEARCH_API_KEY",
    "LYRASHIELD_WEB_SEARCH_PROVIDER",
    "LYRASHIELD_WEB_SEARCH_MODE",
    "LYRASHIELD_WEB_SEARCH_MAX_RESULTS",
    "LYRASHIELD_WEB_SEARCH_MAX_CHARS_TOTAL",
    "LYRASHIELD_WEB_SEARCH_MAX_CALLS_PER_SCAN",
    "LYRASHIELD_WEB_SEARCH_BUDGET_USD",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "AZURE_OPENAI_API_KEY",
    "AZURE_OPENAI_ENDPOINT",
    "AZURE_OPENAI_API_BASE",
    "AZURE_AI_API_KEY",
    "AZURE_AI_API_BASE",
    "AZURE_API_VERSION",
    "AZURE_OPENAI_API_VERSION",
  ])
  const filtered: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || value === "") continue
    if (allow.has(key)) {
      filtered[key] = value
    }
  }
  if (!("LYRASHIELD_PROMPT_CACHE_EXPLICIT" in filtered)) {
    filtered.LYRASHIELD_PROMPT_CACHE_EXPLICIT = "1"
  }
  if (!("LYRASHIELD_PROMPT_CACHE" in filtered)) {
    filtered.LYRASHIELD_PROMPT_CACHE = "1"
  }
  if (!("LYRASHIELD_PROMPT_CACHE_ROUTING" in filtered)) {
    filtered.LYRASHIELD_PROMPT_CACHE_ROUTING = "1"
  }
  filtered.LYRASHIELD_ALLOW_CHATGPT_SUBSCRIPTION = "0"
  // The engine clones repositories below TMPDIR before asking host Docker to
  // bind-mount them into the sandbox. Keep the child on the same host-visible
  // temp root as the worker; /tmp inside the worker container is not visible
  // to the host Docker daemon.
  filtered.TMPDIR = ENGINE_TEMP_ROOT
  if (profile.model) filtered.LYRASHIELD_LLM = profile.model
  filtered.LYRASHIELD_REASONING_EFFORT = profile.reasoningEffort
  if (profile.delegateModel) filtered.LYRASHIELD_DELEGATE_LLM = profile.delegateModel
  filtered.LYRASHIELD_DELEGATE_REASONING_EFFORT = profile.delegateReasoningEffort
  if (scanId) {
    filtered.STRIX_RUN_ID = scanId
    filtered.STRIX_RUN_TYPE = opts?.runType ?? "repository"
  }
  // Per-scan relay credentials: never part of process.env (the allowlist above
  // is for static config only), injected explicitly for engine-backed URL runs.
  if (opts?.relay) {
    filtered.STRIX_TARGET_RELAY_URL = opts.relay.url
    filtered.STRIX_TARGET_RELAY_GRANT = opts.relay.grant
  }
  filtered.STRIX_DOCKER_SANDBOX_NETWORK = resolveEngineSandboxNetwork()
  filtered.STRIX_SANDBOX_MEM_LIMIT = env.STRIX_SANDBOX_MEM_LIMIT.trim() || "4g"
  filtered.STRIX_SANDBOX_CPUS = env.STRIX_SANDBOX_CPUS.trim() || "2"
  filtered.STRIX_SANDBOX_PIDS_LIMIT = env.STRIX_SANDBOX_PIDS_LIMIT.trim() || "512"

  // Only forward web-search tuning defaults when the feature is enabled; this
  // keeps disabled runs from silently carrying a provider/budget and gives the
  // engine a predictable, complete environment when enabled.
  if (filtered.LYRASHIELD_WEB_SEARCH_ENABLED === "1") {
    for (const [key, defaultValue] of Object.entries(WEB_SEARCH_DEFAULTS)) {
      if (!filtered[key]) filtered[key] = defaultValue
    }
  }

  return filtered
}
