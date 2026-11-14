import { createId } from "@paralleldrive/cuid2"
import type pg from "pg"
import {
  canonicalJson,
  commandStatusSchema,
  resourceOwnershipSchema,
  verifyJournalRecord,
} from "@lyrashield/runtime-control"
import { z } from "zod"
import { bindScanPreparationContext } from "./scan-preparation-authority"
import { readStoredDispatchCommand } from "./scan-dispatch-command-descriptor"
import type { DispatchBrokerContext } from "./scan-dispatch-authority-broker-methods"
import { applyAuthenticatedPreparation } from "./scan-supervisor-preparation-projection"
import { applyAuthenticatedStart } from "./scan-supervisor-start-projection"
import { applyAuthenticatedCleanup } from "./scan-supervisor-cleanup-projection"
import { resolveNativeInvocationReceipt } from "./scan-supervisor-native-invocation-resolution"
import { resolveNativeRetirementReceipt } from "./scan-native-retirement"
import { sha256Hex, verifySupervisorReceiptHmac } from "./scan-supervisor-receipt-verifier"
import {
  receiptFailure,
  type SupervisorReceiptAuthority,
} from "./scan-supervisor-receipt-ingestion-verifier"

type Source = {
  id: string
  sequence: string
  originalInputJson: string
  wrapperInputJson: string
}
type Command = {
  id: string
  attemptId: string
  commandType: string
  status: string
  commandInputJson: string | null
  commandInputChecksum: string | null
}
export type SupervisorReceiptCleanupScope = { attemptId: string; commandIds: readonly string[] }
const operationSchema = z
  .string()
  .min(3)
  .max(192)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)

function eventCommand(event: Record<string, unknown>): string | null {
  if (event.type === "command_intent")
    return z.object({ commandId: z.string() }).parse(event.command).commandId
  return typeof event.commandId === "string" ? event.commandId : null
}

function receiptType(event: Record<string, unknown>, terminal: string | null) {
  if (event.type === "command_intent") return "COMMAND_ACCEPTED"
  if (event.type === "prepare_invocation_completed") return "PREPARE_COMPLETED"
  if (event.type === "native_invocation_ack") return "EXECUTOR_CREATE_INTENT"
  if (event.type === "resource_bound") return "EXECUTOR_CREATED"
  if (event.type === "resource_started") return "EXECUTOR_STARTED"
  if (
    ["resource_create_planned", "resource_create_acknowledged", "resource_start_planned"].includes(
      String(event.type)
    )
  )
    return "EXECUTOR_CREATE_INTENT"
  if (event.type === "attempt_prepared" || terminal === "PREPARED") return "PREPARE_COMPLETED"
  if (terminal === "STARTED") return "EXECUTOR_STARTED"
  if (terminal === "STOPPED") return "STOPPED"
  if (terminal === "NEVER_DISPATCHED") return "NEVER_DISPATCHED"
  return "UNKNOWN"
}

