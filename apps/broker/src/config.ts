import { z } from "zod"
import type { ScanPreparationCompiler } from "@lyrashield/db/src/scan-dispatch-command-descriptor"

const identity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,191}$/)
const hash = z.string().regex(/^[a-f0-9]{64}$/)

const protectedSourceSchema = z
  .object({
    streamId: identity,
    authorityEpochId: identity,
    supervisorInstanceId: identity,
    originalKeyHash: hash,
    wrapperKeyHash: hash,
    socketPath: z.string().min(1).max(100).startsWith("/"),
  })
  .strict()

const transportSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("unix"), socketPath: z.string().min(1).max(100).startsWith("/") })
    .strict(),
  z
    .object({
      kind: z.literal("loopback"),
      host: z.string().min(1).max(64),
      port: z.number().int().min(1).max(65535),
    })
    .strict(),
])

export interface BrokerConfig {
  connectionString: string
  transport: z.infer<typeof transportSchema>
  controlToken: string
  admission: "closed" | "open"
  /**
   * Checked preparation intent. The compiler is installed by trusted startup
   * code from verified host policy, never from a request field. Without it the
   * broker serves status and STOP only, and every prepare call is refused with
   * PREPARATION_AUTHORITY_CLOSED rather than committing a command bundle this
   * installation cannot produce.
   */
  preparationAuthority?: ScanPreparationCompiler
  /**
   * Receipt settlement is installed only from a protected installation. Without
   * it the broker still serves dispatch authority, but every consume call is
   * refused instead of projecting an unverified supervisor chain.
   */
  receiptAuthority?: {
    streamId: string
    authorityEpochId: string
    supervisorInstanceId: string
    originalKeyHash: string
    wrapperKeyHash: string
    socketPath: string
    originalSigningSecret: string
    wrapperSigningSecret: string
    controlToken: string
  }
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function transport(env: NodeJS.ProcessEnv): BrokerConfig["transport"] {
  const socketPath = env.LYRASHIELD_BROKER_SOCKET_PATH?.trim()
  if (socketPath) return transportSchema.parse({ kind: "unix", socketPath })
  const rawPort = env.LYRASHIELD_BROKER_PORT?.trim() ?? "8080"
  if (!/^\d+$/.test(rawPort)) throw new Error("LYRASHIELD_BROKER_PORT must be a decimal port")
  return transportSchema.parse({
    kind: "loopback",
    host: env.LYRASHIELD_BROKER_HOST?.trim() || "127.0.0.1",
    port: Number(rawPort),
  })
}

function receiptAuthority(env: NodeJS.ProcessEnv): BrokerConfig["receiptAuthority"] {
  const raw = env.LYRASHIELD_SUPERVISOR_JOURNAL_AUTHORITY_JSON?.trim()
  if (!raw) return undefined
  const source = protectedSourceSchema.safeParse(JSON.parse(raw))
  if (!source.success) throw new Error("Protected supervisor source configuration is invalid")
  return {
    ...source.data,
    originalSigningSecret: required(env, "LYRASHIELD_SUPERVISOR_SIGNING_SECRET"),
    wrapperSigningSecret: required(env, "LYRASHIELD_SUPERVISOR_MIRROR_SIGNING_SECRET"),
    controlToken: required(env, "LYRASHIELD_SUPERVISOR_CONTROL_TOKEN"),
  }
}

/**
 * Fail-closed installation. The broker holds the only dispatch-authority write
 * path, so a missing database URL or control token stops startup instead of
 * serving a control socket that cannot bind authority or authenticate callers.
 */
export function loadBrokerConfig(env: NodeJS.ProcessEnv = process.env): BrokerConfig {
  const connectionString = required(env, "LYRASHIELD_SCAN_EXECUTION_DATABASE_URL")
  const controlToken = required(env, "LYRASHIELD_BROKER_CONTROL_TOKEN")
  if (controlToken.length < 32 || /[\r\n]/.test(controlToken))
    throw new Error("LYRASHIELD_BROKER_CONTROL_TOKEN must be at least 32 characters")
  return {
    connectionString,
    transport: transport(env),
    controlToken,
    admission: env.LYRASHIELD_BROKER_ADMISSION?.trim() === "open" ? "open" : "closed",
    receiptAuthority: receiptAuthority(env),
    preparationAuthority: undefined,
  }
}
