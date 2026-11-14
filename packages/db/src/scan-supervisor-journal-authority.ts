import {
  canonicalJson,
  sha256Hex,
  verifyJournalRecord,
  authorityEventSchema,
  authorityActionSchema,
  supervisorCommandSchema,
  type AttemptBinding,
  type AuthorityEvent,
  type AuthoritySqlConnection,
  type AuthoritySqlPool,
  type JournalRecord,
  type PostgresAuthorityMirror,
  type ScanAuthorityContext,
  type SupervisorCommand,
  type SupervisorRecoveryRequest,
} from "@lyrashield/runtime-control"
import { z } from "zod"
import { bindScanExecutionAuthorityContext } from "./scan-execution-action-intent"
import { readStoredDispatchCommand } from "./scan-dispatch-command-descriptor"
import {
  checkReceiptKeys,
  type SupervisorReceiptAuthority,
} from "./scan-supervisor-receipt-ingestion-verifier"
import { verifySupervisorReceiptHmac } from "./scan-supervisor-receipt-verifier"
import {
  verifySandboxInvocationAck,
  verifyOriginalSandboxMutationTargets,
} from "./scan-sandbox-tool-ack"
import { verifyNativeRetirement } from "./scan-native-retirement"

type Event = {
  type: string
  supervisorInstanceId: string
  observedAt: string
  [key: string]: unknown
}
type Original = JournalRecord<Event>
type Wrapped = JournalRecord<AuthorityEvent<Original>>
const originalSchema = z
  .object({
    version: z.literal(1),
    sequence: z.number().int().positive().safe(),
    previousHash: z.string().regex(/^[a-f0-9]{64}$/),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    signature: z.string().regex(/^[a-f0-9]{64}$/),
    payload: z
      .object({
        type: z.string(),
        supervisorInstanceId: z.string(),
        observedAt: z.string().datetime({ offset: true }),
      })
      .passthrough(),
  })
  .strict()

function unavailable(): never {
  throw new Error("Persisted supervisor journal authority is unavailable")
}
function commandId(event: Event): string {
  const value =
    event.type === "command_intent"
      ? supervisorCommandSchema.parse(event.command).commandId
      : event.commandId
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,191}$/.test(value)) unavailable()
  return value
}
function cleanup(event: Event, command: SupervisorCommand): boolean {
  return (
    command.type === "STOP" ||
    command.type === "RECONCILE" ||
    event.type === "provider_grants_revoked" ||
    event.type === "command_recovery_hold" ||
    event.type === "native_invocation_retired" ||
    (event.type === "command_terminal" && ["REJECTED", "UNKNOWN"].includes(String(event.status))) ||
    (event.type === "attempt_status" &&
      ["STOPPING", "STOPPED", "NEVER_DISPATCHED", "UNKNOWN"].includes(String(event.status)))
  )
}

