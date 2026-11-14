import { z } from "zod"
import { createProtectedSupervisorReceiptAuthority } from "@lyrashield/db/src/scan-supervisor-receipt-source"
import type { ProviderRoute } from "./config"
import { createDatabaseProviderAuthority } from "./database-authority"

const identity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,191}$/)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const sourceSchema = z
  .object({
    streamId: identity,
    authorityEpochId: identity,
    supervisorInstanceId: identity,
    originalKeyHash: hash,
    wrapperKeyHash: hash,
    socketPath: z.string().min(1).max(100).startsWith("/"),
  })
  .strict()

function required(env: NodeJS.ProcessEnv, key: string) {
  const value = env[key]?.trim()
  if (!value) throw new Error(`Protected gateway installation requires ${key}`)
  return value
}

export function loadDatabaseProviderAuthority(
  providers: ReadonlyMap<string, ProviderRoute>,
  env: NodeJS.ProcessEnv = process.env
) {
  const connectionString = env.LYRASHIELD_SCAN_EXECUTION_DATABASE_URL?.trim()
  if (!connectionString) return undefined
  let source: z.infer<typeof sourceSchema>
  try {
    source = sourceSchema.parse(
      JSON.parse(required(env, "LYRASHIELD_SUPERVISOR_JOURNAL_AUTHORITY_JSON"))
    )
  } catch {
    throw new Error("Protected supervisor source configuration is invalid")
  }
  const { socketPath, ...identity } = source
  const supervisorAuthority = createProtectedSupervisorReceiptAuthority({
    ...identity,
    connectionString,
    attemptProofPublicKey: env.LYRASHIELD_SUPERVISOR_ATTEMPT_PROOF_PUBLIC_KEY,
    originalSigningSecret: required(env, "LYRASHIELD_SUPERVISOR_SIGNING_SECRET"),
    wrapperSigningSecret: required(env, "LYRASHIELD_SUPERVISOR_MIRROR_SIGNING_SECRET"),
    controlToken: required(env, "LYRASHIELD_SUPERVISOR_CONTROL_TOKEN"),
    transport: { kind: "unix", socketPath },
  })
  return createDatabaseProviderAuthority({ connectionString, providers, supervisorAuthority })
}
