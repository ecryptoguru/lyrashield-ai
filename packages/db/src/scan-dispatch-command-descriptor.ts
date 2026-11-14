import type pg from "pg"
import { Prisma } from "./generated/prisma"
import { canonicalizeJson, sha256Sync } from "@lyrashield/security/webmcp"
import {
  ScanExecutionPlanSchema,
  type ScanExecutionPlan,
  type ScanJobData,
} from "@lyrashield/types"
import {
  supervisorCommandSchema,
  type AttemptBinding,
  type PrepareCommand,
  type SupervisorCommand,
} from "@lyrashield/runtime-control"
import { ScanDispatchAuthorityError } from "./scan-dispatch-authority-error"

export type ScanPreparationCommandAuthority = Readonly<{
  commandId: string
  attempt: AttemptBinding
  executionPlan: ScanExecutionPlan
  executionPlanHash: string
  targetSnapshotDigest: string
  scopeDigest: string
  policyDigest: string
  maxBudgetUsd: string
  maxRuntimeMs: number
  workerGrantId: string
  mode: string
  goal: string
  attachments: readonly {
    id: string
    workspaceId: string
    filename: string
    mediaType: string
    byteLength: number
    checksum: string
    storageUri: string
    encryptionKeyRef: string
  }[]
  verifiedDomains: readonly {
    id: string
    domain: string
    expiresAt: Date
    verifiedAt: Date | null
  }[]
  target: Readonly<{
    id: string
    workspaceId: string
    type: string
    name: string
    url: string | null
    apiSpecUrl: string | null
    repoProvider: string | null
    repoOwner: string | null
    repoName: string | null
    repoFullName: string | null
    installationId: string | null
    branch: string | null
    environment: string
  }>
  policy: Readonly<Record<string, unknown>> | null
  focus: ScanJobData["focus"]
}>

/** Installed broker code captures protected host policy; this is never a worker request field. */
export type ScanPreparationCompiler = (
  authority: ScanPreparationCommandAuthority
) =>
  | Pick<PrepareCommand, "executors" | "provider">
  | Promise<Pick<PrepareCommand, "executors" | "provider">>

export function readStoredDispatchCommand(
  inputJson: string | null,
  checksum: string | null
): SupervisorCommand | null {
  if (inputJson === null && checksum === null) return null
  if (
    !inputJson ||
    !checksum ||
    Buffer.byteLength(inputJson) > 128 * 1024 ||
    sha256Sync(inputJson) !== checksum
  ) {
    throw new ScanDispatchAuthorityError(
      "DISPATCH_REPLAY_CONFLICT",
      "Command descriptor integrity unavailable"
    )
  }
  try {
    const command = supervisorCommandSchema.parse(JSON.parse(inputJson))
    if (canonicalizeJson(command) !== inputJson) throw new Error("noncanonical")
    return command
  } catch {
    throw new ScanDispatchAuthorityError(
      "DISPATCH_REPLAY_CONFLICT",
      "Command descriptor is malformed or noncanonical"
    )
  }
}

export function assertPreparationProviderPolicy(
  command: PrepareCommand,
  maxBudgetUsd: string
): void {
  const budgetMicros = new Prisma.Decimal(maxBudgetUsd).mul(1_000_000)
  if (
    !budgetMicros.isFinite() ||
    budgetMicros.isNegative() ||
    !budgetMicros.isInteger() ||
    (command.attempt.billingMode === "PAID") !== budgetMicros.gt(0) ||
    (command.attempt.billingMode === "PAID" ? !command.provider : !!command.provider) ||
    (command.provider &&
      (budgetMicros.lt(command.provider.maxReservedCostMicros) ||
        command.provider.costReservationMicros > command.provider.maxReservedCostMicros))
  ) {
    throw new ScanDispatchAuthorityError(
      "PREPARATION_AUTHORITY_UNAVAILABLE",
      "Descriptor provider policy contradicts persisted budget authority"
    )
  }
}

