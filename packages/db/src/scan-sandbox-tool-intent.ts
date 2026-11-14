import { createId } from "@paralleldrive/cuid2"
import pg from "pg"
import {
  authorityActionSchema,
  canonicalJson,
  sandboxToolExecDescriptorSchema,
  sha256Hex,
  type AuthorityAction,
  type AuthoritySqlConnection,
  type SandboxToolExecDescriptor,
} from "@lyrashield/runtime-control"
import { createPgConnectionConfig } from "./connection-config"
import { readStoredDispatchCommand } from "./scan-dispatch-command-descriptor"
import {
  readCurrentAuthority,
  type ScanExecutionActionIntentResult,
} from "./scan-execution-action-intent"
import { readRetainedSupervisorAuthoritySource } from "./scan-supervisor-authority-source"
import { authenticateRetainedSupervisorAuthoritySource } from "./scan-supervisor-authority-source-verifier"
import { type SupervisorReceiptAuthority } from "./scan-supervisor-receipt-ingestion-verifier"

function unavailable(): never {
  throw new Error("Authenticated sandbox tool authority is unavailable")
}

export type SandboxToolIntentInput = {
  binding: AuthorityAction
  descriptor: SandboxToolExecDescriptor
  ownershipReceiptId: string
}

/** Parse retained bytes only; current source and ownership are checked separately. */
export function parseStoredSandboxToolIntent(row: {
  actionInputJson: string
  actionChecksum: string
}) {
  if (
    typeof row.actionInputJson !== "string" ||
    Buffer.byteLength(row.actionInputJson) > 128 * 1024 ||
    sha256Hex(row.actionInputJson) !== row.actionChecksum
  )
    unavailable()
  const descriptor = sandboxToolExecDescriptorSchema.parse(JSON.parse(row.actionInputJson))
  if (canonicalJson(descriptor) !== row.actionInputJson) unavailable()
  return descriptor
}

