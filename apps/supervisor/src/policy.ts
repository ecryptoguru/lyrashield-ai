import { resolve, sep } from "node:path"
import type {
  ExecutorKey,
  ExecutorPlan,
  ExecutorSpec,
  PrepareCommand,
} from "@lyrashield/runtime-control"
import { RuntimeControlError } from "./service-common"

export interface SupervisorPolicy {
  allowedImages: ReadonlySet<string>
  allowedNetworks: ReadonlySet<string>
  allowedProcessCommands: ReadonlySet<string>
  allowedCwdRoots: readonly string[]
  allowedCgroupRoot: string
}

const PROVIDER_SECRET_NAMES = new Set([
  "LLM_API_KEY",
  "OPENAI_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "AZURE_AI_API_KEY",
  "DEDUPE_LLM_API_KEY",
  "LYRASHIELD_DEDUPE_LLM_API_KEY",
  "LYRASHIELD_WEB_SEARCH_API_KEY",
])
const PROVIDER_CONTROL_NAMES = new Set([
  "LLM_API_BASE",
  "LLM_EXTRA_HEADERS",
  "LYRASHIELD_EXTRA_HEADERS",
  "OPENAI_BASE_URL",
  "OPENAI_API_BASE",
  "LITELLM_BASE_URL",
  "OLLAMA_API_BASE",
  "AZURE_OPENAI_ENDPOINT",
  "AZURE_OPENAI_API_BASE",
  "AZURE_AI_API_BASE",
  "DEDUPE_LLM_API_BASE",
  "LYRASHIELD_DEDUPE_LLM_API_BASE",
  "DEDUPE_LLM_EXTRA_HEADERS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "NODE_EXTRA_CA_CERTS",
  "PYTHONPATH",
  "PYTHONHOME",
  "LYRASHIELD_PROVIDER_GATEWAY_ORIGIN",
  "STRIX_RUN_ID",
])

export function assertPrepareAllowed(command: PrepareCommand, policy: SupervisorPolicy): void {
  if (command.attempt.billingMode === "PAID" && !command.provider)
    throw new RuntimeControlError(
      "PROVIDER_POLICY_REQUIRED",
      "paid execution requires a provider budget policy",
      400
    )
  if (command.attempt.billingMode === "UNMETERED" && command.provider)
    throw new RuntimeControlError(
      "PROVIDER_POLICY_NOT_ALLOWED",
      "unmetered execution may not hold provider grants",
      400
    )
  const keys = new Set<ExecutorKey>()
  for (const plan of command.executors) {
    if (keys.has(plan.key))
      throw new RuntimeControlError("DUPLICATE_EXECUTOR_KEY", "executor keys must be unique", 400)
    keys.add(plan.key)
    assertExecutorAllowed(plan, policy)
  }
}

export function assertExecutorAllowed(plan: ExecutorPlan, policy: SupervisorPolicy): void {
  assertSpecHasNoAmbientCredentials(plan.spec)
  if (plan.spec.kind === "container") {
    if (!policy.allowedImages.has(plan.spec.image)) {
      throw new Error("container image is not in the supervisor allowlist")
    }
    if (!policy.allowedNetworks.has(plan.spec.network)) {
      throw new Error("container network is not in the supervisor allowlist")
    }
    return
  }
  if (!policy.allowedProcessCommands.has(plan.spec.command)) {
    throw new Error("process command is not in the supervisor allowlist")
  }
  const cwd = resolve(plan.spec.cwd)
  if (!policy.allowedCwdRoots.some((root) => isWithin(resolve(root), cwd))) {
    throw new Error("process working directory is outside the supervisor roots")
  }
  const cgroup = resolve(plan.spec.cgroupPath)
  if (!isWithin(resolve(policy.allowedCgroupRoot), cgroup)) {
    throw new Error("process cgroup is outside the supervisor root")
  }
}

export function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`)
}

export function assertSpecHasNoAmbientCredentials(spec: ExecutorSpec): void {
  for (const name of Object.keys(spec.env)) {
    if (
      name.startsWith("DOCKER_") ||
      PROVIDER_SECRET_NAMES.has(name) ||
      PROVIDER_CONTROL_NAMES.has(name)
    ) {
      throw new Error(`executor environment may not carry ${name}`)
    }
  }
}
