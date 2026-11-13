export type OperationStatusState = "PENDING" | "EXECUTING" | "COMPLETED" | "FAILED" | "CONFLICT"

export interface OperationStatusView {
  /** Stable operation identity, safe to share with the principal. */
  operationId: string
  status: OperationStatusState
  /** Safe reason code; never raw provider or internal error text. */
  reasonCode: string | null
  /** Where the durable result lives (e.g. a scan id), when disclosure permits. */
  resultLocation: string | null
  /** The one recovery action this state permits. */
  recovery: "wait" | "poll" | "retry_new_key" | "none"
  createdAt: string
  updatedAt: string
}

export function projectOperationStatus(input: {
  id: string
  status: OperationStatusState
  error: string | null
  failedResult: boolean
  resultLocation: string | null
  allowRecoveryDetails: boolean
  createdAt: Date
  updatedAt: Date
}): OperationStatusView {
  const status = input.status === "COMPLETED" && input.failedResult ? "FAILED" : input.status
  const recovery: OperationStatusView["recovery"] =
    status === "COMPLETED"
      ? "none"
      : status === "EXECUTING" || status === "PENDING"
        ? "poll"
        : input.allowRecoveryDetails &&
            status === "FAILED" &&
            input.error === "OPERATION_NOT_SUBMITTED"
          ? "retry_new_key"
          : "wait"
  return {
    operationId: input.id,
    status,
    reasonCode:
      input.allowRecoveryDetails && (input.error || input.failedResult) ? "OPERATION_FAILED" : null,
    resultLocation: input.resultLocation,
    recovery,
    createdAt: input.createdAt.toISOString(),
    updatedAt: input.updatedAt.toISOString(),
  }
}
