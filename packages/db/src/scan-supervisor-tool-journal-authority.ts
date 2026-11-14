import type pg from "pg"
import {
  authorityActionSchema,
  authorityEventSchema,
  canonicalJson,
  sha256Hex,
  supervisorCommandSchema,
  verifyJournalRecord,
  type AuthorityEvent,
  type AuthoritySqlConnection,
  type JournalRecord,
  type PostgresAuthorityMirror,
  type SandboxToolExecDescriptor,
  type ScanAuthorityContext,
} from "@lyrashield/runtime-control"
import { z } from "zod"
import {
  parseStoredSandboxToolIntent,
  verifyStoredSandboxToolIntent,
} from "./scan-sandbox-tool-intent"
import type { SupervisorReceiptAuthority } from "./scan-supervisor-receipt-ingestion-verifier"

interface ToolEvent {
  type: string
  supervisorInstanceId: string
  binding: {
    authorityEpochId: string
    operationId: string
    attemptId: string
    workspaceId: string
    scanId: string
  }
  tool: {
    requestId: string
    kind: string
    commandId: string
    prepareCommandId: string
    invocationGuardId: string
    actionChecksum: string
    handleChecksum: string
    containerId: string
    bindingInputJson?: string
    maxOutputBytes?: number
    timeoutSeconds?: number
    execId?: string
    responseChecksum?: string
    objectDigest?: string
    nativeMutationId?: string
    nativeReceiptSha256?: string
    nativeTargets?: unknown[]
  }
}
function unavailable(): never {
  throw new Error("Protected tool journal authority is unavailable")
}
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b)

