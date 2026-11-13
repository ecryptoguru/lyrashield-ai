import { resolve } from "node:path"
import type { SupervisorPolicy } from "./policy"

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function csv(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
  )
}

function jsonArray(value: string | undefined, name: string): string[] {
  if (!value) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error(`${name} must be a JSON string array`)
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every((entry) => typeof entry === "string" && entry.length > 0)
  ) {
    throw new Error(`${name} must be a JSON string array`)
  }
  return parsed
}

export interface SupervisorConfig {
  socketPath?: string
  host: string
  port: number
  journalPath: string
  signingSecret: string
  supervisorInstanceId: string
  controlToken: string
  admission: "closed" | "open"
  providerGatewayUrl: string
  providerGatewayControlToken: string
  policy: SupervisorPolicy
}

export function loadSupervisorConfig(env: NodeJS.ProcessEnv = process.env): SupervisorConfig {
  const admission = env.LYRASHIELD_RUNTIME_ADMISSION?.trim() || "closed"
  if (admission !== "closed" && admission !== "open") {
    throw new Error("LYRASHIELD_RUNTIME_ADMISSION must be closed or open")
  }
  if (admission === "open") {
    throw new Error(
      "Supervisor admission is held until broker and journal qualification is installed"
    )
  }
  const port = Number(env.LYRASHIELD_SUPERVISOR_PORT ?? "8790")
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error("invalid supervisor port")
  return {
    socketPath: env.LYRASHIELD_SUPERVISOR_SOCKET_PATH?.trim() || undefined,
    host: env.LYRASHIELD_SUPERVISOR_HOST?.trim() || "127.0.0.1",
    port,
    journalPath: resolve(required(env, "LYRASHIELD_SUPERVISOR_JOURNAL_PATH")),
    signingSecret: required(env, "LYRASHIELD_SUPERVISOR_SIGNING_SECRET"),
    supervisorInstanceId: required(env, "LYRASHIELD_SUPERVISOR_INSTANCE_ID"),
    controlToken: required(env, "LYRASHIELD_SUPERVISOR_CONTROL_TOKEN"),
    admission,
    providerGatewayUrl: required(env, "LYRASHIELD_PROVIDER_GATEWAY_URL"),
    providerGatewayControlToken: required(env, "LYRASHIELD_PROVIDER_GATEWAY_CONTROL_TOKEN"),
    policy: {
      allowedImages: csv(env.LYRASHIELD_SUPERVISOR_ALLOWED_IMAGES),
      allowedNetworks: csv(env.LYRASHIELD_SUPERVISOR_ALLOWED_NETWORKS),
      allowedProcessCommands: csv(env.LYRASHIELD_SUPERVISOR_ALLOWED_PROCESS_COMMANDS),
      allowedCwdRoots: jsonArray(
        env.LYRASHIELD_SUPERVISOR_ALLOWED_CWD_ROOTS,
        "LYRASHIELD_SUPERVISOR_ALLOWED_CWD_ROOTS"
      ),
      allowedCgroupRoot: resolve(required(env, "LYRASHIELD_SUPERVISOR_CGROUP_ROOT")),
    },
  }
}
