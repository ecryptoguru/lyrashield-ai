import { canonicalJson, sha256Hex, type SupervisorReceipt } from "@lyrashield/runtime-control"
import { executorActionBinding } from "./executor-action-binding"
import type { AttemptState, CommandState, SupervisorJournalEvent } from "./journal-events"
import { RuntimeControlError, commandRequestHash } from "./service-common"

type Planned = Extract<SupervisorJournalEvent, { type: "native_invocation_planned" }>
type Retired = Extract<SupervisorJournalEvent, { type: "native_invocation_retired" }>

export function applyNativeStartPlan(
  event: Planned,
  receipt: SupervisorReceipt,
  attempts: Map<string, AttemptState>,
  commands: Map<string, CommandState>
): void {
  const attempt = attempts.get(event.attemptId)
  const command = commands.get(event.commandId)
  const request = command?.request
  const priorCreate = attempt?.nativeCreateProofs?.get(event.executorKey)
  const owned = attempt?.resources.get(event.executorKey)
  if (
    !attempt ||
    !command ||
    !request ||
    (request.type !== "START_PAID" && request.type !== "START_UNMETERED") ||
    request.attemptId !== event.attemptId ||
    request.executorKey !== event.executorKey ||
    attempt.binding.operationId !== event.operationId ||
    attempt.binding.authorityEpochId !== event.authorityEpochId ||
    event.guardId !== event.nativeRequestId ||
    event.actionChecksum !== commandRequestHash(request) ||
    event.commandInputChecksum !== commandRequestHash(request) ||
    !priorCreate ||
    !owned ||
    canonicalJson(priorCreate) !== canonicalJson(event.ownership) ||
    canonicalJson(owned) !== canonicalJson(event.ownership) ||
    !attempt.startPlanned.has(event.executorKey) ||
    attempt.nativeStartIntents?.has(event.executorKey) ||
    attempt.nativeAckGuards?.has(event.guardId) ||
    sha256Hex(canonicalJson(executorActionBinding(attempt, request, "EXECUTOR_START"))) !==
      event.bindingInputChecksum
  )
    throw new RuntimeControlError("JOURNAL_INTEGRITY", "native start guard plan differs", 500)
  attempt.nativeStartIntents ??= new Map()
  attempt.nativeStartIntents.set(event.executorKey, event)
  attempt.receipt = receipt
  command.receipt = receipt
}

export function applyNativeRetirement(
  event: Retired,
  attempts: Map<string, AttemptState>,
  commands: Map<string, CommandState>
): void {
  const attempt = attempts.get(event.attemptId)
  const original = attempt?.nativeStartIntents?.get(event.executorKey)
  const stop = commands.get(event.stopCommandId)?.request
  if (
    !attempt ||
    !original ||
    !stop ||
    stop.type !== "STOP" ||
    stop.attemptId !== event.attemptId ||
    event.nativeOperation !== "CONTAINER_REMOVED" ||
    canonicalJson(event.inspection) !== canonicalJson({ state: "ABSENT" }) ||
    canonicalJson(event.ownership) !== canonicalJson(original.ownership) ||
    event.commandId !== original.commandId ||
    event.guardId !== original.guardId ||
    event.nativeRequestId !== original.nativeRequestId ||
    event.bindingInputChecksum !== original.bindingInputChecksum ||
    event.actionChecksum !== original.actionChecksum ||
    event.commandInputChecksum !== original.commandInputChecksum ||
    event.operationId !== original.operationId ||
    event.authorityEpochId !== original.authorityEpochId ||
    attempt.nativeAckGuards?.has(event.guardId)
  )
    throw new RuntimeControlError("JOURNAL_INTEGRITY", "native retirement evidence differs", 500)
  attempt.nativeStartIntents?.delete(event.executorKey)
  attempt.nativeAckGuards ??= new Set()
  attempt.nativeAckGuards.add(event.guardId)
}
