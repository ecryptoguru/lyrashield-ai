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
 * `@lyrashield/db`; this module only binds the protected installation and
 * refuses receipt settlement when that installation is absent.
 */
export function createBrokerService(config: BrokerConfig): BrokerService {
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
    // authority closed and prepare fails with PREPARATION_AUTHORITY_CLOSED.
    ...(config.preparationAuthority
      ? {
          preparationAuthority: "checked-intent-v1" as const,
          compilePreparation: config.preparationAuthority,
        }
      : {}),
  })
  return {
    admission: config.admission,
    prepare: (input) => broker.prepare(input),
    startPaid: (input) => broker.startPaid(input),
    startUnmetered: (input) => broker.startUnmetered(input),
    stop: (input) => broker.stop(input),
    reconcile: (input) => broker.reconcile(input),
    consume: (operationId) => broker.consumeSupervisorReceipts(operationId),
    status: (operationId) => broker.status(operationId),
    close: () => broker.close(),
  }
}
