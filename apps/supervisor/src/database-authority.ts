import pg from "pg"
import { z } from "zod"
import {
  createSupervisorExecutionAuthorityCapability,
  ScanAuthorityContext,
  PostgresDurableScanAuthorityFence,
  type VerifyActionAuthority,
} from "@lyrashield/runtime-control"
import { createPgConnectionConfig } from "@lyrashield/db/src/connection-config"
import { createScanExecutionActionAuthorityVerifier } from "@lyrashield/db/src/scan-execution-action-intent"
import { createScanExecutionInvocationGuardWriter } from "@lyrashield/db/src/scan-execution-invocation-guard"
import { createProtectedSupervisorReceiptAuthority } from "@lyrashield/db/src/scan-supervisor-receipt-source"
import type { SupervisorConfig } from "./config"

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/)
const sourceSchema = z
  .object({
    streamId: id,
    authorityEpochId: id,
    supervisorInstanceId: id,
    originalKeyHash: z.string().regex(/^[a-f0-9]{64}$/),
    wrapperKeyHash: z.string().regex(/^[a-f0-9]{64}$/),
    socketPath: z.string().min(1).max(100).startsWith("/"),
  })
  .strict()
const expectedSchema = z
  .object({
    epochId: id,
    sourceRevision: z.string().regex(/^[a-f0-9]{40}$/),
    runtimePolicyDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict()

/** The installed host and current database authority must agree for every invocation. */
export function loadDatabaseSupervisorAuthority(
  config: Pick<SupervisorConfig, "signingSecret" | "supervisorInstanceId" | "controlToken">,
  env: NodeJS.ProcessEnv = process.env
) {
  const connectionString = env.LYRASHIELD_SCAN_EXECUTION_DATABASE_URL?.trim()
  if (!connectionString) return undefined

  let source: z.infer<typeof sourceSchema>
  let expected: z.infer<typeof expectedSchema>
  try {
    const raw = env.LYRASHIELD_SUPERVISOR_JOURNAL_AUTHORITY_JSON
    if (!raw || Buffer.byteLength(raw) > 4096) throw new Error()
    source = sourceSchema.parse(JSON.parse(raw))
    expected = expectedSchema.parse({
      epochId: env.LYRASHIELD_AUTHORITY_EPOCH_ID,
      sourceRevision: env.LYRASHIELD_PRODUCT_REVISION,
      runtimePolicyDigest: env.LYRASHIELD_RUNTIME_POLICY_DIGEST,
    })
    if (
      source.authorityEpochId !== expected.epochId ||
      source.supervisorInstanceId !== config.supervisorInstanceId ||
      source.originalKeyHash === source.wrapperKeyHash
    )
      throw new Error()
  } catch {
    throw new Error("Protected supervisor authority configuration is unavailable")
  }

  const { socketPath, ...identity } = source
  const supervisorAuthority = createProtectedSupervisorReceiptAuthority({
    ...identity,
    connectionString,
    attemptProofPublicKey: env.LYRASHIELD_SUPERVISOR_ATTEMPT_PROOF_PUBLIC_KEY,
    originalSigningSecret: config.signingSecret,
    wrapperSigningSecret: env.LYRASHIELD_SUPERVISOR_MIRROR_SIGNING_SECRET,
    controlToken: config.controlToken,
    transport: { kind: "unix", socketPath },
  })
  const verifyCurrent = createScanExecutionActionAuthorityVerifier({
    approvedProviderPolicies: new Map(),
    supervisorAuthority,
  })
  const installed = createSupervisorExecutionAuthorityCapability()
  const verify: VerifyActionAuthority = async (connection, binding) => {
    const current = await verifyCurrent(connection, binding)
    const host = await installed.verifyAction(connection, binding)
    if (
      host.epochId !== expected.epochId ||
      host.sourceRevision !== expected.sourceRevision ||
      host.runtimePolicyDigest !== expected.runtimePolicyDigest ||
      host.supervisorInstanceId !== config.supervisorInstanceId
    )
      throw new Error("Installed supervisor authority does not match")
    return current
  }
  const pool = new pg.Pool({
    ...createPgConnectionConfig(connectionString),
    max: 2,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 10_000,
  })
  const context = new ScanAuthorityContext()
  return {
    authorityFence: new PostgresDurableScanAuthorityFence(
      pool,
      verify,
      createScanExecutionInvocationGuardWriter(verify),
      context
    ),
    context,
    pool,
    supervisorAuthority,
    close: () => pool.end(),
  }
}
