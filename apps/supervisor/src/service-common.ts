import {
  canonicalJson,
  computeEvidenceDigest,
  sha256Hex,
  toBrokerReceiptType,
  type CommandStatus,
  type JournalRecord,
  type SupervisorCommand,
  type SupervisorReceipt,
} from "@lyrashield/runtime-control"
import type { SupervisorJournalEvent } from "./journal-events"

const terminalStatuses = new Set<CommandStatus>([
  "PREPARED",
  "STARTED",
  "STOPPED",
  "NEVER_DISPATCHED",
  "UNKNOWN",
  "REJECTED",
  "FAILED",
])
export class RuntimeControlError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus = 409
  ) {
    super(message)
    this.name = "RuntimeControlError"
  }
}

export function receiptFromRecord(
  record: JournalRecord<SupervisorJournalEvent>
): SupervisorReceipt {
  const event = record.payload
  return {
    sequence: record.sequence,
    hash: record.hash,
    signature: record.signature,
    supervisorInstanceId: event.supervisorInstanceId,
    receiptType: toBrokerReceiptType(event),
    evidenceDigest: computeEvidenceDigest(event),
    observedAt: event.observedAt,
    ...(event.type === "resource_create_planned" || event.type === "resource_started"
      ? { executorKey: event.executorKey }
      : {}),
  }
}

export function isTerminal(status: CommandStatus): boolean {
  return terminalStatuses.has(status)
}

export function commandAttemptId(command: SupervisorCommand): string {
  return command.type === "PREPARE" ? command.attempt.attemptId : command.attemptId
}

export function commandRequestHash(command: SupervisorCommand): string {
  return sha256Hex(canonicalJson(command))
}
