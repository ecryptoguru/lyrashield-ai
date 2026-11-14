import {
  canonicalJson,
  sha256Hex,
  authorityActionSchema,
  parseSandboxToolRetirementProof,
  type SupervisorReceipt,
} from "@lyrashield/runtime-control"
import { executorActionBinding } from "./executor-action-binding"
import type { AttemptState, CommandState, SupervisorJournalEvent } from "./journal-events"
import { RuntimeControlError, commandRequestHash, matchesOwnership } from "./service-common"
import { parseNativeRemovalProof } from "./native-removal-proof"

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
  const creation = event.phase === "EXECUTOR_CREATE"
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
    (creation
      ? !attempt.planned.has(event.executorKey) ||
        !!owned ||
        event.ownership.containerId !== undefined ||
        canonicalJson(attempt.planned.get(event.executorKey)) !== canonicalJson(event.ownership)
      : !priorCreate ||
        !owned ||
        canonicalJson(priorCreate) !== canonicalJson(event.ownership) ||
        canonicalJson(owned) !== canonicalJson(event.ownership) ||
        !attempt.startPlanned.has(event.executorKey)) ||
    attempt.nativeStartIntents?.has(event.executorKey) ||
    attempt.nativeAckGuards?.has(event.guardId) ||
    sha256Hex(
      canonicalJson(
        executorActionBinding(attempt, request, creation ? "EXECUTOR_CREATE" : "EXECUTOR_START")
      )
    ) !== event.bindingInputChecksum
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
  if (event.phase === "SANDBOX_TOOL") {
    const proof = parseSandboxToolRetirementProof(event.nativeToolRetirementProof),
      action = authorityActionSchema.parse(JSON.parse(proof.bindingInputJson))
    const prepare = commands.get(event.commandId)?.request,
      stop = commands.get(event.stopCommandId)?.request,
      owned = attempt?.resources.get("sandbox")
    if (
      !attempt ||
      !prepare ||
      prepare.type !== "PREPARE" ||
      !stop ||
      stop.type !== "STOP" ||
      stop.attemptId !== event.attemptId ||
      !owned ||
      event.executorKey !== "sandbox" ||
      event.nativeOperation !== "CONTAINER_REMOVED" ||
      canonicalJson(event.inspection) !== canonicalJson({ state: "ABSENT" }) ||
      canonicalJson(owned) !== canonicalJson(event.ownership) ||
      canonicalJson(proof.ownership) !== canonicalJson(owned) ||
      event.operationId !== proof.operationId ||
      event.attemptId !== proof.attemptId ||
      event.authorityEpochId !== proof.authorityEpochId ||
      action.operationId !== attempt.binding.operationId ||
      action.attemptId !== attempt.binding.attemptId ||
      action.authorityEpochId !== attempt.binding.authorityEpochId ||
      action.scanId !== attempt.binding.scanId ||
      action.workspaceId !== attempt.binding.workspaceId ||
      action.authorityRevision !== attempt.binding.authorityRevision ||
      event.guardId !== proof.guardId ||
      event.nativeRequestId !== proof.guardId ||
      event.commandId !== proof.commandId ||
      event.stopCommandId !== proof.stopCommandId ||
      event.actionChecksum !== proof.actionChecksum ||
      event.commandInputChecksum !== commandRequestHash(prepare) ||
      proof.commandInputChecksum !== event.commandInputChecksum ||
      event.bindingInputChecksum !== sha256Hex(proof.bindingInputJson) ||
      action.authorityChecksum !==
        sha256Hex(
          canonicalJson({
            attempt: prepare.attempt,
            executors: prepare.executors,
            provider: prepare.provider ?? null,
          })
        ) ||
      attempt.nativeAckGuards?.has(event.guardId)
    )
      throw new RuntimeControlError("JOURNAL_INTEGRITY", "Sandbox tool retirement differs", 500)
    attempt.nativeAckGuards ??= new Set()
    attempt.nativeAckGuards.add(event.guardId)
    return
  }
  const original = attempt?.nativeStartIntents?.get(event.executorKey)
  const stop = commands.get(event.stopCommandId)?.request
  const creation = original?.phase === "EXECUTOR_CREATE"
  if (
    !attempt ||
    !original ||
    !stop ||
    stop.type !== "STOP" ||
    stop.attemptId !== event.attemptId ||
    event.nativeOperation !== "CONTAINER_REMOVED" ||
    canonicalJson(event.inspection) !== canonicalJson({ state: "ABSENT" }) ||
    (event.phase ?? "EXECUTOR_START") !== (original.phase ?? "EXECUTOR_START") ||
    (creation
      ? !matchesOwnership(original.ownership, event.ownership) || !event.ownership.containerId
      : canonicalJson(event.ownership) !== canonicalJson(original.ownership)) ||
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
  if (creation) {
    const proof = parseNativeRemovalProof(event.nativeRemovalProof)
    if (
      proof.guardId !== event.guardId ||
      proof.commandId !== event.commandId ||
      proof.stopCommandId !== event.stopCommandId ||
      proof.operationId !== event.operationId ||
      proof.attemptId !== event.attemptId ||
      proof.authorityEpochId !== event.authorityEpochId ||
      proof.bindingInputChecksum !== event.bindingInputChecksum ||
      proof.actionChecksum !== event.actionChecksum ||
      canonicalJson(proof.ownership) !== canonicalJson(event.ownership)
    )
      throw new RuntimeControlError("JOURNAL_INTEGRITY", "original create removal differs", 500)
  } else if (event.nativeRemovalProof !== undefined)
    throw new RuntimeControlError("JOURNAL_INTEGRITY", "unexpected create removal proof", 500)
  attempt.nativeRetirements ??= new Map()
  attempt.nativeRetirements.set(event.executorKey, event.ownership)
  attempt.nativeStartIntents?.delete(event.executorKey)
  attempt.nativeAckGuards ??= new Set()
  attempt.nativeAckGuards.add(event.guardId)
}
