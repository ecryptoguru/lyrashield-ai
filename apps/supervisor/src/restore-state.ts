import { type JournalRecord } from "@lyrashield/runtime-control"
import type { AttemptState, CommandState, SupervisorJournalEvent } from "./journal-events"
import { applyJournalRecord } from "./journal-state"
import { eventCommandId } from "./authority-recovery"
import { isTerminal, receiptFromRecord, RuntimeControlError } from "./service-common"

/** Validate and reconstruct into temporary maps before replacing live state. */
export function restoreJournalState(
  records: JournalRecord<SupervisorJournalEvent>[],
  attempts: Map<string, AttemptState>,
  commands: Map<string, CommandState>
): void {
  const restoredAttempts = new Map<string, AttemptState>()
  const restoredCommands = new Map<string, CommandState>()
  const holds = new Map<string, JournalRecord<SupervisorJournalEvent>>()
  for (const record of records) {
    const event = record.payload
    if (event.type === "command_recovery_hold") {
      const original = records[event.recoveredSequence - 1]
      if (
        !original ||
        original.sequence >= record.sequence ||
        original.hash !== event.recoveredHash ||
        eventCommandId(original.payload) !== event.commandId
      ) {
        throw new RuntimeControlError("JOURNAL_INTEGRITY", "invalid original recovery linkage", 500)
      }
      holds.set(event.commandId, record)
    }
    applyJournalRecord(record, restoredAttempts, restoredCommands)
  }
  for (const [commandId, hold] of holds) {
    const command = restoredCommands.get(commandId)!
    command.status = "UNKNOWN"
    command.reason = "journal durability confirmed; physical disposition remains unresolved"
    command.receipt = receiptFromRecord(hold)
    const resolved = records.some((record) => {
      const event = record.payload
      if (
        record.sequence <= hold.sequence ||
        event.type !== "command_terminal" ||
        event.commandId === commandId ||
        event.attemptId !== command.attemptId ||
        (event.status !== "STOPPED" && event.status !== "NEVER_DISPATCHED")
      )
        return false
      const request = restoredCommands.get(event.commandId)?.request
      return request?.type === "STOP" || request?.type === "RECONCILE"
    })
    if (!resolved) restoredAttempts.get(command.attemptId)!.status = "UNKNOWN"
  }
  for (const [commandId, command] of restoredCommands) {
    const attempt = restoredAttempts.get(command.attemptId)
    if (
      command.status === "UNKNOWN" &&
      attempt &&
      attempt.status !== "STOPPED" &&
      attempt.status !== "NEVER_DISPATCHED"
    ) {
      attempt.status = "UNKNOWN"
    }
    if (command.request && !isTerminal(command.status) && command.status !== "PREPARED") {
      const original = records.find(
        (record) =>
          record.payload.type === "command_intent" && record.payload.command.commandId === commandId
      )
      if (original) {
        command.status = "UNKNOWN"
        command.reason = "service restarted with an unresolved effect; use RECONCILE"
        command.receipt = receiptFromRecord(original)
        if (attempt && attempt.status !== "STOPPED" && attempt.status !== "NEVER_DISPATCHED")
          attempt.status = "UNKNOWN"
      }
    }
  }
  // No awaits between validation and installation: callers serialize this boundary.
  attempts.clear()
  commands.clear()
  for (const [id, state] of restoredAttempts) attempts.set(id, state)
  for (const [id, state] of restoredCommands) commands.set(id, state)
}