async function checkSource(
  connection: AuthoritySqlConnection,
  input: SandboxToolIntentInput,
  authority: SupervisorReceiptAuthority | undefined
) {
  const binding = authorityActionSchema.parse(input.binding)
  const descriptor = sandboxToolExecDescriptorSchema.parse(input.descriptor)
  const request = descriptor.request
  if (
    !authority ||
    binding.phase !== "SANDBOX_TOOL" ||
    binding.executorKey !== "sandbox" ||
    binding.authorityEpochId !== authority.authorityEpochId ||
    request.requestId !== binding.requestId ||
    request.binding.operationId !== binding.operationId ||
    request.binding.attemptId !== binding.attemptId ||
    request.binding.authorityEpochId !== binding.authorityEpochId ||
    request.binding.sandboxHandle !== descriptor.ownership.ownershipId ||
    !input.ownershipReceiptId ||
    Buffer.byteLength(canonicalJson(descriptor)) > 128 * 1024 ||
    sha256Hex(canonicalJson(descriptor)) !== binding.actionChecksum
  )
    unavailable()
  const current = await readCurrentAuthority(connection, binding)
  const prepare = readStoredDispatchCommand(current.commandInputJson, current.commandInputChecksum)
  if (!prepare || prepare.type !== "PREPARE") unavailable()
  const preparedAuthority = {
    attempt: prepare.attempt,
    executors: prepare.executors,
    provider: prepare.provider ?? null,
  }
  const sandbox = prepare.executors.find((executor) => executor.key === "sandbox")
  if (
    binding.commandId !== prepare.commandId ||
    binding.authorityChecksum !== sha256Hex(canonicalJson(preparedAuthority)) ||
    current.prepareStatus !== "COMPLETED" ||
    current.physicalState !== "ACTIVE" ||
    sandbox?.spec.kind !== "container" ||
    !sandbox.spec.resourceDescriptor ||
    descriptor.workspaceRoot !== sandbox.spec.resourceDescriptor.workspaceRoot ||
    request.timeoutSeconds * 1000 > current.deadlineAt.getTime() - Date.now()
  )
    unavailable()
  const receipt = (
    await connection.query(
      `SELECT r."commandId",r."receiptHash" FROM "ScanSupervisorReceipt" r
       JOIN "ScanDispatchAttempt" a ON a."operationId"=r."operationId" AND a."attemptId"=r."attemptId"
       WHERE r.id=$1 AND r."operationId"=$2 AND r."attemptId"=$3 AND a."workspaceId"=$4
       AND r."authorityEpochId"=$5 AND r."supervisorInstanceId"=$6
       AND r."eventType"='resource_started' AND r."executorKey"='sandbox' AND r."journalRecordId" IS NOT NULL`,
      [
        input.ownershipReceiptId,
        binding.operationId,
        binding.attemptId,
        binding.workspaceId,
        binding.authorityEpochId,
        authority.supervisorInstanceId,
      ]
    )
  ).rows[0]
  if (!receipt || typeof receipt.commandId !== "string" || typeof receipt.receiptHash !== "string")
    unavailable()
  const source = await readRetainedSupervisorAuthoritySource(connection, {
    operationId: binding.operationId,
    attemptId: binding.attemptId,
    commandId: receipt.commandId,
    authorityEpochId: binding.authorityEpochId,
    supervisorInstanceId: authority.supervisorInstanceId,
    receiptHash: receipt.receiptHash,
    executorKey: "sandbox",
  })
  const authenticated = await authenticateRetainedSupervisorAuthoritySource(
    source,
    authority,
    connection
  )
  const original = authenticated.original.payload
  if (
    authenticated.uncertain ||
    authenticated.receiptId !== input.ownershipReceiptId ||
    original.type !== "resource_started" ||
    original.executorKey !== "sandbox" ||
    canonicalJson(original.ownership) !== canonicalJson(descriptor.ownership) ||
    authenticated.ownership.some(
      (entry) => canonicalJson(entry.ownership) !== canonicalJson(descriptor.ownership)
    )
  )
    unavailable()
  if (descriptor.resultKind === "pty/stdin") {
    if (!descriptor.pty || !("sessionId" in descriptor.pty)) unavailable()
    const sessions = (
      await connection.query(
        `SELECT g.id,g."operationId",g."attemptId",g."authorityEpochId",g.phase,g."commandId",g."executorKey",g."actionChecksum",g."bindingInputJson",r."proofInputJson",r."proofChecksum",
      i."actionInputJson",i."authorityChecksum",i."requestId",i."prepareCommandId"
      FROM "ScanExecutionInvocationGuard" g JOIN "ScanExecutionInvocationResolution" r ON r."guardId"=g.id
      JOIN "ScanExecutionActionIntent" i ON i."operationId"=g."operationId" AND i."attemptId"=g."attemptId" AND i."workspaceId"=g."workspaceId" AND i."requestId"=g."requestId" AND i."actionChecksum"=g."actionChecksum"
      WHERE g.phase='SANDBOX_TOOL' AND g."operationId"=$1 AND g."attemptId"=$2 AND g."workspaceId"=$3 AND g."authorityEpochId"=$4
      AND i."actionInputJson"::jsonb->>'resultKind'='pty/start'
      AND (('x'||substring(encode(public.digest(convert_to(g.id,'UTF8'),'sha256'),'hex') FROM 1 FOR 13))::bit(52)::bigint+1)=$5::bigint LIMIT 2`,
        [
          binding.operationId,
          binding.attemptId,
          binding.workspaceId,
          binding.authorityEpochId,
          String(descriptor.pty.sessionId),
        ]
      )
    ).rows
    if (sessions.length !== 1) unavailable()
    const session = sessions[0]!
    if (
      typeof session.proofInputJson !== "string" ||
      sha256Hex(session.proofInputJson) !== session.proofChecksum
    )
      unavailable()
    const { sandboxInvocationAckSchema, verifySandboxInvocationAck } =
      await import("./scan-sandbox-tool-ack")
    const ack = sandboxInvocationAckSchema.parse(JSON.parse(session.proofInputJson))
    if (
      canonicalJson(ack) !== session.proofInputJson ||
      canonicalJson(ack.ownership) !== canonicalJson(descriptor.ownership)
    )
      unavailable()
    verifySandboxInvocationAck(
      ack,
      session as Parameters<typeof verifySandboxInvocationAck>[1],
      ack.commandInputChecksum,
      session as Parameters<typeof verifySandboxInvocationAck>[3]
    )
  }
  return { binding, descriptor, preparedAuthority, current }
}

/** Called only on the same connection holding the current native execution gate. */
export async function verifyStoredSandboxToolIntent(
  connection: AuthoritySqlConnection,
  binding: AuthorityAction,
  authority: SupervisorReceiptAuthority | undefined
) {
  const rows = (
    await connection.query(
      `SELECT "authorityInputJson","actionInputJson","ownershipReceiptId","prepareCommandId"
       FROM "ScanExecutionActionIntent" WHERE "operationId"=$1 AND "attemptId"=$2
       AND "workspaceId"=$3 AND "authorityEpochId"=$4 AND phase='SANDBOX_TOOL' AND "requestId"=$5
       AND "authorityChecksum"=$6 AND "actionChecksum"=$7 AND "expiresAt">clock_timestamp() AT TIME ZONE 'UTC'`,
      [
        binding.operationId,
        binding.attemptId,
        binding.workspaceId,
        binding.authorityEpochId,
        binding.requestId!,
        binding.authorityChecksum,
        binding.actionChecksum,
      ]
    )
  ).rows
  const row = rows[0]
  if (
    rows.length !== 1 ||
    typeof row?.actionInputJson !== "string" ||
    typeof row.authorityInputJson !== "string" ||
    typeof row.ownershipReceiptId !== "string"
  )
    unavailable()
  const checked = await checkSource(
    connection,
    {
      binding,
      descriptor: parseStoredSandboxToolIntent({
        actionInputJson: row.actionInputJson,
        actionChecksum: binding.actionChecksum,
      }),
      ownershipReceiptId: row.ownershipReceiptId,
    },
    authority
  )
  if (
    row.actionInputJson !== canonicalJson(checked.descriptor) ||
    row.authorityInputJson !== canonicalJson(checked.preparedAuthority) ||
    row.prepareCommandId !== checked.current.prepareCommandId
  )
    unavailable()
  return { deadlineAt: checked.current.deadlineAt }
}

