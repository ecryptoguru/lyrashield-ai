import type { ExecutorKey, ExecutorSpec } from "@lyrashield/runtime-control"
import type { ExecutorContext } from "./executor"
import { deriveOwnershipId } from "./executor"
import { providerEnvironment } from "./provider-environment"
import type { loadProtectedResourceInstallation } from "./protected-resource-installation"

/** Both legacy fixtures and the protected host use the same fixed argument compiler. */
export function containerCreateCommand(
  key: ExecutorKey,
  spec: Extract<ExecutorSpec, { kind: "container" }>,
  context: ExecutorContext,
  installed?: Awaited<ReturnType<typeof loadProtectedResourceInstallation>>
) {
  const ownershipId = deriveOwnershipId(context.attemptId, context.commandId, key)
  const args = [
    "create",
    "--pull=never",
    "--name",
    `lyrashield-supervisor-${ownershipId.slice(4, 36)}`,
    "--label",
    `lyrashield.supervisor.attempt=${context.attemptId}`,
    "--label",
    `lyrashield.supervisor.ownership=${ownershipId}`,
    "--network",
    spec.network,
    "--cpus",
    String(spec.cpus),
    "--memory",
    `${spec.memoryMb}m`,
    "--pids-limit",
    String(spec.pidsLimit),
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--init",
  ]
  if (spec.readOnly) args.push("--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=256m")
  for (const [name, value] of Object.entries(spec.env).sort(([left], [right]) =>
    left.localeCompare(right)
  ))
    args.push("--env", `${name}=${value}`)
  if (installed) args.push(...installed.args)
  const provider = providerEnvironment(spec, context)
  args.push(...provider.args, spec.image, ...spec.argv)
  return { args, providerEnv: provider.env, ownershipId }
}