export async function compilePreparationCommand(
  client: pg.PoolClient,
  identity: { commandId: string; attemptId: string; operationId: string },
  compile: ScanPreparationCompiler,
  focus: ScanJobData["focus"]
): Promise<{ commandInputJson: string; commandInputChecksum: string }> {
  const result = await client.query<{
    attemptId: string
    scanId: string
    workspaceId: string
    operationId: string
    authorityEpochId: string
    authorityRevision: number
    workerIdentity: string
    billingMode: "PAID" | "UNMETERED"
    expiresAt: Date
    executionPlan: unknown
    executionPlanHash: string
    targetSnapshotDigest: string
    scopeDigest: string
    policyDigest: string
    maxBudgetUsd: string
    maxRuntimeMs: number
    workerGrantId: string
    mode: string
    goal: string
    target: ScanPreparationCommandAuthority["target"]
    policy: ScanPreparationCommandAuthority["policy"]
  }>(
    `SELECT a."attemptId",a."scanId",a."workspaceId",a."operationId",a."authorityEpochId",
      p.revision AS "authorityRevision",g."instanceId" AS "workerIdentity",
      CASE WHEN a."maxBudgetUsd">0 THEN 'PAID' ELSE 'UNMETERED' END AS "billingMode",a."expiresAt",
      s."executionPlan",s."executionPlanHash",a."targetSnapshotDigest",a."scopeDigest",a."policyDigest",
      a."maxBudgetUsd"::text,a."maxRuntimeMs",a."workerInstanceGrantId" AS "workerGrantId",s.mode::text AS mode,s.goal::text AS goal,
      to_jsonb(t) AS target,to_jsonb(policy) AS policy
    FROM "ScanDispatchAttempt" a JOIN "Scan" s ON s.id=a."scanId" AND s."workspaceId"=a."workspaceId"
    JOIN "ScanPhysicalExecution" p ON p."attemptId"=a."attemptId" AND p."operationId"=a."operationId"
    JOIN "ScanWorkerInstanceGrant" g ON g.id=a."workerInstanceGrantId" AND g."authorityEpochId"=a."authorityEpochId"
    JOIN "Target" t ON t.id=a."targetId" AND t."workspaceId"=a."workspaceId"
    LEFT JOIN "Policy" policy ON policy.id=a."policyId" AND policy."workspaceId"=a."workspaceId"
    WHERE a."attemptId"=$1 AND a."operationId"=$2 AND app.scan_preparation_gate_held()
      AND a."authorityTransactionId"=pg_current_xact_id()::text
      AND a."authorityDeadlineAt">clock_timestamp() AT TIME ZONE 'UTC'
      AND a."scopeDigest"=app.scan_dispatch_scope_digest(a."scanId")
      AND a."policyDigest"=app.scan_policy_digest(a."policyId")`,
    [identity.attemptId, identity.operationId]
  )
  const row = result.rows[0]
  if (!row)
    throw new ScanDispatchAuthorityError(
      "PREPARATION_AUTHORITY_UNAVAILABLE",
      "Descriptor requires original checked preparation authority"
    )
  const verified = ScanExecutionPlanSchema.safeParse(row.executionPlan)
  if (!verified.success || sha256Sync(canonicalizeJson(verified.data)) !== row.executionPlanHash)
    throw new ScanDispatchAuthorityError(
      "PREPARATION_AUTHORITY_UNAVAILABLE",
      "Descriptor execution plan is unavailable"
    )
  const attempt: AttemptBinding = {
    attemptId: row.attemptId,
    scanId: row.scanId,
    workspaceId: row.workspaceId,
    operationId: row.operationId,
    authorityEpochId: row.authorityEpochId,
    authorityRevision: row.authorityRevision,
    workerIdentity: row.workerIdentity,
    billingMode: row.billingMode,
    expiresAt: row.expiresAt.toISOString(),
  }
  const attachments = verified.data.attachmentIds.length
    ? (
        await client.query<ScanPreparationCommandAuthority["attachments"][number]>(
          `SELECT id,"workspaceId",filename,"mediaType","byteLength",checksum,"storageUri","encryptionKeyRef" FROM "ScanAttachment" WHERE "workspaceId"=$1 AND id=ANY($2::text[]) AND status='ACTIVE' AND "deletedAt" IS NULL ORDER BY id`,
          [row.workspaceId, verified.data.attachmentIds]
        )
      ).rows
    : []
  if (attachments.length !== verified.data.attachmentIds.length)
    throw new ScanDispatchAuthorityError(
      "PREPARATION_AUTHORITY_UNAVAILABLE",
      "Approved attachments unavailable"
    )
  const verifiedDomains =
    row.target.type === "WEB_APP" || row.target.type === "API"
      ? (
          await client.query<ScanPreparationCommandAuthority["verifiedDomains"][number]>(
            `SELECT id,domain,"expiresAt","verifiedAt" FROM "TargetDomainVerification" WHERE "workspaceId"=$1 AND status='VERIFIED' AND "verifiedAt" IS NOT NULL AND "expiresAt">clock_timestamp() AT TIME ZONE 'UTC' ORDER BY domain`,
            [row.workspaceId]
          )
        ).rows
      : []
  const compiled = await compile({
    commandId: identity.commandId,
    attempt: { ...attempt },
    executionPlan: verified.data,
    executionPlanHash: row.executionPlanHash,
    targetSnapshotDigest: row.targetSnapshotDigest,
    scopeDigest: row.scopeDigest,
    policyDigest: row.policyDigest,
    maxBudgetUsd: row.maxBudgetUsd,
    maxRuntimeMs: row.maxRuntimeMs,
    workerGrantId: row.workerGrantId,
    mode: row.mode,
    goal: row.goal,
    attachments,
    verifiedDomains,
    target: row.target,
    policy: row.policy,
    focus,
  })
  const command = supervisorCommandSchema.parse({
    type: "PREPARE",
    commandId: identity.commandId,
    attempt,
    executors: compiled.executors,
    ...(compiled.provider ? { provider: compiled.provider } : {}),
  })
  if (command.type !== "PREPARE")
    throw new ScanDispatchAuthorityError(
      "PREPARATION_AUTHORITY_UNAVAILABLE",
      "Descriptor command type unavailable"
    )
  assertPreparationProviderPolicy(command, row.maxBudgetUsd)
  const commandInputJson = canonicalizeJson(command)
  const commandInputChecksum = sha256Sync(commandInputJson)
  readStoredDispatchCommand(commandInputJson, commandInputChecksum)
  return { commandInputJson, commandInputChecksum }
}
