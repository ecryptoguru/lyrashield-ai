import { createId } from "@paralleldrive/cuid2"
import pg from "pg"
import { z } from "zod"
import {
  authorityActionSchema,
  canonicalJson,
  providerGrantRequestSchema,
  sha256Hex,
  supervisorAttemptProofSchema,
  verifySupervisorAttemptProof,
  type AuthorityAction,
  type AuthoritySqlConnection,
  type VerifyActionAuthority,
  type ProviderGrantRequest,
  type PrepareCommand,
} from "@lyrashield/runtime-control"
import { createPgConnectionConfig } from "./connection-config"
import {
  assertPreparationProviderPolicy,
  readStoredDispatchCommand,
} from "./scan-dispatch-command-descriptor"

import { readRetainedSupervisorAuthoritySource } from "./scan-supervisor-authority-source"
import { authenticateRetainedSupervisorAuthoritySource } from "./scan-supervisor-authority-source-verifier"
import {
  checkReceiptKeys,
  type SupervisorReceiptAuthority,
} from "./scan-supervisor-receipt-ingestion-verifier"

import { assertPreparedInvocationCompleted } from "./scan-prepared-predecessor"
import { verifyStoredSandboxToolIntent } from "./scan-sandbox-tool-intent"

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const providerActionSchema = z
  .object({
    requestId: z.string().min(3).max(192),
    providerId: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
    path: z.string().min(1).max(4096).startsWith("/"),
    query: z.string().max(4096),
    method: z.literal("POST"),
    contentType: z.literal("application/json"),
    accept: z.string().min(1).max(1024),
    bodyHash: hash,
  })
  .strict()
const providerAuthoritySchema = z
  .object({ request: providerGrantRequestSchema, policy: z.record(z.string(), z.unknown()) })
  .strict()

export interface ScanExecutionActionIntentInput {
  binding: AuthorityAction
  authorityInput: unknown
  actionInput: unknown
  ownershipReceiptId?: string
}
export type ScanExecutionActionIntentResult =
  | { kind: "committed"; requestId: string; actionId: string }
  | { kind: "unknown"; requestId: string; reasonCode: "COMMIT_OUTCOME_UNKNOWN" }

function unavailable(): never {
  throw new Error("Current scan execution action authority is unavailable")
}
function exactBytes(value: unknown): string {
  const bytes = canonicalJson(value)
  if (Buffer.byteLength(bytes) > 128 * 1024) unavailable()
  return bytes
}

/** Protected installation configuration, never a worker-supplied policy. */
export type ScanExecutionActionPolicy = {
  approvedProviderPolicies: ReadonlyMap<string, unknown>
  supervisorAuthority?: SupervisorReceiptAuthority
}
function freezePolicies(policy: ScanExecutionActionPolicy) {
  return new Map([...policy.approvedProviderPolicies].map(([id, value]) => [id, exactBytes(value)]))
}

export function parseProviderActionIntent(
  input: ScanExecutionActionIntentInput,
  approvedPolicies: ReadonlyMap<string, string>
) {
  const binding = authorityActionSchema.parse(input.binding)
  if (binding.phase !== "PROVIDER_DISPATCH" || input.ownershipReceiptId !== undefined) unavailable()
  const authority = providerAuthoritySchema.parse(input.authorityInput)
  const action = providerActionSchema.parse(input.actionInput)
  const request = authority.request
  if (
    request.operationId !== binding.operationId ||
    request.attemptId !== binding.attemptId ||
    request.scanId !== binding.scanId ||
    request.workspaceId !== binding.workspaceId ||
    request.authorityEpochId !== binding.authorityEpochId ||
    request.authorityRevision !== binding.authorityRevision ||
    action.requestId !== binding.requestId ||
    action.providerId !== request.providerId ||
    approvedPolicies.get(request.providerId) !== exactBytes(authority.policy) ||
    action.path + action.query !== authority.policy.endpoint
  )
    unavailable()
  const authorityInputJson = exactBytes(authority),
    actionInputJson = exactBytes(action)
  if (
    sha256Hex(authorityInputJson) !== binding.authorityChecksum ||
    sha256Hex(actionInputJson) !== binding.actionChecksum
  )
    unavailable()
  return { binding, authority, action, authorityInputJson, actionInputJson }
}

