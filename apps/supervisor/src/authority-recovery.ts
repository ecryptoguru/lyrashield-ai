import {
  IndependentAuthorityError,
  canonicalJson,
  sha256Hex,
  type AttemptBinding,
  type JournalRecord,
  type SupervisorCommand,
  type SupervisorJournalRecovery,
  type SupervisorRecoveryRequest,
} from "@lyrashield/runtime-control"
import type { SupervisorJournalEvent } from "./journal-events"

type Record = JournalRecord<SupervisorJournalEvent>
export type RecoveryAuthorizer = (
  request: SupervisorRecoveryRequest,
  original: Record,
  command: SupervisorCommand,
  binding: AttemptBinding
) => Promise<boolean>

interface RecoveryContext {
  localHistory(): Promise<{ originals: Record[]; wrapped: JournalRecord<unknown>[] }>
  confirmedCount(): Promise<number>
  confirmedHistory(): Promise<JournalRecord<{ payload: Record }>[]> // wrappers retain originals
  bindingFor(record: Record, originals: Record[]): AttemptBinding
  confirmPending(record: Record, originals: Record[]): Promise<void>
  stageHold(event: SupervisorJournalEvent, originals: Record[]): Promise<Record>
  assertStreamAuthorized(): Promise<void>
  authorizeRecord(record: Record, originals: Record[]): Promise<boolean>
  authorizeRecovery: RecoveryAuthorizer
}

export function eventCommandId(event: SupervisorJournalEvent): string | null {
  return event.type === "command_intent"
    ? event.command.commandId
    : "commandId" in event
      ? (event.commandId ?? null)
      : null
}

/** A selector/preflight rejection guarantees that recovery has not mutated any journal. */
export class RecoverySelectionError extends IndependentAuthorityError {
  constructor(
    message: string,
    readonly confirmedHistory = false
  ) {
    super("RECOVERY_CONFLICT", message)
  }
}

function rejected(message: string, confirmedHistory = false): never {
  throw new RecoverySelectionError(message, confirmedHistory)
}

function originFor(hold: Record, originals: Record[], commandId: string): Record {
  const event = hold.payload
  if (event.type !== "command_recovery_hold") return hold
  const original = originals[event.recoveredSequence - 1]
  if (
    !original ||
    original.sequence + 1 !== hold.sequence ||
    hold.previousHash !== original.hash ||
    event.commandId !== commandId ||
    !validRecoveryHold(event, original, originals)
  ) {
    rejected("recovery hold does not bind an original command record")
  }
  return original
}

/** The sole permitted two-record local suffix: original followed by its UNKNOWN guard. */
export function validRecoveryHold(
  event: SupervisorJournalEvent,
  original: Record | undefined,
  originals: Record[]
): boolean {
  if (!original || event.type !== "command_recovery_hold") return false
  const intents = originals.filter(
    (record) =>
      record.payload.type === "command_intent" &&
      record.payload.command.commandId === event.commandId
  )
  if (intents.length !== 1 || intents[0]!.payload.type !== "command_intent") return false
  const command = intents[0]!.payload.command
  return (
    original.payload.type !== "command_recovery_hold" &&
    eventCommandId(original.payload) === event.commandId &&
    event.recoveredSequence === original.sequence &&
    event.recoveredHash === original.hash &&
    event.supervisorInstanceId === original.payload.supervisorInstanceId &&
    event.observedAt === original.payload.observedAt &&
    event.attemptId ===
      (command.type === "PREPARE" ? command.attempt.attemptId : command.attemptId) &&
    event.expectedCommandHash === sha256Hex(canonicalJson(command))
  )
}

export function validRecoverySuffix(originals: Record[]): boolean {
  const hold = originals.at(-1)
  const original = originals.at(-2)
  return (
    !!hold &&
    !!original &&
    hold.sequence === original.sequence + 1 &&
    hold.previousHash === original.hash &&
    validRecoveryHold(hold.payload, original, originals)
  )
}

/** Read-only proof before a selector rejection may preserve prior service initialization. */
async function recoveryPosition(ctx: RecoveryContext, originals: Record[], wrappedCount: number) {
  let pending: Record | undefined
  let pendingStart: number
  try {
    pendingStart = await ctx.confirmedCount()
    if (originals.length > pendingStart) pending = originals.at(-1)
  } catch (error) {
    if (!(error instanceof IndependentAuthorityError) || error.code !== "REPLAY_REQUIRED")
      throw error
    pending = originals.at(-1)
    pendingStart = wrappedCount - 1
    if (pendingStart < 0) rejected("pending independent event has no local wrapper")
  }
  let confirmedHistory = false
  if (!pending) {
    // Prove unchanged original/wrapper/R2/database histories and current stream
    // authority before a no-mutation rejection can preserve service startup.
    await ctx.confirmedHistory()
    confirmedHistory = true
  }
  return { pending, pendingStart, confirmedHistory }
}

