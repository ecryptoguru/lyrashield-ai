import {
  createScanDispatchAuthorityBroker,
  type DispatchStatus,
  type PrepareDispatchInput,
  type ReconcileDispatchInput,
  type StartPaidDispatchInput,
  type StopDispatchInput,
} from "@lyrashield/db/src/scan-dispatch-authority-broker"
import { createProtectedSupervisorAttemptProofAuthority } from "@lyrashield/db/src/scan-supervisor-receipt-source"
import { scanDispatchWorkerReceiptCredential } from "@lyrashield/db/src/scan-dispatch-worker-assignment"
import type { BrokerConfig } from "./config"
import { createScanQueuePublicationVerifier } from "@lyrashield/db/src/scan-queue-publication-verifier"
import type { QueuePublicationVerificationResult } from "@lyrashield/db/src/scan-queue-publication-verifier-schema"
import {
  nativeEngineResultInputSchema,
  supervisorCommandResultSchema,
  type NativeEngineResultChunk,
} from "@lyrashield/runtime-control"

export interface BrokerService {
  readonly admission: "closed" | "open"
  prepare(input: PrepareDispatchInput): Promise<unknown>
  startPaid(input: StartPaidDispatchInput): Promise<unknown>
  startUnmetered(input: StartPaidDispatchInput): Promise<unknown>
  stop(input: StopDispatchInput): Promise<unknown>
  reconcile(input: ReconcileDispatchInput): Promise<unknown>
  consume(operationId: string): Promise<unknown>
  status(operationId: string): Promise<DispatchStatus>
  verifyPublication?(input: unknown): Promise<QueuePublicationVerificationResult>
  dispatchPrepared?(input: Omit<StartPaidDispatchInput, "executorKey">): Promise<unknown>
  readResult?(input: unknown): Promise<NativeEngineResultChunk>
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
  const source = authority
    ? createProtectedSupervisorAttemptProofAuthority({
        streamId: authority.streamId,
        authorityEpochId: authority.authorityEpochId,
        supervisorInstanceId: authority.supervisorInstanceId,
        originalKeyHash: authority.originalKeyHash,
        wrapperKeyHash: authority.wrapperKeyHash,
        attemptProofPublicKey: authority.attemptProofPublicKey,
        controlToken: authority.controlToken,
        transport: { kind: "unix" as const, socketPath: authority.socketPath },
      })
    : undefined
  const broker = createScanDispatchAuthorityBroker({
    connectionString: config.connectionString,
    ...(config.lifecycleConnectionString
      ? { lifecycleConnectionString: config.lifecycleConnectionString }
      : {}),
    ...(source
      ? {
          attemptProofAuthority: source,
          consumeReceipts: (operationId: string) =>
            source.consume(operationId, scanDispatchWorkerReceiptCredential(operationId)),
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
  async function deliver<T>(
    result: T,
    input: { operationId: string }
  ): Promise<T | { kind: "unknown"; operationId: string; reasonCode: "COMMIT_OUTCOME_UNKNOWN" }> {
    if (
      !result ||
      typeof result !== "object" ||
      !("kind" in result) ||
      result.kind !== "committed" ||
      !("commandId" in result)
    )
      return result
    if (typeof result.commandId !== "string" || !source)
      return {
        kind: "unknown",
        operationId: input.operationId,
        reasonCode: "COMMIT_OUTCOME_UNKNOWN",
      }
    try {
      const status = supervisorCommandResultSchema.parse(
        await source.deliverCommand(
          { operationId: input.operationId, commandId: result.commandId },
          scanDispatchWorkerReceiptCredential(input.operationId)
        )
      )
      if (
        status.commandId !== result.commandId ||
        ("attemptId" in result && status.attemptId !== result.attemptId) ||
        !["PREPARED", "STARTED", "STOPPED", "NEVER_DISPATCHED"].includes(status.status)
      )
        return {
          kind: "unknown",
          operationId: input.operationId,
          reasonCode: "COMMIT_OUTCOME_UNKNOWN",
        }
      await broker.consumeSupervisorReceipts(input.operationId)
      return result
    } catch {
      return {
        kind: "unknown",
        operationId: input.operationId,
        reasonCode: "COMMIT_OUTCOME_UNKNOWN",
      }
    }
  }
  const publication = createScanQueuePublicationVerifier(config.connectionString)
  return {
    admission,
    prepare: async (input) => {
      if (admission !== "open") return admissionClosed()
      await config.stageOperation?.(input.operationId)
      return deliver(await broker.prepare(input), input)
    },
    startPaid: async (input) =>
      admission === "open" ? deliver(await broker.startPaid(input), input) : admissionClosed(),
    startUnmetered: async (input) =>
      admission === "open" ? deliver(await broker.startUnmetered(input), input) : admissionClosed(),
    stop: async (input) => deliver(await broker.stop(input), input),
    reconcile: async (input) => deliver(await broker.reconcile(input), input),
    consume: (operationId) => broker.consumeSupervisorReceipts(operationId),
    status: (operationId) => broker.status(operationId),
    verifyPublication: (input) =>
      admission === "open"
        ? publication.verifyDispatch(input)
        : Promise.resolve({ kind: "closed" }),
    dispatchPrepared: async (input) =>
      admission === "open"
        ? deliver(await broker.dispatchPrepared(input), input)
        : admissionClosed(),
    readResult: (value) => {
      const input = nativeEngineResultInputSchema.parse(value)
      const workerCredential = scanDispatchWorkerReceiptCredential(input.operationId)
      if (!source || !workerCredential)
        return Promise.reject(
          Object.assign(new Error("Worker result authority is unavailable"), {
            code: "WORKER_GRANT_INVALID",
          })
        )
      return source.readResult(input, workerCredential)
    },
    close: async () => {
      await Promise.all([broker.close(), publication.close()])
    },
  }
}