/** Native metadata authenticates immutable facts; only the checked fence permits a new tool effect. */
export function createScanSupervisorToolJournalAuthority<T extends ToolEvent>(options: {
  pool: pg.Pool
  context: ScanAuthorityContext
  controller: SupervisorReceiptAuthority
  identity: {
    streamId: string
    authorityEpochId: string
    supervisorInstanceId: string
    originalSigningSecret: string
    originalKeyHash: string
    wrapperSigningSecret: string
    wrapperKeyHash: string
  }
  mirror: PostgresAuthorityMirror
  parseEvent: (value: unknown) => T
  readControllerHistory: () => Promise<JournalRecord<unknown>[]>
  verifyRetainedResponse: (event: T, descriptor: SandboxToolExecDescriptor) => Promise<void>
}) {
  const identity = options.identity
  const streamMatches = () =>
    options.mirror.verifySupervisorStreamBinding(
      identity.streamId,
      identity.originalKeyHash,
      identity.wrapperKeyHash
    )
  async function validate(event: T, live: boolean) {
    if (Buffer.byteLength(canonicalJson(event)) > 32 * 1024) unavailable()
    const terminal = ["tool_response", "tool_ack"].includes(event.type)
    if (
      event.supervisorInstanceId !== identity.supervisorInstanceId ||
      event.binding.authorityEpochId !== identity.authorityEpochId ||
      !event.tool.bindingInputJson
    )
      unavailable()
    const action = authorityActionSchema.parse(JSON.parse(event.tool.bindingInputJson))
    if (
      canonicalJson(action) !== event.tool.bindingInputJson ||
      action.phase !== "SANDBOX_TOOL" ||
      action.executorKey !== "sandbox" ||
      action.operationId !== event.binding.operationId ||
      action.attemptId !== event.binding.attemptId ||
      action.workspaceId !== event.binding.workspaceId ||
      action.scanId !== event.binding.scanId ||
      action.authorityEpochId !== event.binding.authorityEpochId ||
      action.requestId !== event.tool.requestId ||
      action.commandId !== event.tool.prepareCommandId ||
      action.actionChecksum !== event.tool.actionChecksum
    )
      unavailable()
    // Read authenticated controller history before checking out another SQL client:
    // current native effects already retain one checked connection in this pool.
    const originals = (await options.readControllerHistory()).map((record) =>
      verifyJournalRecord(record, options.controller.originalSigningSecret, z.unknown().parse)
    )
    const controllerEvents = originals.map((record) =>
      z
        .object({ type: z.string(), supervisorInstanceId: z.string() })
        .passthrough()
        .parse(record.payload)
    )
    if (
      event.type === "tool_mutated" &&
      !controllerEvents.some(
        (payload) =>
          payload.type === "native_invocation_ack" &&
          payload.nativeOperation === "SANDBOX_TOOL_MUTATION_ACK" &&
          payload.supervisorInstanceId === options.controller.supervisorInstanceId &&
          payload.attemptId === action.attemptId &&
          payload.guardId === event.tool.invocationGuardId &&
          payload.requestId === event.tool.requestId &&
          payload.nativeMutationId === event.tool.nativeMutationId &&
          payload.nativeReceiptSha256 === event.tool.nativeReceiptSha256 &&
          same(payload.nativeTargets, event.tool.nativeTargets)
      )
    )
      unavailable()
    const preparation = controllerEvents.find(
      (payload) =>
        payload.type === "command_intent" &&
        typeof payload.command === "object" &&
        payload.command !== null &&
        Reflect.get(payload.command, "commandId") === event.tool.prepareCommandId
    )
    if (
      !preparation ||
      preparation.supervisorInstanceId !== options.controller.supervisorInstanceId
    )
      unavailable()
    const prepare = supervisorCommandSchema.parse(preparation.command)
    if (
      prepare.type !== "PREPARE" ||
      prepare.attempt.operationId !== action.operationId ||
      prepare.attempt.attemptId !== action.attemptId ||
      prepare.attempt.workspaceId !== action.workspaceId ||
      prepare.attempt.scanId !== action.scanId ||
      prepare.attempt.authorityEpochId !== action.authorityEpochId ||
      prepare.attempt.authorityRevision !== action.authorityRevision
    )
      unavailable()
    const preparedAuthority = {
      attempt: prepare.attempt,
      executors: prepare.executors,
      provider: prepare.provider ?? null,
    }
    if (sha256Hex(canonicalJson(preparedAuthority)) !== action.authorityChecksum) unavailable()
    const active = options.context.current()
    if (
      live &&
      !terminal &&
      (!active || active.guardId !== event.tool.invocationGuardId || !same(active.binding, action))
    )
      unavailable()
    const borrowed =
      active?.binding.operationId === action.operationId ? active.connection : undefined
    const connection: AuthoritySqlConnection = borrowed ?? (await options.pool.connect())
    let failed = true
    let descriptor: SandboxToolExecDescriptor
    try {
      await connection.query("BEGIN ISOLATION LEVEL READ COMMITTED", [])
      await connection.query("SET LOCAL statement_timeout='5s'", [])
      await connection.query("SET LOCAL idle_in_transaction_session_timeout='10s'", [])
      await connection.query("SELECT app.require_scan_execution_action_role()", [])
      await connection.query("SELECT set_config('app.current_workspace_id',$1,true)", [
        action.workspaceId,
      ])
      const attempt = (
        await connection.query(
          `SELECT "sponsorAccountId","initiatingUserId" FROM "ScanDispatchAttempt"
        WHERE "operationId"=$1 AND "attemptId"=$2 AND "workspaceId"=$3 AND "scanId"=$4 AND "authorityEpochId"=$5`,
          [
            action.operationId,
            action.attemptId,
            action.workspaceId,
            action.scanId,
            action.authorityEpochId,
          ]
        )
      ).rows[0]
      if (
        !attempt ||
        typeof attempt.sponsorAccountId !== "string" ||
        typeof attempt.initiatingUserId !== "string"
      )
        unavailable()
      await connection.query(
        "SELECT set_config('app.current_account_id',$1,true),set_config('app.current_user_id',$2,true)",
        [attempt.sponsorAccountId, attempt.initiatingUserId]
      )
      const guard = (
        await connection.query(
          `SELECT "bindingInputJson","authorityChecksum","actionChecksum" FROM "ScanExecutionInvocationGuard"
        WHERE id=$1 AND "operationId"=$2 AND "attemptId"=$3 AND "workspaceId"=$4 AND "authorityEpochId"=$5 AND phase='SANDBOX_TOOL'`,
          [
            event.tool.invocationGuardId,
            action.operationId,
            action.attemptId,
            action.workspaceId,
            action.authorityEpochId,
          ]
        )
      ).rows[0]
      if (
        !guard ||
        guard.bindingInputJson !== event.tool.bindingInputJson ||
        guard.authorityChecksum !== action.authorityChecksum ||
        guard.actionChecksum !== action.actionChecksum
      )
        unavailable()
      const intent = (
        await connection.query(
          `SELECT "actionInputJson","authorityInputJson","ownershipReceiptId" FROM "ScanExecutionActionIntent"
        WHERE "operationId"=$1 AND "attemptId"=$2 AND "workspaceId"=$3 AND "authorityEpochId"=$4 AND phase='SANDBOX_TOOL'
          AND "requestId"=$5 AND "actionChecksum"=$6 AND "authorityChecksum"=$7`,
          [
            action.operationId,
            action.attemptId,
            action.workspaceId,
            action.authorityEpochId,
            event.tool.requestId,
            action.actionChecksum,
            action.authorityChecksum,
          ]
        )
      ).rows[0]
      if (
        !intent ||
        typeof intent.actionInputJson !== "string" ||
        intent.authorityInputJson !== canonicalJson(preparedAuthority) ||
        typeof intent.ownershipReceiptId !== "string"
      )
        unavailable()
      descriptor = parseStoredSandboxToolIntent({
        actionInputJson: intent.actionInputJson,
        actionChecksum: action.actionChecksum,
      })
      const request = descriptor.request
      if (
        request.commandId !== event.tool.commandId ||
        request.requestId !== event.tool.requestId ||
        (descriptor.resultKind ?? "exec") !== event.tool.kind ||
        request.binding.sandboxHandle !== descriptor.ownership.ownershipId ||
        sha256Hex(canonicalJson(request.binding.sandboxHandle)) !== event.tool.handleChecksum ||
        descriptor.ownership.containerId !== event.tool.containerId ||
        request.maxOutputBytes !== event.tool.maxOutputBytes ||
        request.timeoutSeconds !== event.tool.timeoutSeconds ||
        !controllerEvents.some(
          (payload) =>
            payload.type === "resource_started" &&
            payload.supervisorInstanceId === options.controller.supervisorInstanceId &&
            payload.attemptId === action.attemptId &&
            payload.executorKey === "sandbox" &&
            same(payload.ownership, descriptor.ownership)
        )
      )
        unavailable()
      if (live && !terminal) {
        const held = (await connection.query("SELECT app.scan_preparation_gate_held() AS held", []))
          .rows[0]
        if (held?.held !== true) unavailable()
        await verifyStoredSandboxToolIntent(connection, action, options.controller)
        active!.assertActive()
      }
      await connection.query("ROLLBACK", [])
      failed = false
    } finally {
      if (failed) {
        try {
          await connection.query("ROLLBACK", [])
        } catch {
          /* discard below */
        }
      }
      if (!borrowed) connection.release(failed)
    }
    if (terminal) await options.verifyRetainedResponse(event, descriptor!)
    return true
  }
  async function original(value: unknown) {
    return verifyJournalRecord(value, identity.originalSigningSecret, options.parseEvent)
  }
  return {
    authorizeStream: streamMatches,
    authorizeAppend: async (value: unknown) => {
      if (!(await streamMatches())) unavailable()
      return validate(options.parseEvent(value), true)
    },
    authorize: async (event: AuthorityEvent<JournalRecord<T>>) => {
      if (!(await streamMatches())) unavailable()
      const record = await original(event.payload)
      if (
        event.epochId !== identity.authorityEpochId ||
        event.eventId !== `supervisor:${record.hash}` ||
        event.operationId !== record.payload.binding.operationId ||
        event.attemptId !== record.payload.binding.attemptId ||
        event.workspaceId !== record.payload.binding.workspaceId ||
        event.scanId !== record.payload.binding.scanId
      )
        unavailable()
      return validate(record.payload, true)
    },
    authorizeConfirmed: async (record: JournalRecord<AuthorityEvent<JournalRecord<T>>>) => {
      if (!(await streamMatches())) unavailable()
      const verified = verifyJournalRecord(
        record,
        identity.wrapperSigningSecret,
        authorityEventSchema(z.unknown()).parse
      )
      const mirrored = await options.mirror.readRecord(record.sequence)
      if (!same(verified, mirrored)) unavailable()
      const signed = await original(verified.payload.payload)
      if (
        verified.payload.epochId !== identity.authorityEpochId ||
        verified.payload.eventId !== `supervisor:${signed.hash}` ||
        verified.payload.operationId !== signed.payload.binding.operationId ||
        verified.payload.attemptId !== signed.payload.binding.attemptId ||
        verified.payload.workspaceId !== signed.payload.binding.workspaceId ||
        verified.payload.scanId !== signed.payload.binding.scanId
      )
        unavailable()
      return validate(signed.payload, false)
    },
  }
}