export function createScanSandboxToolIntentProducer(options: {
  connectionString: string
  supervisorAuthority: SupervisorReceiptAuthority
}) {
  const authority = Object.freeze({ ...options.supervisorAuthority })
  const pool = new pg.Pool({ ...createPgConnectionConfig(options.connectionString), max: 2 })
  return {
    async authorizeRead(input: SandboxToolIntentInput): Promise<void> {
      const client = await pool.connect()
      let failed = true
      try {
        await client.query("BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY")
        await client.query("SET LOCAL statement_timeout='5s'")
        if (
          (await client.query("SELECT app.acquire_scan_preparation_gate() AS acquired")).rows[0]
            ?.acquired !== true
        )
          unavailable()
        await checkSource(
          { query: (text, values) => client.query(text, values), release: () => unavailable() },
          input,
          authority
        )
        await client.query("COMMIT")
        failed = false
      } finally {
        if (failed) {
          try {
            await client.query("ROLLBACK")
          } catch {
            /* Discard unavailable connection. */
          }
        }
        client.release(failed)
      }
    },
    async publish(input: SandboxToolIntentInput): Promise<ScanExecutionActionIntentResult> {
      const client = await pool.connect()
      let committing = false,
        failed = true
      try {
        await client.query("BEGIN ISOLATION LEVEL READ COMMITTED")
        await client.query("SET LOCAL statement_timeout='10s'")
        await client.query("SET LOCAL lock_timeout='3s'")
        if (
          (await client.query("SELECT app.acquire_scan_preparation_gate() AS acquired")).rows[0]
            ?.acquired !== true
        )
          unavailable()
        const checked = await checkSource(
          { query: (text, values) => client.query(text, values), release: () => unavailable() },
          input,
          authority
        )
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,1))", [
          checked.binding.operationId,
        ])
        const authorityInputJson = canonicalJson(checked.preparedAuthority)
        const actionInputJson = canonicalJson(checked.descriptor)
        const existing = (
          await client.query(
            `SELECT id,"authorityInputJson","actionInputJson","ownershipReceiptId" FROM "ScanExecutionActionIntent"
           WHERE "operationId"=$1 AND phase='SANDBOX_TOOL' AND "requestId"=$2`,
            [checked.binding.operationId, checked.binding.requestId]
          )
        ).rows[0]
        if (
          existing &&
          (existing.authorityInputJson !== authorityInputJson ||
            existing.actionInputJson !== actionInputJson ||
            existing.ownershipReceiptId !== input.ownershipReceiptId)
        )
          unavailable()
        const actionId = existing?.id ?? createId()
        if (!existing)
          await client.query(
            `INSERT INTO "ScanExecutionActionIntent"(id,phase,"operationId","attemptId","scanId","workspaceId","authorityEpochId","authorityRevision","requestId","prepareCommandId","authorityInputJson","authorityChecksum","actionInputJson","actionChecksum","ownershipReceiptId","expiresAt")
           VALUES($1,'SANDBOX_TOOL',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
            [
              actionId,
              checked.binding.operationId,
              checked.binding.attemptId,
              checked.binding.scanId,
              checked.binding.workspaceId,
              checked.binding.authorityEpochId,
              checked.binding.authorityRevision,
              checked.binding.requestId,
              checked.current.prepareCommandId,
              authorityInputJson,
              checked.binding.authorityChecksum,
              actionInputJson,
              checked.binding.actionChecksum,
              input.ownershipReceiptId,
              checked.current.deadlineAt,
            ]
          )
        committing = true
        await client.query("COMMIT")
        failed = false
        return { kind: "committed", requestId: checked.descriptor.request.requestId, actionId }
      } catch (error) {
        if (committing)
          return {
            kind: "unknown",
            requestId: input.descriptor.request.requestId,
            reasonCode: "COMMIT_OUTCOME_UNKNOWN",
          }
        try {
          await client.query("ROLLBACK")
        } catch {
          /* Discard the broken connection. */
        }
        throw error
      } finally {
        client.release(failed)
      }
    },
    close: () => pool.end(),
  }
}