type CurrentAuthorityBinding = Pick<
  AuthorityAction,
  | "phase"
  | "operationId"
  | "attemptId"
  | "scanId"
  | "workspaceId"
  | "authorityEpochId"
  | "authorityRevision"
>

type CurrentAuthority = {
  commandInputJson: string | null
  commandInputChecksum: string | null
  maxBudgetUsd: string
  deadlineAt: Date
  prepareCommandId: string
  physicalState: string
  prepareStatus: string
}

/** RLS context is derived only from the immutable private operation. */
export async function bindScanExecutionAuthorityContext(
  connection: AuthoritySqlConnection,
  operationId: string
) {
  const context = (
    await connection.query("SELECT * FROM app.scan_preparation_context($1)", [operationId])
  ).rows[0]
  if (
    !context ||
    typeof context.workspaceId !== "string" ||
    typeof context.accountId !== "string" ||
    typeof context.userId !== "string"
  )
    unavailable()
  await connection.query(
    "SELECT set_config('app.current_workspace_id',$1,true),set_config('app.current_account_id',$2,true),set_config('app.current_scan_user_id',$3,true)",
    [context.workspaceId, context.accountId, context.userId]
  )
}

/** Reads all current source authority on the caller's already-held native gate. */
export async function readCurrentAuthority(
  connection: AuthoritySqlConnection,
  binding: CurrentAuthorityBinding
): Promise<CurrentAuthority> {
  await connection.query("SELECT app.require_scan_execution_action_role()", [])
  await bindScanExecutionAuthorityContext(connection, binding.operationId)
  const row = (
    await connection.query(
      `SELECT c."commandInputJson",c."commandInputChecksum",c.id AS "prepareCommandId",c.status::text AS "prepareStatus",
    a."maxBudgetUsd"::text, g."instanceId" AS "workerInstanceId", p.state::text AS "physicalState",checked."deadlineAt" AT TIME ZONE 'UTC' AS "deadlineAt"
    FROM "ScanDispatchAttempt" a JOIN "ScanDispatchOutbox" c ON c."operationId"=a."operationId" AND c."attemptId"=a."attemptId" AND c."commandType"='PREPARE'
    JOIN "ScanPhysicalExecution" p ON p."operationId"=a."operationId" AND p."attemptId"=a."attemptId"
    JOIN "ScanWorkerInstanceGrant" g ON g.id=a."workerInstanceGrantId" AND g."authorityEpochId"=a."authorityEpochId"
    JOIN "ScanAuthorityEpoch" e ON e.id=a."authorityEpochId"
    JOIN "ScanCapacityReservation" r ON r."scanId"=a."scanId" AND r."workspaceId"=a."workspaceId" AND r."accountId"=a."sponsorAccountId" AND r."userId"=a."initiatingUserId" AND r."accountingVersion"=2
    CROSS JOIN LATERAL app.check_scan_current_execution_authority(a."scanId",least(a."expiresAt",g."expiresAt",CASE WHEN $6='PREPARE' THEN a."authorityDeadlineAt" ELSE a."expiresAt" END),$6) checked
    WHERE a."operationId"=$1 AND a."attemptId"=$2 AND a."scanId"=$3 AND a."workspaceId"=$4 AND a."authorityEpochId"=$5
      AND a."authorityAcceptedAt" IS NOT NULL AND g."revokedAt" IS NULL AND g."issuedAt"<=clock_timestamp() AT TIME ZONE 'UTC'
      AND g."expiresAt">clock_timestamp() AT TIME ZONE 'UTC' AND e."isOpen" AND e."closedAt" IS NULL
      AND a."policyDigest"=app.scan_policy_digest(a."policyId") AND a."scopeDigest"=app.scan_dispatch_scope_digest(a."scanId")
      AND a."targetSnapshotDigest"=app.scan_target_snapshot_digest(a."targetId")
      AND CASE WHEN $6='PREPARE' THEN r.state='RESERVED' ELSE r.state='RUNNING' END
      AND ($6='PREPARE' OR EXISTS(SELECT 1 FROM "ScanDispatchStart" st WHERE st."operationId"=a."operationId" AND st."attemptId"=a."attemptId"
        AND st."policyDigest"=a."policyDigest" AND st."maxBudgetUsd"=a."maxBudgetUsd" AND st."maxRuntimeMs"=a."maxRuntimeMs"
        AND ((st.kind='PAID' AND a."maxBudgetUsd">0 AND st."billableClaimEventId" IS NOT NULL AND st."providerGrantDigest" IS NOT NULL)
          OR (st.kind='UNMETERED' AND a."maxBudgetUsd"=0 AND st."billableClaimEventId" IS NULL AND st."providerGrantDigest" IS NULL))))`,
      [
        binding.operationId,
        binding.attemptId,
        binding.scanId,
        binding.workspaceId,
        binding.authorityEpochId,
        binding.phase,
      ]
    )
  ).rows[0]
  if (!row || !(row.deadlineAt instanceof Date)) unavailable()
  const command = readStoredDispatchCommand(
    row.commandInputJson as string | null,
    row.commandInputChecksum as string | null
  )
  if (
    !command ||
    command.type !== "PREPARE" ||
    command.commandId !== row.prepareCommandId ||
    command.attempt.workerIdentity !== row.workerInstanceId ||
    command.attempt.authorityRevision !== binding.authorityRevision ||
    command.attempt.operationId !== binding.operationId ||
    command.attempt.attemptId !== binding.attemptId ||
    command.attempt.scanId !== binding.scanId ||
    command.attempt.workspaceId !== binding.workspaceId ||
    command.attempt.authorityEpochId !== binding.authorityEpochId
  )
    unavailable()
  return row as CurrentAuthority
}

