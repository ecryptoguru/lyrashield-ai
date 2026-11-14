import {
  canonicalJson,
  sha256Hex,
  type AuthorityAction,
  type JournalPort,
  type JournalRecord,
  type ResourceOwnership,
  type StartCommand,
} from "@lyrashield/runtime-control"
import { deriveOwnershipId, type ExecutorContext } from "./executor"
import { executorActionBinding } from "./executor-action-binding"
import type { AttemptState, SupervisorJournalEvent } from "./journal-events"
import { commandRequestHash } from "./service-common"

export function nativeInvocationAcknowledgement(options: {
  journal: JournalPort<SupervisorJournalEvent>
  supervisorInstanceId: string
  nowIso: () => string
  apply: (record: JournalRecord<SupervisorJournalEvent>) => void
  attempt: AttemptState
  command: StartCommand
  binding: AuthorityAction
  guardId: string
  assertActive: () => void
}): NonNullable<ExecutorContext["nativeInvocation"]> {
  return {
    requestId: options.guardId,
    ...(options.binding.phase === "EXECUTOR_CREATE"
      ? {
          planCreate: (ownership: ResourceOwnership) =>
            recordNativeCreatePlan({ ...options, ownership }),
        }
      : {}),
    acknowledge: async (fact) => {
      options.assertActive()
      const ownership = fact.inspection.ownership
      const creation = options.binding.phase === "EXECUTOR_CREATE"
      if (
        !ownership ||
        (options.binding.phase !== "EXECUTOR_CREATE" &&
          options.binding.phase !== "EXECUTOR_START") ||
        options.binding.commandId !== options.command.commandId ||
        options.binding.executorKey !== options.command.executorKey ||
        options.binding.operationId !== options.attempt.binding.operationId ||
        options.binding.attemptId !== options.attempt.binding.attemptId ||
        options.binding.authorityEpochId !== options.attempt.binding.authorityEpochId ||
        options.binding.actionChecksum !== commandRequestHash(options.command) ||
        fact.nativeRequestId !== options.guardId ||
        fact.operation !== (creation ? "CONTAINER_CREATE_ACK" : "CONTAINER_START_ACK") ||
        fact.inspection.state !== "PRESENT" ||
        fact.inspection.running !== !creation ||
        ownership.kind !== "container" ||
        ownership.executorKey !== options.command.executorKey ||
        ownership.ownershipId !==
          deriveOwnershipId(
            options.attempt.binding.attemptId,
            options.command.commandId,
            options.command.executorKey
          ) ||
        !ownership.containerId ||
        !/^[a-f0-9]{64}$/.test(ownership.containerId) ||
        !options.attempt.planned.has(options.command.executorKey) ||
        (creation && options.attempt.resources.has(options.command.executorKey)) ||
        (!creation &&
          (!options.attempt.startPlanned.has(options.command.executorKey) ||
            options.attempt.resources.get(options.command.executorKey)?.containerId !==
              ownership.containerId ||
            options.attempt.nativeStartIntents?.get(options.command.executorKey)?.guardId !==
              options.guardId ||
            options.attempt.nativeStartIntents?.get(options.command.executorKey)
              ?.bindingInputChecksum !== sha256Hex(canonicalJson(options.binding)) ||
            canonicalJson(
              options.attempt.nativeStartIntents?.get(options.command.executorKey)?.ownership
            ) !== canonicalJson(ownership)))
      )
        throw new Error("native invocation acknowledgement differs")
      const record = await options.journal.append({
        type: "native_invocation_ack",
        supervisorInstanceId: options.supervisorInstanceId,
        observedAt: options.nowIso(),
        commandId: options.command.commandId,
        attemptId: options.attempt.binding.attemptId,
        operationId: options.attempt.binding.operationId,
        authorityEpochId: options.attempt.binding.authorityEpochId,
        executorKey: options.command.executorKey,
        guardId: options.guardId,
        nativeRequestId: fact.nativeRequestId,
        nativeOperation: fact.operation,
        bindingInputChecksum: sha256Hex(canonicalJson(options.binding)),
        actionChecksum: options.binding.actionChecksum,
        commandInputChecksum: commandRequestHash(options.command),
        ownership,
        inspection: fact.inspection,
      })
      options.apply(record)
      options.assertActive()
    },
  }
}

