import { canonicalJson, sha256Hex, type SupervisorReceipt } from "@lyrashield/runtime-control"
import type { AttemptState, CommandState, SupervisorJournalEvent } from "./journal-events"
import { executorActionBinding } from "./executor-action-binding"
import { RuntimeControlError, commandRequestHash, matchesOwnership } from "./service-common"

export function applyPrepareInvocationCompleted(
  event: Extract<SupervisorJournalEvent, { type: "prepare_invocation_completed" }>,
  attempts: Map<string, AttemptState>,
  commands: Map<string, CommandState>
): void {
  const attempt = attempts.get(event.attemptId)
  const command = commands.get(event.commandId)
  const request = command?.request
  if (
    !attempt ||
    !command ||
    !request ||
    request.type !== "PREPARE" ||
    command.status !== "PREPARED" ||
    attempt.status !== "PREPARED" ||
    request.attempt.attemptId !== event.attemptId ||
    request.attempt.operationId !== event.operationId ||
    request.attempt.authorityEpochId !== event.authorityEpochId ||
    event.nativeRequestId !== event.guardId ||
    event.actionChecksum !== commandRequestHash(request) ||
    event.commandInputChecksum !== commandRequestHash(request) ||
    attempt.nativeAckGuards?.has(event.guardId)
  )
    throw new RuntimeControlError("JOURNAL_INTEGRITY", "prepare invocation completion differs", 500)
  const binding = {
    phase: "PREPARE",
    operationId: request.attempt.operationId,
    attemptId: request.attempt.attemptId,
    scanId: request.attempt.scanId,
    workspaceId: request.attempt.workspaceId,
    authorityEpochId: request.attempt.authorityEpochId,
    authorityRevision: request.attempt.authorityRevision,
    authorityChecksum: sha256Hex(
      canonicalJson({
        attempt: request.attempt,
        executors: request.executors,
        provider: request.provider ?? null,
      })
    ),
    actionChecksum: commandRequestHash(request),
    commandId: request.commandId,
  }
  if (sha256Hex(canonicalJson(binding)) !== event.bindingInputChecksum)
    throw new RuntimeControlError("JOURNAL_INTEGRITY", "prepare invocation binding differs", 500)
  attempt.nativeAckGuards ??= new Set()
  attempt.nativeAckGuards.add(event.guardId)
}