async function authenticatedPredecessor(
  connection: AuthoritySqlConnection,
  binding: CurrentAuthorityBinding,
  authority: SupervisorReceiptAuthority | undefined,
  command: PrepareCommand,
  receiptHash?: string
) {
  if (!authority || authority.authorityEpochId !== binding.authorityEpochId) unavailable()
  checkReceiptKeys(authority)
  const found = (
    await connection.query(
      `SELECT r."receiptHash" FROM "ScanSupervisorReceipt" r
   JOIN "ScanDispatchAttempt" a ON a."operationId"=r."operationId" AND a."attemptId"=r."attemptId"
   WHERE r."operationId"=$1 AND r."attemptId"=$2 AND a."workspaceId"=$3 AND r."commandId"=$4
   AND r."authorityEpochId"=$5 AND r."supervisorInstanceId"=$6 AND r."journalRecordId" IS NOT NULL AND (r."terminalStatus" IS NOT NULL OR r."eventType"='attempt_prepared')
   AND ($7='' OR r."receiptHash"=$7) ORDER BY r.sequence DESC LIMIT 1`,
      [
        binding.operationId,
        binding.attemptId,
        binding.workspaceId,
        command.commandId,
        binding.authorityEpochId,
        authority.supervisorInstanceId,
        receiptHash ?? "",
      ]
    )
  ).rows[0]
  if (!found || typeof found.receiptHash !== "string") unavailable()
  const source = await readRetainedSupervisorAuthoritySource(connection, {
    operationId: binding.operationId,
    attemptId: binding.attemptId,
    commandId: command.commandId,
    authorityEpochId: binding.authorityEpochId,
    supervisorInstanceId: authority.supervisorInstanceId,
    receiptHash: found.receiptHash,
  })
  const authenticated = await authenticateRetainedSupervisorAuthoritySource(
    source,
    authority,
    connection
  )
  if (authenticated.uncertain) unavailable()
  await assertPreparedInvocationCompleted(connection, authority, command, authenticated)
  return authenticated
}