export async function recordNativeStartPlan(options: {
  journal: JournalPort<SupervisorJournalEvent>
  supervisorInstanceId: string
  nowIso: () => string
  apply: (record: JournalRecord<SupervisorJournalEvent>) => void
  attempt: AttemptState
  command: StartCommand
  ownership: ResourceOwnership
  guardId: string
  assertActive: () => void
}): Promise<void> {
  const prior = options.attempt.nativeCreateProofs?.get(options.command.executorKey)
  if (
    !prior ||
    canonicalJson(prior) !== canonicalJson(options.ownership) ||
    options.attempt.nativeStartIntents?.has(options.command.executorKey) ||
    options.attempt.nativeAckGuards?.has(options.guardId)
  )
    throw new Error("authenticated original container creation is unavailable")
  const binding = executorActionBinding(options.attempt, options.command, "EXECUTOR_START")
  options.assertActive()
  const record = await options.journal.append({
    type: "native_invocation_planned",
    supervisorInstanceId: options.supervisorInstanceId,
    observedAt: options.nowIso(),
    commandId: options.command.commandId,
    attemptId: options.attempt.binding.attemptId,
    operationId: options.attempt.binding.operationId,
    authorityEpochId: options.attempt.binding.authorityEpochId,
    executorKey: options.command.executorKey,
    guardId: options.guardId,
    nativeRequestId: options.guardId,
    bindingInputChecksum: sha256Hex(canonicalJson(binding)),
    actionChecksum: binding.actionChecksum,
    commandInputChecksum: commandRequestHash(options.command),
    ownership: options.ownership,
  })
  options.apply(record)
  options.assertActive()
}

export async function recordNativeCreatePlan(options: {
  journal: JournalPort<SupervisorJournalEvent>
  supervisorInstanceId: string
  nowIso: () => string
  apply: (record: JournalRecord<SupervisorJournalEvent>) => void
  attempt: AttemptState
  command: StartCommand
  ownership: ResourceOwnership
  guardId: string
  assertActive: () => void
}): Promise<void> {
  const planned = options.attempt.planned.get(options.command.executorKey)
  if (
    !planned ||
    canonicalJson(planned) !== canonicalJson(options.ownership) ||
    options.ownership.containerId !== undefined ||
    options.ownership.kind !== "container" ||
    options.attempt.resources.has(options.command.executorKey) ||
    options.attempt.nativeStartIntents?.has(options.command.executorKey) ||
    options.attempt.nativeAckGuards?.has(options.guardId)
  )
    throw new Error("original native create plan is unavailable")
  const binding = executorActionBinding(options.attempt, options.command, "EXECUTOR_CREATE")
  options.assertActive()
  const record = await options.journal.append({
    type: "native_invocation_planned",
    phase: "EXECUTOR_CREATE",
    supervisorInstanceId: options.supervisorInstanceId,
    observedAt: options.nowIso(),
    commandId: options.command.commandId,
    attemptId: options.attempt.binding.attemptId,
    operationId: options.attempt.binding.operationId,
    authorityEpochId: options.attempt.binding.authorityEpochId,
    executorKey: options.command.executorKey,
    guardId: options.guardId,
    nativeRequestId: options.guardId,
    bindingInputChecksum: sha256Hex(canonicalJson(binding)),
    actionChecksum: binding.actionChecksum,
    commandInputChecksum: commandRequestHash(options.command),
    ownership: options.ownership,
  })
  options.apply(record)
  options.assertActive()
}
