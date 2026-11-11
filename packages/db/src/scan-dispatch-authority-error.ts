export class ScanDispatchAuthorityError extends Error {
  constructor(
    readonly code:
      | "OPERATION_NOT_FOUND"
      | "AUTHORITY_EPOCH_CLOSED"
      | "WORKER_GRANT_INVALID"
      | "DISPATCH_OPERATION_STATE_INVALID"
      | "DISPATCH_SCOPE_CHANGED"
      | "DISPATCH_REPLAY_CONFLICT"
      | "CAPACITY_NOT_READY"
      | "QUEUE_PUBLICATION_NOT_CONFIRMED"
      | "DATABASE_REJECTED"
      | "PREPARATION_AUTHORITY_CLOSED"
      | "PREPARATION_AUTHORITY_BUSY"
      | "PREPARATION_AUTHORITY_UNAVAILABLE",
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = "ScanDispatchAuthorityError"
  }
}