async function checkApprovedPaidProviderGrant(
  connection: AuthoritySqlConnection,
  request: ProviderGrantRequest,
  supervisorAuthority: SupervisorReceiptAuthority | undefined
) {
  const binding: CurrentAuthorityBinding = { ...request, phase: "PROVIDER_DISPATCH" }
  const current = await readCurrentAuthority(connection, binding)
  const command = readStoredDispatchCommand(current.commandInputJson, current.commandInputChecksum)
  if (
    !command ||
    command.type !== "PREPARE" ||
    !command.provider ||
    current.prepareStatus !== "COMPLETED" ||
    command.attempt.billingMode !== "PAID"
  )
    unavailable()
  assertPreparationProviderPolicy(command, current.maxBudgetUsd)
  const policy = command.provider
  for (const name of [
    "providerId",
    "maxRequests",
    "costReservationMicros",
    "maxReservedCostMicros",
  ] as const)
    if (request[name] !== policy[name]) unavailable()
  if (
    Date.parse(request.expiresAt) > Date.parse(command.attempt.expiresAt) ||
    Date.parse(request.expiresAt) <= Date.now()
  )
    unavailable()
  const funded = (
    await connection.query(
      `SELECT c."commandInputJson" AS "startCommandInputJson",c."commandInputChecksum" AS "startCommandInputChecksum" FROM "ScanDispatchStart" st
    JOIN "ScanDispatchOutbox" c ON c."operationId"=st."operationId" AND c."attemptId"=st."attemptId" AND c."commandType"='START_PAID' AND c.id=$5
    JOIN "ScanCapacityReservation" r ON r."scanId"=$3 AND r."workspaceId"=$4
    JOIN "ScanDispatchAttempt" a ON a."attemptId"=st."attemptId" AND a."operationId"=st."operationId"
    WHERE st."operationId"=$1 AND st."attemptId"=$2 AND st.kind='PAID' AND st."maxBudgetUsd"=a."maxBudgetUsd"
      AND st."policyDigest"=a."policyDigest" AND st."billableClaimEventId" IS NOT NULL AND st."providerGrantDigest" IS NOT NULL
      AND r.state='RUNNING' AND r."accountId"=a."sponsorAccountId" AND r."userId"=a."initiatingUserId" AND r."accountingVersion"=2`,
      [
        request.operationId,
        request.attemptId,
        request.scanId,
        request.workspaceId,
        request.grantRequestId,
      ]
    )
  ).rows[0]
  if (!funded) unavailable()
  const startCommand = readStoredDispatchCommand(
    funded.startCommandInputJson as string | null,
    funded.startCommandInputChecksum as string | null
  )
  if (
    !startCommand ||
    startCommand.type !== "START_PAID" ||
    startCommand.commandId !== request.grantRequestId ||
    startCommand.attemptId !== request.attemptId
  )
    unavailable()
  await authenticatedPredecessor(connection, binding, supervisorAuthority, command)
  return current
}

async function checkProviderSource(
  connection: AuthoritySqlConnection,
  parsed: ReturnType<typeof parseProviderActionIntent>,
  supervisorAuthority: SupervisorReceiptAuthority | undefined
) {
  const current = await checkApprovedPaidProviderGrant(
    connection,
    parsed.authority.request,
    supervisorAuthority
  )
  if (current.physicalState !== "ACTIVE") unavailable()
  return current
}

