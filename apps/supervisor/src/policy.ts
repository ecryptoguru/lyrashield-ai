import { resolve, sep } from "node:path"
import type { ExecutorPlan, ExecutorSpec } from "@lyrashield/runtime-control"

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
  "LYRASHIELD_WEB_SEARCH_API_KEY",
])

export function assertExecutorAllowed(plan: ExecutorPlan, policy: SupervisorPolicy): void {
  for (const name of Object.keys(plan.spec.env)) {
    if (name.startsWith("DOCKER_") || PROVIDER_SECRET_NAMES.has(name)) {
      throw new Error(`executor environment may not carry ambient control credential ${name}`)
    }
  }
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
    if (name.startsWith("DOCKER_") || PROVIDER_SECRET_NAMES.has(name)) {
      throw new Error(`executor environment may not carry ${name}`)
    }
  }
}