export function applyNativeInvocationAck(
  event: Extract<SupervisorJournalEvent, { type: "native_invocation_ack" }>,
  receipt: SupervisorReceipt,
  attempts: Map<string, AttemptState>,
  commands: Map<string, CommandState>
): void {
  const attempt = attempts.get(event.attemptId)
  const command = commands.get(event.commandId)
  const request = command?.request
  if (
    event.nativeOperation === "SANDBOX_TOOL_START_ACK" ||
    event.nativeOperation === "SANDBOX_TOOL_MUTATION_ACK"
  ) {
    const sandbox = attempt?.resources.get("sandbox")
    if (
      !attempt ||
      !request ||
      request.type !== "PREPARE" ||
      !sandbox ||
      event.executorKey !== "sandbox" ||
      event.operationId !== attempt.binding.operationId ||
      event.authorityEpochId !== attempt.binding.authorityEpochId ||
      event.commandInputChecksum !== commandRequestHash(request) ||
      event.nativeRequestId !== event.guardId ||
      !event.requestId ||
      (event.nativeOperation === "SANDBOX_TOOL_START_ACK"
        ? !event.execId
        : event.nativeMutationId !== event.guardId ||
          !event.nativeTargets ||
          !event.nativeReceiptSha256) ||
      event.inspection.state !== "PRESENT" ||
      (event.nativeOperation === "SANDBOX_TOOL_START_ACK"
        ? event.inspection.running !== true
        : typeof event.inspection.running !== "boolean") ||
      canonicalJson(event.ownership) !== canonicalJson(sandbox) ||
      canonicalJson(event.inspection.ownership) !== canonicalJson(sandbox) ||
      attempt.nativeAckGuards?.has(event.guardId)
    )
      throw new RuntimeControlError(
        "JOURNAL_INTEGRITY",
        "sandbox invocation acknowledgement differs",
        500
      )
    const binding = {
      phase: "SANDBOX_TOOL",
      operationId: attempt.binding.operationId,
      attemptId: attempt.binding.attemptId,
      scanId: attempt.binding.scanId,
      workspaceId: attempt.binding.workspaceId,
      authorityEpochId: attempt.binding.authorityEpochId,
      authorityRevision: attempt.binding.authorityRevision,
      authorityChecksum: sha256Hex(
        canonicalJson({
          attempt: request.attempt,
          executors: request.executors,
          provider: request.provider ?? null,
        })
      ),
      actionChecksum: event.actionChecksum,
      commandId: request.commandId,
      executorKey: "sandbox",
      requestId: event.requestId,
    }
    if (sha256Hex(canonicalJson(binding)) !== event.bindingInputChecksum)
      throw new RuntimeControlError("JOURNAL_INTEGRITY", "sandbox invocation binding differs", 500)
    attempt.nativeAckGuards ??= new Set()
    attempt.nativeAckGuards.add(event.guardId)
    return
  }
  const phase =
    event.nativeOperation === "CONTAINER_CREATE_ACK" ? "EXECUTOR_CREATE" : "EXECUTOR_START"
  const planned = attempt?.planned.get(event.executorKey)
  const existing = attempt?.resources.get(event.executorKey)
  if (
    !attempt ||
    !command ||
    !request ||
    (request.type !== "START_PAID" && request.type !== "START_UNMETERED") ||
    request.attemptId !== event.attemptId ||
    request.executorKey !== event.executorKey ||
    attempt.binding.operationId !== event.operationId ||
    attempt.binding.authorityEpochId !== event.authorityEpochId ||
    event.nativeRequestId !== event.guardId ||
    event.ownership.kind !== "container" ||
    !event.ownership.containerId ||
    !/^[a-f0-9]{64}$/.test(event.ownership.containerId) ||
    !planned ||
    !matchesOwnership(planned, event.ownership) ||
    event.inspection.state !== "PRESENT" ||
    !event.inspection.ownership ||
    canonicalJson(event.inspection.ownership) !== canonicalJson(event.ownership) ||
    event.inspection.running !== (phase === "EXECUTOR_START") ||
    (phase === "EXECUTOR_START" &&
      (!existing ||
        !matchesOwnership(existing, event.ownership) ||
        !attempt.startPlanned.has(event.executorKey))) ||
    (phase === "EXECUTOR_CREATE" && !!existing) ||
    event.actionChecksum !== commandRequestHash(request) ||
    event.commandInputChecksum !== commandRequestHash(request) ||
    attempt.nativeAckGuards?.has(event.guardId)
  )
    throw new RuntimeControlError(
      "JOURNAL_INTEGRITY",
      "native invocation acknowledgement differs",
      500
    )
  const binding = executorActionBinding(attempt, request, phase)
  if (sha256Hex(canonicalJson(binding)) !== event.bindingInputChecksum)
    throw new RuntimeControlError("JOURNAL_INTEGRITY", "native invocation binding differs", 500)
  if (phase === "EXECUTOR_START") {
    const original = attempt.nativeStartIntents?.get(event.executorKey)
    if (
      !original ||
      original.guardId !== event.guardId ||
      original.bindingInputChecksum !== event.bindingInputChecksum ||
      canonicalJson(original.ownership) !== canonicalJson(event.ownership)
    )
      throw new RuntimeControlError("JOURNAL_INTEGRITY", "native start intent is unavailable", 500)
  }
  attempt.nativeAckGuards ??= new Set()
  attempt.nativeAckGuards.add(event.guardId)
  if (phase === "EXECUTOR_CREATE") {
    attempt.nativeCreateProofs ??= new Map()
    attempt.nativeCreateProofs.set(event.executorKey, event.ownership)
  }
  attempt.nativeStartIntents?.delete(event.executorKey)
  attempt.receipt = receipt
  command.receipt = receipt
}