/** Creates evidence only. Native invocation additionally requires the action verifier and durable invocation guard. */
export function createScanExecutionActionIntentProducer(
  options: { connectionString: string; maximumPoolSize?: number } & ScanExecutionActionPolicy
) {
  const approvedPolicies = freezePolicies(options)
  const supervisorAuthority = options.supervisorAuthority
    ? Object.freeze({ ...options.supervisorAuthority })
    : undefined
  const pool = new pg.Pool({
    ...createPgConnectionConfig(options.connectionString),
    max: options.maximumPoolSize ?? 2,
  })
  return {
    /** Issue only the original START-bound grant; every paid dispatch is fenced again. */
    async authorizeGrant(input: unknown): Promise<Record<string, unknown>> {
      const request = providerGrantRequestSchema.parse(input)
      const policyInputJson = approvedPolicies.get(request.providerId)
      if (!policyInputJson) unavailable()
      const policy = z.record(z.string(), z.unknown()).parse(JSON.parse(policyInputJson))
      const client = await pool.connect()
      let failed = true
      try {
        await client.query("BEGIN ISOLATION LEVEL READ COMMITTED")
        await client.query("SET LOCAL statement_timeout='10s'")
        await client.query("SET LOCAL lock_timeout='3s'")
        const acquired = await client.query(
          "SELECT app.acquire_scan_preparation_gate() AS acquired"
        )
        if (acquired.rows[0]?.acquired !== true) unavailable()
        await checkApprovedPaidProviderGrant(
          {
            query: async (text, values) => client.query(text, values),
            release: () => unavailable(),
          },
          request,
          supervisorAuthority
        )
        const previous = (
          await client.query(
            `SELECT "authorityChecksum" FROM "ScanExecutionActionIntent" WHERE "operationId"=$1 AND "attemptId"=$2 AND phase='PROVIDER_DISPATCH' LIMIT 1`,
            [request.operationId, request.attemptId]
          )
        ).rows[0]
        if (
          previous &&
          previous.authorityChecksum !== sha256Hex(canonicalJson({ request, policy }))
        )
          unavailable()
        await client.query("ROLLBACK")
        failed = false
        return policy
      } finally {
        client.release(failed)
      }
    },
    async publish(input: ScanExecutionActionIntentInput): Promise<ScanExecutionActionIntentResult> {
      const parsed = parseProviderActionIntent(input, approvedPolicies)
      const client = await pool.connect()
      let committing = false,
        failed = true
      try {
        await client.query("BEGIN ISOLATION LEVEL READ COMMITTED")
        await client.query("SET LOCAL statement_timeout='10s'")
        await client.query("SET LOCAL lock_timeout='3s'")
        await client.query("SELECT app.require_scan_execution_action_role()")
        const acquired = await client.query(
          "SELECT app.acquire_scan_preparation_gate() AS acquired"
        )
        if (acquired.rows[0]?.acquired !== true) unavailable()
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,1))", [
          parsed.binding.operationId,
        ])
        const current = await checkProviderSource(
          {
            query: async (text, values) => client.query(text, values),
            release: () => unavailable(),
          },
          parsed,
          supervisorAuthority
        )
        const existing = (
          await client.query(
            `SELECT id,"authorityInputJson","actionInputJson" FROM "ScanExecutionActionIntent" WHERE "operationId"=$1 AND phase='PROVIDER_DISPATCH' AND "requestId"=$2`,
            [parsed.binding.operationId, parsed.binding.requestId]
          )
        ).rows[0]
        if (
          existing &&
          (existing.authorityInputJson !== parsed.authorityInputJson ||
            existing.actionInputJson !== parsed.actionInputJson)
        )
          unavailable()
        const actionId = existing?.id ?? createId()
        if (!existing)
          await client.query(
            `INSERT INTO "ScanExecutionActionIntent"(id,phase,"operationId","attemptId","scanId","workspaceId","authorityEpochId","authorityRevision","requestId","prepareCommandId","authorityInputJson","authorityChecksum","actionInputJson","actionChecksum","expiresAt") VALUES($1,'PROVIDER_DISPATCH',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
            [
              actionId,
              parsed.binding.operationId,
              parsed.binding.attemptId,
              parsed.binding.scanId,
              parsed.binding.workspaceId,
              parsed.binding.authorityEpochId,
              parsed.binding.authorityRevision,
              parsed.binding.requestId,
              current.prepareCommandId,
              parsed.authorityInputJson,
              parsed.binding.authorityChecksum,
              parsed.actionInputJson,
              parsed.binding.actionChecksum,
              parsed.authority.request.expiresAt,
            ]
          )
        committing = true
        await client.query("COMMIT")
        failed = false
        return { kind: "committed", requestId: parsed.action.requestId, actionId }
      } catch (error) {
        if (committing)
          return {
            kind: "unknown",
            requestId: parsed.action.requestId,
            reasonCode: "COMMIT_OUTCOME_UNKNOWN",
          }
        try {
          await client.query("ROLLBACK")
        } catch {
          /* Broken clients are discarded. */
        }
        throw error
      } finally {
        client.release(failed)
      }
    },
    close: () => pool.end(),
  }
}

/** Current exact command/action authority only; installation must separately qualify the epoch and protected host. */
export function createScanExecutionActionAuthorityVerifier(
  options: ScanExecutionActionPolicy
): VerifyActionAuthority {
  const approvedPolicies = freezePolicies(options)
  const supervisorAuthority = options.supervisorAuthority
    ? Object.freeze({ ...options.supervisorAuthority })
    : undefined
  return async (connection, input) => {
    const binding = authorityActionSchema.parse(input)
    await bindScanExecutionAuthorityContext(connection, binding.operationId)
    if (
      (await connection.query("SELECT app.scan_preparation_gate_held() AS held", [])).rows[0]
        ?.held !== true
    )
      unavailable()
    if (binding.phase === "SANDBOX_TOOL")
      return verifyStoredSandboxToolIntent(connection, binding, supervisorAuthority)
    if (binding.phase === "PROVIDER_DISPATCH") {
      const row = (
        await connection.query(
          `SELECT "authorityInputJson","actionInputJson" FROM "ScanExecutionActionIntent" WHERE "operationId"=$1 AND "attemptId"=$2 AND "workspaceId"=$3 AND phase='PROVIDER_DISPATCH' AND "requestId"=$4 AND "authorityChecksum"=$5 AND "actionChecksum"=$6 AND "expiresAt">clock_timestamp() AT TIME ZONE 'UTC'`,
          [
            binding.operationId,
            binding.attemptId,
            binding.workspaceId,
            binding.requestId!,
            binding.authorityChecksum,
            binding.actionChecksum,
          ]
        )
      ).rows[0]
      if (
        !row ||
        typeof row.authorityInputJson !== "string" ||
        typeof row.actionInputJson !== "string"
      )
        unavailable()
      const parsed = parseProviderActionIntent(
        {
          binding,
          authorityInput: JSON.parse(row.authorityInputJson),
          actionInput: JSON.parse(row.actionInputJson),
        },
        approvedPolicies
      )
      if (
        parsed.authorityInputJson !== row.authorityInputJson ||
        parsed.actionInputJson !== row.actionInputJson
      )
        unavailable()
      const current = await checkProviderSource(connection, parsed, supervisorAuthority)
      return {
        deadlineAt: new Date(
          Math.min(current.deadlineAt.getTime(), Date.parse(parsed.authority.request.expiresAt))
        ),
      }
    }
    const current = await readCurrentAuthority(connection, binding)
    const prepare = readStoredDispatchCommand(
      current.commandInputJson,
      current.commandInputChecksum
    )
    if (
      !prepare ||
      prepare.type !== "PREPARE" ||
      sha256Hex(
        canonicalJson({
          attempt: prepare.attempt,
          executors: prepare.executors,
          provider: prepare.provider ?? null,
        })
      ) !== binding.authorityChecksum
    )
      unavailable()
    const row = (
      await connection.query(
        `SELECT "commandInputJson","commandInputChecksum","authorityProofInputJson","authorityProofChecksum","createdAt" AT TIME ZONE 'UTC' AS "createdAt" FROM "ScanDispatchOutbox" WHERE id=$1 AND "operationId"=$2 AND "attemptId"=$3 AND status IN ('PENDING','LEASED','DELIVERED','ACCEPTED')`,
        [binding.commandId!, binding.operationId, binding.attemptId]
      )
    ).rows[0]
    if (!row) unavailable()
    const command = readStoredDispatchCommand(
      row.commandInputJson as string | null,
      row.commandInputChecksum as string | null
    )
    if (!command || row.commandInputChecksum !== binding.actionChecksum) unavailable()
    if (binding.phase === "PREPARE") {
      if (
        command.type !== "PREPARE" ||
        command.commandId !== prepare.commandId ||
        current.physicalState !== "RESERVED"
      )
        unavailable()
    } else {
      if (command.type !== "START_PAID" && command.type !== "START_UNMETERED") unavailable()
      if (
        command.executorKey !== binding.executorKey ||
        !prepare.executors.some((plan) => plan.key === binding.executorKey) ||
        current.prepareStatus !== "COMPLETED" ||
        !["PREPARING", "DISPATCH_PENDING", "ACTIVE"].includes(current.physicalState)
      )
        unavailable()
      const predecessor = await authenticatedPredecessor(
        connection,
        binding,
        supervisorAuthority,
        prepare
      )
      if (
        !supervisorAuthority ||
        typeof row.authorityProofInputJson !== "string" ||
        sha256Hex(row.authorityProofInputJson) !== row.authorityProofChecksum ||
        !(row.createdAt instanceof Date)
      )
        unavailable()
      const retained = supervisorAttemptProofSchema.parse(JSON.parse(row.authorityProofInputJson))
      const proof = verifySupervisorAttemptProof(
        retained,
        {
          ...retained.input,
          operationId: binding.operationId,
          attemptId: binding.attemptId,
          scanId: binding.scanId,
          workspaceId: binding.workspaceId,
          authorityEpochId: binding.authorityEpochId,
          commandId: command.commandId,
          type: command.type,
          executorKey: command.executorKey,
        },
        {
          publicKey: supervisorAuthority.attemptProofPublicKey ?? "",
          supervisorInstanceId: supervisorAuthority.supervisorInstanceId,
        },
        row.createdAt
      )
      if (
        proof.prepareChecksum !== sha256Hex(canonicalJson(prepare)) ||
        proof.commandChecksum !== row.commandInputChecksum ||
        predecessor.commandPredecessors.get(command.commandId) !== command.expectedReceiptHash
      )
        unavailable()
    }
    return { deadlineAt: current.deadlineAt }
  }
}
