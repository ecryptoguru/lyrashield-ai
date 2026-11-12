import {
  IndependentAuthorityError,
  canonicalJson,
  type AttemptBinding,
  type JournalRecord,
} from "@lyrashield/runtime-control"
import type { SupervisorJournalEvent } from "./journal-events"
type OriginalEventPosition = Pick<JournalRecord<SupervisorJournalEvent>, "payload" | "sequence">
function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right)
}
function conflict(message: string): never {
  throw new IndependentAuthorityError("AUTHORITY_CONFLICT", message)
}
export function bindingFor(
  record: OriginalEventPosition,
  records: OriginalEventPosition[]
): AttemptBinding {
  const attemptId = attemptFor(record)
  const event = record.payload
  let binding: AttemptBinding | undefined
  for (const prior of records.slice(0, record.sequence)) {
    const payload = prior.payload
    if (
      payload.type === "command_intent" &&
      payload.command.type === "PREPARE" &&
      payload.command.attempt.attemptId === attemptId
    ) {
      if (binding && !same(binding, payload.command.attempt)) {
        conflict("original journal contains conflicting attempt authority")
      }
      binding = payload.command.attempt
    }
  }
  if (!binding) conflict("original event has no preceding attempt authority")
  if (event.type === "attempt_prepared" && !same(event.binding, binding)) {
    conflict("prepared event disagrees with original attempt authority")
  }
  return binding
}

export function attemptFor(record: OriginalEventPosition): string {
  const event = record.payload
  return event.type === "command_intent"
    ? event.command.type === "PREPARE"
      ? event.command.attempt.attemptId
      : event.command.attemptId
    : event.type === "attempt_prepared"
      ? event.binding.attemptId
      : event.attemptId
}
