import {
  canonicalJson,
  sha256Hex,
  supervisorCommandSchema,
  type AuthorityEvent,
  type JournalRecord,
  type SupervisorCommand,
  type VerifiedJournalContinuation,
} from "@lyrashield/runtime-control"
import type { SupervisorJournalEvent } from "./journal-events"
import { commandAttemptId } from "./service-common"

/** Positive result of the protected database reader; absence is never a fresh command. */
export interface RetainedSupervisorCommand {
  command: unknown
  commandInputJson: string
  requestHash: string
  originalInputJson: string
  wrapperInputJson: string
  observedStatus: string
  statusOriginalInputJson: string
  statusWrapperInputJson: string
  headInputJson: string
  confirmedSequence: number
}

type Original = JournalRecord<SupervisorJournalEvent>
type Wrapper = JournalRecord<AuthorityEvent<Original>>
type Pair = { original: Original; wrapper: Wrapper }

function unavailable(): never {
  throw new Error("SUPERVISOR_COMMAND_HISTORY_UNAVAILABLE")
}

function matchPair(
  state: VerifiedJournalContinuation<SupervisorJournalEvent>,
  originalBytes: string,
  wrapperBytes: string
): Pair {
  for (const [originals, wrappers, first, last] of [
    [
      state.sealedRecords.originals,
      state.sealedRecords.wrappers,
      state.sealed.firstSequence,
      state.sealed.lastSequence,
    ],
    [
      state.originalTail.records,
      state.wrapperTail.records,
      state.sealed.lastSequence + 1,
      state.journalHead.sequence,
    ],
  ] as const) {
    const original = originals.find((item) => canonicalJson(item) === originalBytes)
    const wrapper = wrappers.find((item) => canonicalJson(item) === wrapperBytes)
    if (!original || !wrapper) continue
    if (
      original.sequence < first ||
      original.sequence > last ||
      wrapper.sequence !== original.sequence ||
      canonicalJson(wrapper.payload.payload) !== originalBytes ||
      wrapper.payload.eventId !== `supervisor:${original.hash}` ||
      wrapper.payload.epochId !== state.sealed.epochId ||
      original.payload.supervisorInstanceId !== state.sealed.supervisorInstanceId
    )
      unavailable()
    return { original, wrapper }
  }
  return unavailable()
}

/**
 * Must run while both the native database gate and withVerifiedJournalContinuation are held.
 * The matched status is historical; earlier seals may contain a hold that remains unresolved.
 */
export function matchRetainedSupervisorCommand(
  state: VerifiedJournalContinuation<SupervisorJournalEvent>,
  history: RetainedSupervisorCommand,
  expected: { commandId: string; attemptId: string; requestHash: string }
): { command: SupervisorCommand; intent: Pair; status: Pair; observedStatus: string } {
  state.assertActive()
  const parsed = supervisorCommandSchema.safeParse(history?.command)
  if (
    !parsed.success ||
    canonicalJson(parsed.data) !== history.commandInputJson ||
    sha256Hex(history.commandInputJson) !== expected.requestHash ||
    history.requestHash !== expected.requestHash ||
    parsed.data.commandId !== expected.commandId ||
    commandAttemptId(parsed.data) !== expected.attemptId ||
    history.headInputJson !== canonicalJson(state.journalHead) ||
    history.confirmedSequence !== state.journalHead.sequence ||
    state.journalHead.epochId !== state.sealed.epochId ||
    state.journalHead.supervisorInstanceId !== state.sealed.supervisorInstanceId
  )
    unavailable()
  const intent = matchPair(state, history.originalInputJson, history.wrapperInputJson)
  const status = matchPair(state, history.statusOriginalInputJson, history.statusWrapperInputJson)
  const first = intent.original.payload
  const last = status.original.payload
  if (
    first.type !== "command_intent" ||
    canonicalJson(first.command) !== history.commandInputJson ||
    status.original.sequence < intent.original.sequence ||
    intent.wrapper.payload.attemptId !== expected.attemptId ||
    status.wrapper.payload.attemptId !== expected.attemptId ||
    ["operationId", "scanId", "workspaceId"].some(
      (key) =>
        intent.wrapper.payload[key as "operationId" | "scanId" | "workspaceId"] !==
        status.wrapper.payload[key as "operationId" | "scanId" | "workspaceId"]
    )
  )
    unavailable()
  let observedStatus: string
  if (last.type === "command_intent") {
    if (canonicalJson(last.command) !== history.commandInputJson) unavailable()
    observedStatus = "UNKNOWN"
  } else if (last.type === "attempt_prepared") {
    if (
      last.commandId !== expected.commandId ||
      last.binding.attemptId !== expected.attemptId ||
      parsed.data.type !== "PREPARE" ||
      canonicalJson(last.binding) !== canonicalJson(parsed.data.attempt) ||
      canonicalJson(last.executors) !== canonicalJson(parsed.data.executors) ||
      canonicalJson(last.provider ?? null) !== canonicalJson(parsed.data.provider ?? null)
    )
      unavailable()
    observedStatus = "PREPARED"
  } else if (last.type === "command_terminal" || last.type === "command_recovery_hold") {
    if (
      last.commandId !== expected.commandId ||
      last.attemptId !== expected.attemptId ||
      (last.type === "command_recovery_hold" && last.expectedCommandHash !== expected.requestHash)
    )
      unavailable()
    observedStatus = last.type === "command_recovery_hold" ? "UNKNOWN" : last.status
  } else return unavailable()
  if (observedStatus !== history.observedStatus) unavailable()
  state.assertActive()
  return { command: parsed.data, intent, status, observedStatus }
}