/** Explicit durability repair and a durable UNKNOWN hold; never execution/revocation. */
export async function recoverSignedEvent(
  ctx: RecoveryContext,
  request: SupervisorRecoveryRequest
): Promise<SupervisorJournalRecovery<SupervisorJournalEvent>> {
  await ctx.assertStreamAuthorized()
  const { originals, wrapped } = await ctx.localHistory()
  const { pending, pendingStart, confirmedHistory } = await recoveryPosition(
    ctx,
    originals,
    wrapped.length
  )
  const intents = originals.filter(
    (record) =>
      record.payload.type === "command_intent" &&
      record.payload.command.commandId === request.commandId
  )
  if (intents.length !== 1)
    rejected("recovery requires one original command identity", confirmedHistory)
  const intent = intents[0]!
  if (intent.payload.type !== "command_intent")
    rejected("original command is unavailable", confirmedHistory)
  const command = intent.payload.command
  const binding = ctx.bindingFor(intent, originals)
  if (
    canonicalJson({
      epochId: binding.authorityEpochId,
      supervisorInstanceId: intent.payload.supervisorInstanceId,
      workspaceId: binding.workspaceId,
      scanId: binding.scanId,
      operationId: binding.operationId,
      attemptId: binding.attemptId,
      commandId: command.commandId,
      expectedCommandHash: sha256Hex(canonicalJson(command)),
    }) !== canonicalJson(request)
  ) {
    rejected("recovery selector differs from the original authenticated command", confirmedHistory)
  }
  if (pending && eventCommandId(pending.payload) !== request.commandId) {
    rejected("pending event has another or an unbound command identity", confirmedHistory)
  }
  const reverse = [...originals].reverse()
  const existing = reverse.find(
    (record) =>
      record.payload.type === "command_recovery_hold" &&
      record.payload.commandId === request.commandId &&
      record.payload.expectedCommandHash === request.expectedCommandHash
  )
  const selected =
    pending ?? reverse.find((record) => eventCommandId(record.payload) === request.commandId)
  if (!selected) rejected("original recovery event is unavailable", confirmedHistory)
  const recoveredRecord = originFor(selected, originals, request.commandId)
  if (canonicalJson(ctx.bindingFor(recoveredRecord, originals)) !== canonicalJson(binding))
    rejected("original recovery event belongs to another attempt authority", confirmedHistory)
  let holdRecord =
    existing && originFor(existing, originals, request.commandId).hash === recoveredRecord.hash
      ? existing
      : undefined
  if (!holdRecord && recoveredRecord.hash !== originals.at(-1)!.hash)
    rejected(
      "recovery requires the current original tail or its existing linked hold",
      confirmedHistory
    )
  const authorize = async () => {
    await ctx.assertStreamAuthorized()
    if (
      !(await ctx.authorizeRecord(recoveredRecord, originals)) ||
      !(await ctx.authorizeRecovery(request, recoveredRecord, command, binding))
    ) {
      throw new IndependentAuthorityError(
        "AUTHORITY_CONFLICT",
        "persisted recovery authority is revoked or mismatched"
      )
    }
  }
  await authorize()
  if (!holdRecord) {
    // Write the local UNKNOWN guard before confirming any original remotely.
    // Interrupted recovery therefore cannot expose a confirmed positive disposition
    // without a pending guard that keeps ordinary startup/readback closed.
    holdRecord = await ctx.stageHold(
      {
        type: "command_recovery_hold",
        supervisorInstanceId: recoveredRecord.payload.supervisorInstanceId,
        // Stable on replay; no original field or signature is regenerated.
        observedAt: recoveredRecord.payload.observedAt,
        commandId: request.commandId,
        attemptId: request.attemptId,
        expectedCommandHash: request.expectedCommandHash,
        recoveredSequence: recoveredRecord.sequence,
        recoveredHash: recoveredRecord.hash,
      },
      originals
    )
  }
  const history = holdRecord.sequence > originals.length ? [...originals, holdRecord] : originals
  for (const record of history.slice(pendingStart)) {
    await ctx.confirmPending(record, history)
    await authorize()
  }
  const confirmed = await ctx.confirmedHistory()
  await authorize()
  return structuredClone({
    request,
    recoveredRecord,
    holdRecord,
    records: confirmed.map((record) => record.payload.payload),
  })
}
