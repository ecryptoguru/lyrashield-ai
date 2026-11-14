import type {
  AttemptBinding,
  AuthorityEvent,
  IndependentAuthorityJournalOptions,
  JournalPort,
  JournalRecord,
} from "@lyrashield/runtime-control"
import type { SupervisorJournalEvent } from "./journal-events"
import type { RecoveryAuthorizer } from "./authority-recovery"

export type OriginalRecord = JournalRecord<SupervisorJournalEvent>
export type OriginalEventPosition = Pick<OriginalRecord, "payload" | "sequence">
export type WrappedEvent = AuthorityEvent<OriginalRecord>
export type WrappedRecord = JournalRecord<WrappedEvent>

export type DurabilityOptions = Omit<
  IndependentAuthorityJournalOptions<OriginalRecord>,
  "local" | "payloadSchema" | "authorize" | "authorizeConfirmed"
> & {
  // Must atomically validate current persisted epoch, operation, attempt,
  // workspace, scan and authority revision. Journal evidence is not permission
  // to perform an executor or provider action.
  authorize: (event: WrappedEvent, binding: AttemptBinding) => Promise<boolean>
  authorizeConfirmed?: (record: WrappedRecord, binding: AttemptBinding) => Promise<boolean>
  // Mandatory even for genesis: authenticate the persisted active stream/epoch
  // independently of whether there are any events to authorize.
  authorizeStream: (stream: { epochId: string; supervisorInstanceId: string }) => Promise<boolean>
  // Independently compare current persisted command/attempt/epoch/grant authority;
  // request IDs/digest only select the original record and never grant permission.
  authorizeRecovery: RecoveryAuthorizer
  onConfirmed?: (record: OriginalRecord) => Promise<void>
  readOnly?: boolean
}

export interface SupervisorAuthorityJournalOptions extends DurabilityOptions {
  original: JournalPort<SupervisorJournalEvent>
  local: JournalPort<WrappedEvent>
}