async function projectReceipt(
  client: pg.PoolClient,
  authority: SupervisorReceiptAuthority,
  operationId: string,
  command: Command,
  source: Source,
  event: Record<string, unknown>,
  original: ReturnType<typeof verifyJournalRecord>,
  terminal: string | null
) {
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM "ScanSupervisorReceipt" WHERE "journalRecordId"=$1 AND "operationId"=$2 AND "attemptId"=$3`,
    [source.id, operationId, command.attemptId]
  )
  if (existing.rows[0]) return existing.rows[0].id
  const counter = await client.query<{ projectionSequence: number; projectionHash: string | null }>(
    `SELECT "projectionSequence","projectionHash" FROM "ScanSupervisorJournalStream" WHERE id=$1 FOR UPDATE`,
    [authority.streamId]
  )
  if (!counter.rows[0]) receiptFailure("SUPERVISOR_STREAM_NOT_INSTALLED")
  const id = createId()
  await client.query(
    `INSERT INTO "ScanSupervisorReceipt"(id,"supervisorInstanceId","operationId","attemptId",
    "authorityEpochId","commandId",sequence,"previousReceiptHash","receiptHash",signature,"receiptType",
    "executorKey",outcome,"evidenceDigest","observedAt","journalRecordId","eventType","terminalStatus")
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::"ScanSupervisorReceiptType",$12,$13,$14,$15::timestamptz AT TIME ZONE 'UTC',$16,$17,$18)`,
    [
      id,
      authority.supervisorInstanceId,
      operationId,
      command.attemptId,
      authority.authorityEpochId,
      command.id,
      counter.rows[0].projectionSequence + 1,
      counter.rows[0].projectionHash,
      original.hash,
      original.signature,
      receiptType(event, terminal),
      typeof event.executorKey === "string" ? event.executorKey : null,
      terminal,
      sha256Hex(source.wrapperInputJson),
      event.observedAt,
      source.id,
      event.type,
      terminal,
    ]
  )
  return id
}

async function quarantine(
  client: pg.PoolClient,
  operationId: string,
  command: Command,
  receiptId: string
) {
  const physical = await client.query<{ state: string; revision: number }>(
    `SELECT state,revision FROM "ScanPhysicalExecution" WHERE "operationId"=$1 AND "attemptId"=$2 FOR UPDATE`,
    [operationId, command.attemptId]
  )
  const state = physical.rows[0]
  if (!state || ["STOPPED", "NEVER_DISPATCHED"].includes(state.state))
    receiptFailure("SUPERVISOR_TERMINAL_QUARANTINE_CONFLICT")
  if (state.state !== "UNKNOWN")
    await client.query(
      `INSERT INTO "ScanPhysicalExecutionTransition"(id,"attemptId","operationId",revision,
      "fromState","toState","supervisorReceiptId") VALUES($1,$2,$3,$4,$5::"ScanPhysicalExecutionState",'UNKNOWN',$6)`,
      [createId(), command.attemptId, operationId, state.revision + 1, state.state, receiptId]
    )
  if (command.status !== "UNKNOWN")
    await client.query(
      `UPDATE "ScanDispatchOutbox" SET status='UNKNOWN',"updatedAt"=CURRENT_TIMESTAMP
      WHERE id=$1 AND "operationId"=$2 AND "attemptId"=$3`,
      [command.id, operationId, command.attemptId]
    )
  await client.query(
    `UPDATE "ScanDispatchOperation" SET state='UNKNOWN',"updatedAt"=CURRENT_TIMESTAMP WHERE "operationId"=$1`,
    [operationId]
  )
}

function authenticateSource(
  source: Source,
  authority: SupervisorReceiptAuthority,
  operation: { operationId: string; scanId: string; workspaceId: string }
) {
  const operationId = operation.operationId
  const wrapper = verifyJournalRecord(
    JSON.parse(source.wrapperInputJson),
    authority.wrapperSigningSecret,
    (value) =>
      z
        .object({
          epochId: z.string(),
          operationId: z.string(),
          scanId: z.string(),
          workspaceId: z.string(),
          attemptId: z.string(),
          eventId: z.string(),
          payload: z.unknown(),
        })
        .strict()
        .parse(value)
  )
  const original = verifyJournalRecord(
    JSON.parse(source.originalInputJson),
    authority.originalSigningSecret,
    (value) => z.record(z.string(), z.unknown()).parse(value)
  )
  const verified = verifySupervisorReceiptHmac({
    record: original,
    expectedInstanceId: authority.supervisorInstanceId,
    secret: authority.originalSigningSecret,
    expectedKeyHash: authority.originalKeyHash,
  })
  if (
    !verified.ok ||
    canonicalJson(wrapper.payload.payload) !== source.originalInputJson ||
    wrapper.payload.epochId !== authority.authorityEpochId ||
    wrapper.payload.operationId !== operationId ||
    wrapper.payload.scanId !== operation.scanId ||
    wrapper.payload.workspaceId !== operation.workspaceId
  )
    receiptFailure("SUPERVISOR_RETAINED_RECORD_CONFLICT")
  return { wrapper, original }
}

async function* scopedSources(
  client: pg.PoolClient,
  authority: SupervisorReceiptAuthority,
  operation: { operationId: string; workspaceId: string },
  confirmedSequence: number
) {
  let afterSequence = 0
  for (;;) {
    const rows = await client.query<Source>(
      `SELECT id,sequence::text,"originalInputJson","wrapperInputJson"
      FROM "ScanSupervisorJournalRecord" WHERE "streamId"=$1 AND "operationId"=$2 AND "workspaceId"=$3
        AND sequence>$4 AND sequence<=$5 ORDER BY "ScanSupervisorJournalRecord".sequence LIMIT 100`,
      [
        authority.streamId,
        operation.operationId,
        operation.workspaceId,
        afterSequence,
        confirmedSequence,
      ]
    )
    for (const source of rows.rows) {
      afterSequence = Number(source.sequence)
      yield source
    }
    if (rows.rows.length < 100) return
  }
}

async function verifyRecoveryHold(
  client: pg.PoolClient,
  authority: SupervisorReceiptAuthority,
  operation: { operationId: string; workspaceId: string },
  command: Command,
  source: Source,
  event: Record<string, unknown>
) {
  if (
    event.expectedCommandHash !== command.commandInputChecksum ||
    !Number.isSafeInteger(event.recoveredSequence) ||
    Number(event.recoveredSequence) >= Number(source.sequence)
  )
    receiptFailure("SUPERVISOR_RECOVERY_HOLD_MISMATCH")
  const recovered = (
    await client.query<Source>(
      `SELECT id,sequence::text,"originalInputJson","wrapperInputJson" FROM "ScanSupervisorJournalRecord"
      WHERE "streamId"=$1 AND "operationId"=$2 AND "workspaceId"=$3 AND sequence=$4`,
      [authority.streamId, operation.operationId, operation.workspaceId, event.recoveredSequence]
    )
  ).rows[0]
  if (!recovered) receiptFailure("SUPERVISOR_RECOVERY_HOLD_MISMATCH")
  const recoveredOriginal = JSON.parse(recovered.originalInputJson)
  if (
    recoveredOriginal.hash !== event.recoveredHash ||
    eventCommand(recoveredOriginal.payload) !== command.id
  )
    receiptFailure("SUPERVISOR_RECOVERY_HOLD_MISMATCH")
}

export async function projectSupervisorSnapshot(
  client: pg.PoolClient,
  authority: SupervisorReceiptAuthority,
  input: unknown,
  confirmedSequence: number,
  lockOperation: DispatchBrokerContext["lockOperation"],
  retainedCleanup?: SupervisorReceiptCleanupScope
) {
  const operationId = operationSchema.parse(input)
  await bindScanPreparationContext(client, operationId)
  const operation = await lockOperation(client, {
    operationId,
    authorityEpochId: authority.authorityEpochId,
  })
  const head = await client.query<{ confirmedSequence: string }>(
    `SELECT "confirmedSequence"::text FROM "ScanSupervisorJournalStream" WHERE id=$1 FOR UPDATE`,
    [authority.streamId]
  )
  if (Number(head.rows[0]?.confirmedSequence) !== confirmedSequence)
    receiptFailure("SUPERVISOR_SNAPSHOT_CHANGED")
  const commands = await client.query<Command>(
    `SELECT c.id,c."attemptId",c."commandType",c.status,c."commandInputJson",c."commandInputChecksum"
    FROM "ScanDispatchOutbox" c JOIN "ScanDispatchAttempt" a ON a."attemptId"=c."attemptId" AND a."operationId"=c."operationId"
    WHERE c."operationId"=$1 AND a."workspaceId"=$2 AND a."scanId"=$3 AND a."authorityEpochId"=$4 FOR UPDATE OF c`,
    [operationId, operation.workspaceId, operation.scanId, authority.authorityEpochId]
  )
  const current = new Map(commands.rows.map((command) => [command.id, command]))
  const seen = new Set<string>()
  const final = new Map<string, { command: Command; status: string; receiptId: string }>()
  let sourceCount = 0
  for await (const source of scopedSources(client, authority, operation, confirmedSequence)) {
    sourceCount++
    const { wrapper, original } = authenticateSource(source, authority, operation)
    const event = original.payload
    const commandId = eventCommand(event)
    if (!commandId) continue
    const command = current.get(commandId)
    if (!command || command.attemptId !== wrapper.payload.attemptId)
      receiptFailure("SUPERVISOR_COMMAND_IDENTITY_MISMATCH")
    const approved = readStoredDispatchCommand(
      command.commandInputJson,
      command.commandInputChecksum
    )
    if (!approved || approved.commandId !== command.id || approved.type !== command.commandType)
      receiptFailure("SUPERVISOR_COMMAND_AUTHORITY_UNAVAILABLE")
    if (
      (typeof event.attemptId === "string" && event.attemptId !== command.attemptId) ||
      (approved.type === "PREPARE"
        ? approved.attempt.attemptId !== command.attemptId ||
          approved.attempt.operationId !== operationId ||
          approved.attempt.workspaceId !== operation.workspaceId ||
          approved.attempt.scanId !== operation.scanId ||
          approved.attempt.authorityEpochId !== authority.authorityEpochId
        : approved.attemptId !== command.attemptId)
    )
      receiptFailure("SUPERVISOR_COMMAND_IDENTITY_MISMATCH")
    if (event.type === "command_intent") {
      if (canonicalJson(event.command) !== command.commandInputJson)
        receiptFailure("SUPERVISOR_COMMAND_IDENTITY_MISMATCH")
      seen.add(command.id)
    } else if (!seen.has(command.id)) receiptFailure("SUPERVISOR_COMMAND_INTENT_UNAVAILABLE")
    if (retainedCleanup) {
      if (command.attemptId !== retainedCleanup.attemptId) continue
      const cleanupCommand =
        ["STOP", "RECONCILE"].includes(approved.type) &&
        retainedCleanup.commandIds.includes(command.id)
      const retirement =
        event.type === "native_invocation_retired" &&
        typeof event.stopCommandId === "string" &&
        retainedCleanup.commandIds.includes(event.stopCommandId) &&
        current.get(event.stopCommandId)?.commandType === "STOP" &&
        current.get(event.stopCommandId)?.attemptId === retainedCleanup.attemptId
      // Signed acceptance is inert observation. Retained credentials cannot project
      // PREPARE completion, native CREATE/START acknowledgements or START success.
      if (!cleanupCommand && !retirement && event.type !== "command_intent") continue
      if (
        cleanupCommand &&
        !["command_intent", "command_terminal", "command_recovery_hold"].includes(
          String(event.type)
        )
      )
        continue
    }
    if (event.type === "command_recovery_hold")
      await verifyRecoveryHold(client, authority, operation, command, source, event)
    if (
      event.type === "attempt_prepared" &&
      (approved.type !== "PREPARE" ||
        canonicalJson(event.binding) !== canonicalJson(approved.attempt) ||
        canonicalJson(event.executors) !== canonicalJson(approved.executors) ||
        canonicalJson(event.provider ?? null) !== canonicalJson(approved.provider ?? null))
    )
      receiptFailure("SUPERVISOR_PREPARATION_RECEIPT_MISMATCH")
    if (["resource_bound", "resource_started"].includes(String(event.type))) {
      const ownership = resourceOwnershipSchema.parse(event.ownership)
      if (
        !["START_PAID", "START_UNMETERED"].includes(approved.type) ||
        !("executorKey" in approved) ||
        ownership.executorKey !== approved.executorKey ||
        ownership.ownershipId !==
          `own_${sha256Hex(`${command.attemptId}\0${command.id}\0${ownership.executorKey}`).slice(0, 40)}` ||
        ownership.kind !== "container" ||
        !/^[a-f0-9]{64}$/.test(ownership.containerId ?? "")
      )
        receiptFailure("SUPERVISOR_NATIVE_OWNERSHIP_MISMATCH")
    }
    if (
      ![
        "command_intent",
        "attempt_prepared",
        "command_terminal",
        "command_recovery_hold",
        "resource_create_planned",
        "resource_create_acknowledged",
        "resource_start_planned",
        "prepare_invocation_completed",
        "native_invocation_ack",
        "native_invocation_planned",
        "native_invocation_retired",
        "resource_bound",
        "resource_started",
      ].includes(String(event.type))
    )
      continue
    const terminal =
      event.type === "command_recovery_hold"
        ? "UNKNOWN"
        : event.type === "command_terminal"
          ? commandStatusSchema.parse(event.status)
          : null
    const receiptId = await projectReceipt(
      client,
      authority,
      operationId,
      command,
      source,
      event,
      original,
      terminal
    )
    if (["native_invocation_ack", "prepare_invocation_completed"].includes(String(event.type)))
      await resolveNativeInvocationReceipt(client, event, receiptId, command.commandInputChecksum!)
    if (event.type === "native_invocation_retired")
      await resolveNativeRetirementReceipt(client, event, receiptId, command.commandInputChecksum!)
    // Uncertainty remains held until a separate authenticated reconciliation
    // path proves it resolved. A later positive command terminal is history,
    // not permission to erase the command's previously observed hold.
    const disposition = event.type === "attempt_prepared" ? "PREPARED" : terminal
    if (disposition && (disposition === "UNKNOWN" || final.get(command.id)?.status !== "UNKNOWN"))
      final.set(command.id, { command, status: disposition, receiptId })
  }
  for (const outcome of final.values())
    if (outcome.status === "UNKNOWN")
      await quarantine(client, operationId, outcome.command, outcome.receiptId)
  const preparations = new Set<string>()
  for (const outcome of final.values())
    if (
      outcome.status === "PREPARED" &&
      (await applyAuthenticatedPreparation(client, operationId, outcome.command, outcome.receiptId))
    )
      preparations.add(outcome.command.id)
  const starts = new Set<string>()
  for (const outcome of final.values())
    if (
      outcome.status === "STARTED" &&
      (await applyAuthenticatedStart(client, operationId, outcome.command, outcome.receiptId))
    )
      starts.add(outcome.command.id)
  const cleanups = new Set<string>()
  for (const outcome of final.values())
    if (
      await applyAuthenticatedCleanup(
        client,
        operationId,
        outcome.command,
        outcome.receiptId,
        outcome.status
      )
    )
      cleanups.add(outcome.command.id)
  return {
    operationId,
    confirmedSequence,
    receipts: sourceCount,
    dispositions: [...final.values()].map(({ command, status }) => ({
      commandId: command.id,
      status:
        status === "UNKNOWN"
          ? "UNKNOWN"
          : preparations.has(command.id)
            ? "PREPARED"
            : starts.has(command.id)
              ? "STARTED"
              : cleanups.has(command.id)
                ? status
                : "HELD",
      observedStatus: status,
    })),
  }
}
