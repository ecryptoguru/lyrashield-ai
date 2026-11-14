import { z } from "zod"
import {
  executorKeySchema,
  resourceOwnershipSchema,
  type JournalRecord,
  type SupervisorCommand,
  type SupervisorReceipt,
} from "@lyrashield/runtime-control"
import type { AttemptState, CommandState, SupervisorJournalEvent } from "./journal-events"
import {
  RuntimeControlError,
  commandAttemptId,
  commandRequestHash,
  receiptFromRecord,
} from "./service-common"
import { applyNativeInvocationAck, applyPrepareInvocationCompleted } from "./native-ack-state"
import { applyNativeRetirement, applyNativeStartPlan } from "./native-retirement-state"

function prepareAttempt(
  command: Extract<SupervisorCommand, { type: "PREPARE" }>,
  receipt: SupervisorReceipt,
  status: "PREPARED" | "UNKNOWN"
): AttemptState {
  return {
    binding: command.attempt,
    plans: new Map(command.executors.map((plan) => [plan.key, plan])),
    ...(command.provider ? { provider: command.provider } : {}),
    grants: new Map(),
    planned: new Map(),
    resources: new Map(),
    createAcknowledged: new Set(),
    startPlanned: new Set(),
    startAcknowledged: new Set(),
    receipt,
    status,
    createdExecutors: new Set(),
  }
}

function applyPrepared(
  event: Extract<SupervisorJournalEvent, { type: "attempt_prepared" }>,
  receipt: SupervisorReceipt,
  attempts: Map<string, AttemptState>,
  commands: Map<string, CommandState>
): void {
  const prepareCommand: Extract<SupervisorCommand, { type: "PREPARE" }> = {
    type: "PREPARE",
    commandId: event.commandId,
    attempt: event.binding,
    executors: event.executors,
    ...(event.provider ? { provider: event.provider } : {}),
  }
  const existing = commands.get(event.commandId)
  if (
    existing &&
    (existing.attemptId !== event.binding.attemptId ||
      existing.requestHash !== commandRequestHash(prepareCommand))
  )
    throw new RuntimeControlError("JOURNAL_INTEGRITY", "prepared command identity changed", 500)
  attempts.set(event.binding.attemptId, prepareAttempt(prepareCommand, receipt, "PREPARED"))
  commands.set(event.commandId, {
    request: prepareCommand,
    requestHash: commandRequestHash(prepareCommand),
    attemptId: event.binding.attemptId,
    status: "PREPARED",
    receipt,
  })
}

function applyIntent(
  event: Extract<SupervisorJournalEvent, { type: "command_intent" }>,
  receipt: SupervisorReceipt,
  attempts: Map<string, AttemptState>,
  commands: Map<string, CommandState>
): void {
  const existing = commands.get(event.command.commandId)
  if (existing) {
    if (
      existing.attemptId !== commandAttemptId(event.command) ||
      existing.requestHash !== commandRequestHash(event.command)
    )
      throw new RuntimeControlError("JOURNAL_INTEGRITY", "command intent identity changed", 500)
    existing.receipt = receipt
    return
  }
  if (event.command.type === "PREPARE" && !attempts.has(event.command.attempt.attemptId)) {
    // An accepted intent preserves cleanup identity, never start authority.
    // Only attempt_prepared may promote this state to PREPARED.
    attempts.set(event.command.attempt.attemptId, prepareAttempt(event.command, receipt, "UNKNOWN"))
  }
  commands.set(event.command.commandId, {
    request: event.command,
    requestHash: commandRequestHash(event.command),
    attemptId: commandAttemptId(event.command),
    status: "RECEIVED",
    receipt,
  })
}

function applyRecoveryHold(
  event: Extract<SupervisorJournalEvent, { type: "command_recovery_hold" }>,
  receipt: SupervisorReceipt,
  attempts: Map<string, AttemptState>,
  commands: Map<string, CommandState>
): void {
  const command = commands.get(event.commandId)
  const attempt = attempts.get(event.attemptId)
  if (
    !command ||
    !attempt ||
    command.attemptId !== event.attemptId ||
    command.requestHash !== event.expectedCommandHash
  ) {
    throw new RuntimeControlError("JOURNAL_INTEGRITY", "invalid recovery command binding", 500)
  }
  command.status = "UNKNOWN"
  command.reason = "journal durability confirmed; physical disposition remains unresolved"
  command.receipt = receipt
  attempt.status = "UNKNOWN"
  attempt.receipt = receipt
}

function applyNativeRecord(
  event: SupervisorJournalEvent,
  receipt: SupervisorReceipt,
  attempts: Map<string, AttemptState>,
  commands: Map<string, CommandState>
): boolean {
  if (event.type === "native_invocation_ack")
    applyNativeInvocationAck(event, receipt, attempts, commands)
  else if (event.type === "prepare_invocation_completed")
    applyPrepareInvocationCompleted(event, attempts, commands)
  else if (event.type === "native_invocation_planned")
    applyNativeStartPlan(event, receipt, attempts, commands)
  else if (event.type === "native_invocation_retired")
    applyNativeRetirement(event, attempts, commands)
  else return false
  return true
}