/** Installed supervisor only: sealed reads check immutable authority; writes check current permission. */
export function createScanSupervisorJournalAuthority(options: {
  pool: AuthoritySqlPool
  context: ScanAuthorityContext
  identity: SupervisorReceiptAuthority
  mirror: PostgresAuthorityMirror
}) {
  const identity = options.identity
  checkReceiptKeys(identity)
  if (identity.originalKeyHash === identity.wrapperKeyHash) unavailable()

  async function connection<T>(
    operationId: string | undefined,
    live: boolean,
    check: (sql: AuthoritySqlConnection) => Promise<T>
  ): Promise<T> {
    const current = options.context.current()
    if (live && current && operationId && current.binding.operationId !== operationId) unavailable()
    const borrowed =
      current && (!operationId || current.binding.operationId === operationId) ? current : undefined
    const sql = borrowed?.connection ?? (await options.pool.connect())
    let failed = true
    try {
      await sql.query("BEGIN ISOLATION LEVEL READ COMMITTED", [])
      await sql.query("SET LOCAL statement_timeout='5000ms'", [])
      await sql.query("SET LOCAL idle_in_transaction_session_timeout='10s'", [])
      await sql.query("SELECT app.require_scan_execution_action_role()", [])
      if (live) {
        const proof = await sql.query(
          borrowed
            ? "SELECT app.scan_preparation_gate_held() AS acquired"
            : "SELECT app.acquire_scan_preparation_gate() AS acquired",
          []
        )
        if (proof.rows.length !== 1 || proof.rows[0]?.acquired !== true) unavailable()
      }
      const result = await check(sql)
      await sql.query("ROLLBACK", [])
      failed = false
      return result
    } finally {
      if (!borrowed) sql.release(failed)
    }
  }

  async function stream() {
    if (
      !(await options.mirror.verifySupervisorStreamBinding(
        identity.streamId,
        identity.originalKeyHash,
        identity.wrapperKeyHash
      ))
    )
      unavailable()
  }

  async function bound(
    sql: AuthoritySqlConnection,
    event: AuthorityEvent<Original>,
    binding: AttemptBinding,
    live = false
  ) {
    if (
      Buffer.byteLength(canonicalJson(event)) > 128 * 1024 ||
      event.epochId !== identity.authorityEpochId ||
      binding.authorityEpochId !== identity.authorityEpochId ||
      event.payload.payload.supervisorInstanceId !== identity.supervisorInstanceId ||
      event.eventId !== `supervisor:${event.payload.hash}` ||
      event.operationId !== binding.operationId ||
      event.attemptId !== binding.attemptId ||
      event.workspaceId !== binding.workspaceId ||
      event.scanId !== binding.scanId
    )
      unavailable()
    const original = verifySupervisorReceiptHmac({
      record: event.payload,
      expectedInstanceId: identity.supervisorInstanceId,
      secret: identity.originalSigningSecret,
      expectedKeyHash: identity.originalKeyHash,
      expectedSequence: event.payload.sequence,
      expectedPreviousHash: event.payload.previousHash,
    })
    if (!original.ok) unavailable()
    await stream()
    await sql.query("SELECT set_config('app.current_workspace_id',$1,true)", [binding.workspaceId])
    const row = (
      await sql.query(
        `SELECT p."commandInputJson" AS "prepareJson",p."commandInputChecksum" AS "prepareChecksum",
      c."commandInputJson",c."commandInputChecksum",a."expiresAt",a."authorityDeadlineAt",a."authorityAcceptedAt",
      a."policyDigest",a."scopeDigest",a."targetSnapshotDigest",a."scanId",a."workspaceId",a."authorityEpochId",
      a."workerInstanceGrantId",a."initiatingUserId",a."sponsorAccountId",g."instanceId",g."expiresAt" AS "grantExpiresAt",g."revokedAt",e."isOpen",e."closedAt"
      FROM "ScanDispatchAttempt" a JOIN "ScanDispatchOutbox" p ON p."operationId"=a."operationId"
        AND p."attemptId"=a."attemptId" AND p."commandType"='PREPARE'
      JOIN "ScanDispatchOutbox" c ON c."operationId"=a."operationId" AND c."attemptId"=a."attemptId" AND c.id=$6
      JOIN "ScanWorkerInstanceGrant" g ON g.id=a."workerInstanceGrantId" AND g."authorityEpochId"=a."authorityEpochId"
      JOIN "ScanAuthorityEpoch" e ON e.id=a."authorityEpochId"
      WHERE a."operationId"=$1 AND a."attemptId"=$2 AND a."workspaceId"=$3 AND a."scanId"=$4 AND a."authorityEpochId"=$5`,
        [
          binding.operationId,
          binding.attemptId,
          binding.workspaceId,
          binding.scanId,
          binding.authorityEpochId,
          commandId(event.payload.payload),
        ]
      )
    ).rows[0]
    if (!row || !row.authorityAcceptedAt) unavailable()
    if (typeof row.initiatingUserId !== "string" || typeof row.sponsorAccountId !== "string")
      unavailable()
    await sql.query(
      "SELECT set_config('app.current_account_id',$1,true),set_config('app.current_scan_user_id',$2,true)",
      [row.sponsorAccountId, row.initiatingUserId]
    )
    const prepare = readStoredDispatchCommand(
      row.prepareJson as string | null,
      row.prepareChecksum as string | null
    )
    const command = readStoredDispatchCommand(
      row.commandInputJson as string | null,
      row.commandInputChecksum as string | null
    )
    if (
      !prepare ||
      prepare.type !== "PREPARE" ||
      !command ||
      canonicalJson(prepare.attempt) !== canonicalJson(binding) ||
      row.instanceId !== binding.workerIdentity ||
      !(row.expiresAt instanceof Date) ||
      row.expiresAt.getTime() !== Date.parse(binding.expiresAt)
    )
      unavailable()
    const payload = event.payload.payload
    if (
      payload.type === "command_intent" &&
      canonicalJson(payload.command) !== canonicalJson(command)
    )
      unavailable()
    if (
      payload.type === "attempt_prepared" &&
      (command.type !== "PREPARE" ||
        canonicalJson(payload.binding) !== canonicalJson(prepare.attempt) ||
        canonicalJson(payload.executors) !== canonicalJson(prepare.executors) ||
        canonicalJson(payload.provider ?? null) !== canonicalJson(prepare.provider ?? null))
    )
      unavailable()
    if (
      payload.type.startsWith("native_invocation_") ||
      payload.type === "prepare_invocation_completed"
    ) {
      const guard = (
        await sql.query(
          `SELECT "bindingInputJson" FROM "ScanExecutionInvocationGuard"
        WHERE id=$1 AND "operationId"=$2 AND "attemptId"=$3 AND "workspaceId"=$4 AND "commandId"=$5`,
          [
            String(payload.guardId),
            binding.operationId,
            binding.attemptId,
            binding.workspaceId,
            command.commandId,
          ]
        )
      ).rows[0]
      if (!guard || typeof guard.bindingInputJson !== "string") unavailable()
      const action = authorityActionSchema.parse(JSON.parse(guard.bindingInputJson))
      if (
        (payload.type === "native_invocation_planned" ||
          payload.type === "native_invocation_retired") &&
        (payload.phase ?? "EXECUTOR_START") !== action.phase
      )
        unavailable()
      if (
        canonicalJson(action) !== guard.bindingInputJson ||
        sha256Hex(guard.bindingInputJson) !== payload.bindingInputChecksum ||
        action.actionChecksum !== payload.actionChecksum ||
        row.commandInputChecksum !== payload.commandInputChecksum ||
        action.authorityEpochId !== binding.authorityEpochId ||
        action.scanId !== binding.scanId ||
        action.authorityRevision !== binding.authorityRevision
      )
        unavailable()
      if (
        payload.type === "native_invocation_ack" &&
        ["SANDBOX_TOOL_START_ACK", "SANDBOX_TOOL_MUTATION_ACK"].includes(
          String(payload.nativeOperation)
        )
      ) {
        const tool = (
          await sql.query(
            `SELECT "actionInputJson","actionChecksum","authorityChecksum","requestId","prepareCommandId"
           FROM "ScanExecutionActionIntent" WHERE "operationId"=$1 AND "attemptId"=$2 AND "workspaceId"=$3
           AND phase='SANDBOX_TOOL' AND "requestId"=$4 AND "actionChecksum"=$5`,
            [
              binding.operationId,
              binding.attemptId,
              binding.workspaceId,
              String(payload.requestId),
              action.actionChecksum,
            ]
          )
        ).rows[0]
        if (!tool) unavailable()
        const acknowledged = verifySandboxInvocationAck(
          payload,
          {
            id: String(payload.guardId),
            operationId: action.operationId,
            attemptId: action.attemptId,
            authorityEpochId: action.authorityEpochId,
            phase: action.phase,
            commandId: action.commandId!,
            executorKey: action.executorKey!,
            actionChecksum: action.actionChecksum,
            bindingInputJson: guard.bindingInputJson,
          },
          row.commandInputChecksum as string,
          tool as Parameters<typeof verifySandboxInvocationAck>[3]
        )
        if (acknowledged.nativeOperation === "SANDBOX_TOOL_MUTATION_ACK")
          await verifyOriginalSandboxMutationTargets(
            { query: (text, values) => sql.query(text, values.map(String)) },
            acknowledged,
            binding
          )
      }
      const current = live ? options.context.forOperation(binding.operationId) : undefined
      if (
        live &&
        payload.type !== "native_invocation_retired" &&
        (!current ||
          current.guardId !== payload.guardId ||
          canonicalJson(current.binding) !== guard.bindingInputJson)
      )
        unavailable()
      if (payload.type === "native_invocation_retired") {
        const original =
          action.phase === "SANDBOX_TOOL"
            ? (
                await sql.query(
                  `SELECT "actionInputJson","actionChecksum","authorityChecksum","requestId","prepareCommandId"
            FROM "ScanExecutionActionIntent" WHERE "operationId"=$1 AND "attemptId"=$2 AND "workspaceId"=$3
            AND "authorityEpochId"=$4 AND phase='SANDBOX_TOOL' AND "requestId"=$5 AND "actionChecksum"=$6`,
                  [
                    binding.operationId,
                    binding.attemptId,
                    binding.workspaceId,
                    binding.authorityEpochId,
                    action.requestId!,
                    action.actionChecksum,
                  ]
                )
              ).rows
            : (
                await sql.query(
                  `SELECT "originalInputJson" FROM "ScanSupervisorJournalRecord" WHERE "streamId"=$1 AND "workspaceId"=$2
           AND "operationId"=$3 AND "attemptId"=$4 AND "originalInputJson"::jsonb#>>'{payload,type}'='native_invocation_planned'
           AND "originalInputJson"::jsonb#>>'{payload,guardId}'=$5 ORDER BY sequence DESC LIMIT 2`,
                  [
                    options.identity.streamId,
                    binding.workspaceId,
                    binding.operationId,
                    binding.attemptId,
                    String(payload.guardId),
                  ]
                )
              ).rows
        if (
          original.length !== 1 ||
          (action.phase !== "SANDBOX_TOOL" && typeof original[0]?.originalInputJson !== "string")
        )
          unavailable()
        verifyNativeRetirement(
          payload,
          {
            id: String(payload.guardId),
            operationId: action.operationId,
            attemptId: action.attemptId,
            authorityEpochId: action.authorityEpochId,
            phase: action.phase,
            commandId: action.commandId!,
            executorKey: action.executorKey!,
            actionChecksum: action.actionChecksum,
            bindingInputJson: guard.bindingInputJson,
          },
          row.commandInputChecksum as string,
          action.phase === "SANDBOX_TOOL"
            ? original[0]
            : JSON.parse(original[0]!.originalInputJson as string).payload
        )
        const stop = (
          await sql.query(
            `SELECT "commandInputJson","commandInputChecksum" FROM "ScanDispatchOutbox"
          WHERE id=$1 AND "operationId"=$2 AND "attemptId"=$3`,
            [String(payload.stopCommandId), binding.operationId, binding.attemptId]
          )
        ).rows[0]
        const stopping = stop
          ? readStoredDispatchCommand(
              stop.commandInputJson as string | null,
              stop.commandInputChecksum as string | null
            )
          : null
        if (!stopping || stopping.type !== "STOP") unavailable()
      }
    }
    return { row, command, prepare }
  }

  async function authorize(
    event: AuthorityEvent<Original>,
    binding: AttemptBinding
  ): Promise<boolean> {
    return connection(binding.operationId, true, async (sql) => {
      const { row, command } = await bound(sql, event, binding, true)
      if (!cleanup(event.payload.payload, command)) {
        if (row.isOpen !== true || row.closedAt !== null || row.revokedAt !== null) unavailable()
        await bindScanExecutionAuthorityContext(sql, binding.operationId)
        const current = (
          await sql.query(
            "SELECT current_setting('app.current_account_id',true) AS account,current_setting('app.current_scan_user_id',true) AS actor",
            []
          )
        ).rows[0]
        if (current?.account !== row.sponsorAccountId || current?.actor !== row.initiatingUserId)
          unavailable()
        const phase = ["SANDBOX_TOOL_START_ACK", "SANDBOX_TOOL_MUTATION_ACK"].includes(
          String(event.payload.payload.nativeOperation)
        )
          ? "SANDBOX_TOOL"
          : command.type === "PREPARE"
            ? "PREPARE"
            : "EXECUTOR_CREATE"
        const result = await sql.query(
          `SELECT checked."deadlineAt" FROM "ScanDispatchAttempt" a
          JOIN "ScanWorkerInstanceGrant" g ON g.id=a."workerInstanceGrantId"
          CROSS JOIN LATERAL app.check_scan_current_execution_authority(a."scanId",
            least(a."expiresAt",g."expiresAt",CASE WHEN $3='PREPARE' THEN a."authorityDeadlineAt" ELSE a."expiresAt" END),$3) checked
          WHERE a."operationId"=$1 AND a."workspaceId"=$2 AND a."policyDigest"=app.scan_policy_digest(a."policyId")
            AND a."scopeDigest"=app.scan_dispatch_scope_digest(a."scanId")
            AND a."targetSnapshotDigest"=app.scan_target_snapshot_digest(a."targetId")
            AND g."issuedAt"<=clock_timestamp() AT TIME ZONE 'UTC'
            AND g."expiresAt">clock_timestamp() AT TIME ZONE 'UTC'`,
          [binding.operationId, binding.workspaceId, phase]
        )
        if (result.rows.length !== 1) unavailable()
      }
      return true
    })
  }

  async function authorizeConfirmed(record: Wrapped, binding: AttemptBinding): Promise<boolean> {
    const verified = verifyJournalRecord(
      record,
      identity.wrapperSigningSecret,
      authorityEventSchema(originalSchema).parse
    )
    const original = verified.payload.payload
    const proof = verifySupervisorReceiptHmac({
      record: original,
      expectedInstanceId: identity.supervisorInstanceId,
      secret: identity.originalSigningSecret,
      expectedKeyHash: identity.originalKeyHash,
      expectedSequence: record.sequence,
      expectedPreviousHash: original.previousHash,
    })
    if (!proof.ok || verified.payload.eventId !== `supervisor:${original.hash}`) unavailable()
    const mirrored = await options.mirror.readRecordBounded(record.sequence, 128 * 1024)
    if (!mirrored || canonicalJson(mirrored) !== canonicalJson(record)) unavailable()
    return connection(binding.operationId, false, async (sql) => {
      await bound(sql, record.payload, binding)
      return true
    })
  }

  return {
    authorize,
    authorizeConfirmed,
    authorizeStream: async (input: { epochId: string; supervisorInstanceId: string }) => {
      if (
        input.epochId !== identity.authorityEpochId ||
        input.supervisorInstanceId !== identity.supervisorInstanceId
      )
        unavailable()
      return connection(undefined, false, async () => {
        await stream()
        return true
      })
    },
    authorizeRecovery: async (
      request: SupervisorRecoveryRequest,
      original: Original,
      command: SupervisorCommand,
      binding: AttemptBinding
    ) => {
      if (
        request.epochId !== identity.authorityEpochId ||
        request.supervisorInstanceId !== identity.supervisorInstanceId ||
        request.operationId !== binding.operationId ||
        request.attemptId !== binding.attemptId ||
        request.workspaceId !== binding.workspaceId ||
        request.scanId !== binding.scanId ||
        request.commandId !== command.commandId ||
        request.expectedCommandHash !== sha256Hex(canonicalJson(command))
      )
        unavailable()
      return connection(binding.operationId, true, async (sql) => {
        const event: AuthorityEvent<Original> = {
          epochId: binding.authorityEpochId,
          operationId: binding.operationId,
          attemptId: binding.attemptId,
          scanId: binding.scanId,
          workspaceId: binding.workspaceId,
          eventId: `supervisor:${original.hash}`,
          payload: original,
        }
        const stored = await bound(sql, event, binding)
        if (canonicalJson(stored.command) !== canonicalJson(command)) unavailable()
        return true
      })
    },
  }
}
