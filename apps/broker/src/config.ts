import { validateSupervisorAttemptProofPublicKey } from "@lyrashield/runtime-control"
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
      host: z.enum(["127.0.0.1", "::1"]),
      port: z.number().int().min(1).max(65535),
    })
    .strict(),
])

export interface BrokerConfig {
  connectionString: string
  lifecycleConnectionString?: string
  transport: z.infer<typeof transportSchema>
  controlToken: string
  admission: "closed" | "open"
  /**
   * Checked preparation intent. The compiler is installed by trusted startup
   * code from verified host policy, never from a request field. Without it the
   * broker keeps admission closed while allowing recovery, rather than
   * committing a command bundle this installation cannot produce.
   */
  preparationAuthority?: ScanPreparationCompiler
  stageOperation?: (operationId: string) => Promise<void>
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
    attemptProofPublicKey: string
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
  const host = env.LYRASHIELD_BROKER_HOST?.trim() || "127.0.0.1"
  return transportSchema.parse({
    kind: "loopback",
    host: host === "localhost" ? "127.0.0.1" : host,
    port: Number(rawPort),
  })
}

function receiptAuthority(env: NodeJS.ProcessEnv): BrokerConfig["receiptAuthority"] {
  if (
    env.LYRASHIELD_SUPERVISOR_SIGNING_SECRET ||
    env.LYRASHIELD_SUPERVISOR_MIRROR_SIGNING_SECRET ||
    env.LYRASHIELD_SUPERVISOR_ATTEMPT_PROOF_PRIVATE_KEY ||
    env.LYRASHIELD_SUPERVISOR_RECEIPT_DATABASE_URL ||
    env.LYRASHIELD_SUPERVISOR_PROOF_DATABASE_URL ||
    env.LYRASHIELD_SUPERVISOR_CONTROL_TOKEN
  )
    throw new Error("Broker must not receive private supervisor credentials")
  const raw = env.LYRASHIELD_SUPERVISOR_JOURNAL_AUTHORITY_JSON?.trim()
  if (!raw) return undefined
  const source = protectedSourceSchema.safeParse(JSON.parse(raw))
  if (!source.success) throw new Error("Protected supervisor source configuration is invalid")
  return {
    ...source.data,
    attemptProofPublicKey: validateSupervisorAttemptProofPublicKey(
      required(env, "LYRASHIELD_SUPERVISOR_ATTEMPT_PROOF_PUBLIC_KEY")
    ),
    controlToken: required(env, "LYRASHIELD_SUPERVISOR_BROKER_CONTROL_TOKEN"),
  }
}

/**
 * Fail-closed installation. The broker holds the only dispatch-authority write
 * path, so a missing database URL or control token stops startup instead of
 * serving a control socket that cannot bind authority or authenticate callers.
 *
 * Preparation is deliberately not installed here. The compiler must be built
 * from verified protected host policy and an installed signing identity, which
 * only the protected host composition can supply; constructing one from
 * environment would let an operator-supplied string become command authority.
 * Until that installation exists, admission stays closed rather than
 * committing an unverified bundle.
 */
export function loadBrokerConfig(env: NodeJS.ProcessEnv = process.env): BrokerConfig {
  const connectionString = required(env, "LYRASHIELD_SCAN_EXECUTION_DATABASE_URL")
  const controlToken = required(env, "LYRASHIELD_BROKER_CONTROL_TOKEN")
  if (controlToken.length < 32 || /[\r\n]/.test(controlToken))
    throw new Error("LYRASHIELD_BROKER_CONTROL_TOKEN must be at least 32 characters")
  return {
    connectionString,
    ...(env.LYRASHIELD_SCAN_START_DATABASE_URL?.trim()
      ? { lifecycleConnectionString: env.LYRASHIELD_SCAN_START_DATABASE_URL.trim() }
      : {}),
    transport: transport(env),
    controlToken,
    admission: env.LYRASHIELD_BROKER_ADMISSION?.trim() === "open" ? "open" : "closed",
    receiptAuthority: receiptAuthority(env),
    preparationAuthority: undefined,
  }
}