export function applyJournalRecord(
  record: JournalRecord<SupervisorJournalEvent>,
  attempts: Map<string, AttemptState>,
  commands: Map<string, CommandState>
): void {
  const event = record.payload
  const receipt = receiptFromRecord(record)
  if (event.type === "command_recovery_hold") {
    applyRecoveryHold(event, receipt, attempts, commands)
    return
  }
  if (event.type === "attempt_prepared") {
    applyPrepared(event, receipt, attempts, commands)
    return
  }
  if (event.type === "command_intent") {
    applyIntent(event, receipt, attempts, commands)
    return
  }
  if (event.type === "resource_create_planned") {
    const ownership = resourceOwnershipSchema.safeParse({
      executorKey: event.executorKey,
      kind: event.kind,
      ownershipId: event.ownershipId,
      ...(event.cgroupPath ? { cgroupPath: event.cgroupPath } : {}),
    })
    if (!ownership.success)
      throw new RuntimeControlError("JOURNAL_INTEGRITY", "invalid planned ownership", 500)
    const attempt = attempts.get(event.attemptId)
    if (attempt) {
      attempt.planned.set(ownership.data.executorKey, ownership.data)
      attempt.receipt = receipt
    }
    const command = commands.get(event.commandId)
    if (command) command.receipt = receipt
    return
  }
  if (applyNativeRecord(event, receipt, attempts, commands)) return
  if (event.type === "resource_create_acknowledged" || event.type === "resource_start_planned") {
    const attempt = attempts.get(event.attemptId)
    if (
      !attempt ||
      !attempt.planned.has(event.executorKey) ||
      (event.type === "resource_create_acknowledged" &&
        !attempt.resources.has(event.executorKey)) ||
      (event.type === "resource_start_planned" &&
        !attempt.createAcknowledged.has(event.executorKey))
    ) {
      throw new RuntimeControlError(
        "JOURNAL_INTEGRITY",
        "executor effect evidence is out of order",
        500
      )
    }
    if (event.type === "resource_create_acknowledged")
      attempt.createAcknowledged.add(event.executorKey)
    else attempt.startPlanned.add(event.executorKey)
    attempt.receipt = receipt
    const command = commands.get(event.commandId)
    if (command) command.receipt = receipt
    return
  }
  if (event.type === "resource_bound" || event.type === "resource_started") {
    const parsed = z
      .object({
        executorKey: executorKeySchema,
        kind: z.enum(["container", "process"]),
        ownershipId: z.string(),
        containerId: z.string().optional(),
        processGroupId: z.number().optional(),
        cgroupPath: z.string().optional(),
      })
      .passthrough()
      .parse(event.ownership)
    const ownership = resourceOwnershipSchema.safeParse(parsed)
    if (!ownership.success)
      throw new RuntimeControlError("JOURNAL_INTEGRITY", "invalid resource ownership", 500)
    if (event.type === "resource_started" && event.executorKey !== ownership.data.executorKey) {
      throw new RuntimeControlError("JOURNAL_INTEGRITY", "started executor identity mismatch", 500)
    }
    const attempt = attempts.get(event.attemptId)
    if (attempt) {
      if (event.type === "resource_started") {
        if (!attempt.startPlanned.has(event.executorKey)) {
          throw new RuntimeControlError("JOURNAL_INTEGRITY", "executor start was not planned", 500)
        }
        attempt.startAcknowledged.add(event.executorKey)
      }
      attempt.resources.set(ownership.data.executorKey, ownership.data)
      attempt.createdExecutors.add(ownership.data.executorKey)
      attempt.receipt = receipt
    }
    const command = commands.get(event.commandId)
    if (command) command.receipt = receipt
    return
  }
  if (event.type === "provider_grants_bound") {
    const attempt = attempts.get(event.attemptId)
    if (attempt) {
      for (const grant of event.grants)
        attempt.grants.set(grant.providerId, { ...grant, grantRequestId: event.commandId })
      attempt.receipt = receipt
    }
    const command = commands.get(event.commandId)
    if (command) command.receipt = receipt
    return
  }
  if (event.type === "provider_grants_revoked") {
    const attempt = attempts.get(event.attemptId)
    if (attempt) {
      for (const grantId of event.grantIds) {
        for (const grant of attempt.grants.values()) {
          if (grant.grantId === grantId) grant.revoked = true
        }
      }
      attempt.receipt = receipt
    }
    const command = commands.get(event.commandId)
    if (command) command.receipt = receipt
    return
  }
  if (event.type === "attempt_status") {
    const attempt = attempts.get(event.attemptId)
    if (attempt) {
      attempt.status = event.status
      attempt.receipt = receipt
    }
    return
  }
  if (event.type !== "command_terminal") {
    throw new RuntimeControlError("JOURNAL_INTEGRITY", "unrecognized journal event", 500)
  }
  const command = commands.get(event.commandId)
  if (command) {
    command.status = event.status
    command.reason = event.reason
    command.receipt = receipt
  }
  const attempt = attempts.get(event.attemptId)
  if (attempt) attempt.receipt = receipt
}
