import {
  createScanDispatchAuthorityBroker,
  type DispatchStatus,
  type PrepareDispatchInput,
  type ReconcileDispatchInput,
  type StartPaidDispatchInput,
  type StopDispatchInput,
} from "@lyrashield/db/src/scan-dispatch-authority-broker"
import { createProtectedSupervisorReceiptAuthority } from "@lyrashield/db/src/scan-supervisor-receipt-source"
import type { BrokerConfig } from "./config"

export interface BrokerService {
  readonly admission: "closed" | "open"
  prepare(input: PrepareDispatchInput): Promise<unknown>
  startPaid(input: StartPaidDispatchInput): Promise<unknown>
  startUnmetered(input: StartPaidDispatchInput): Promise<unknown>
  stop(input: StopDispatchInput): Promise<unknown>
  reconcile(input: ReconcileDispatchInput): Promise<unknown>
  consume(operationId: string): Promise<unknown>
  status(operationId: string): Promise<DispatchStatus>
  close(): Promise<void>
}

/**
 * Thin process host over the stored dispatch authority. Every state transition,
 * epoch lock, capacity decision and receipt projection stays in
 * `@lyrashield/db`; this module binds the protected installation, controls new
 * admission, and leaves recovery available when admission is closed.
 */
export function createBrokerService(config: BrokerConfig): BrokerService {
  const admission = config.admission === "open" && config.preparationAuthority ? "open" : "closed"
  const admissionClosed = () =>
    Promise.reject(
      Object.assign(new Error("Broker admission is closed"), { code: "ADMISSION_CLOSED" })
    )
  const authority = config.receiptAuthority
  const broker = createScanDispatchAuthorityBroker({
    connectionString: config.connectionString,
    ...(authority
      ? {
          receiptAuthority: createProtectedSupervisorReceiptAuthority({
            connectionString: config.connectionString,
            streamId: authority.streamId,
            authorityEpochId: authority.authorityEpochId,
            supervisorInstanceId: authority.supervisorInstanceId,
            originalSigningSecret: authority.originalSigningSecret,
            originalKeyHash: authority.originalKeyHash,
            wrapperSigningSecret: authority.wrapperSigningSecret,
            wrapperKeyHash: authority.wrapperKeyHash,
            controlToken: authority.controlToken,
            transport: { kind: "unix" as const, socketPath: authority.socketPath },
          }),
        }
      : {}),
    // Preparation is installed as one unit: the checked-intent contract and the
    // compiler that turns a transaction-verified scan into a checksum-bound
    // command. Installing one without the other would let PREPARE commit a
    // descriptor no executor can run, so an absent compiler leaves the whole
    // authority and process admission closed.
    ...(config.preparationAuthority
      ? {
          preparationAuthority: "checked-intent-v1" as const,
          compilePreparation: config.preparationAuthority,
        }
      : {}),
  })
  return {
    admission,
    prepare: (input) => (admission === "open" ? broker.prepare(input) : admissionClosed()),
    startPaid: (input) => (admission === "open" ? broker.startPaid(input) : admissionClosed()),
    startUnmetered: (input) =>
      admission === "open" ? broker.startUnmetered(input) : admissionClosed(),
    stop: (input) => broker.stop(input),
    reconcile: (input) => broker.reconcile(input),
    consume: (operationId) => broker.consumeSupervisorReceipts(operationId),
    status: (operationId) => broker.status(operationId),
    close: () => broker.close(),
  }
}
