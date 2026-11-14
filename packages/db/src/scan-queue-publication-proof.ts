import { z } from "zod"
import {
  ScanQueueOutboxError,
  scanQueueDigest,
  serializeScanQueuePayload,
} from "./scan-queue-payload"

export type ScanQueueJobSnapshot = {
  id: string
  queueName: string
  name: string
  data: unknown
  state: string
}

export type ScanQueuePublicationIdentity = {
  outboxId: string
  operationId: string
  jobId: string
  payloadDigest: string
}

const receiptSchema = z
  .object({
    version: z.literal("scan-queue-publication/1"),
    outboxId: z.string().min(1).max(128),
    operationId: z.string().min(1).max(128),
    jobId: z.string().min(1).max(128),
    queueName: z.literal("scans"),
    jobName: z.literal("scan"),
    payloadDigest: z.string().regex(/^[a-f0-9]{64}$/),
    jobState: z.enum([
      "waiting",
      "delayed",
      "paused",
      "prioritized",
      "active",
      "completed",
      "failed",
      "waiting-children",
    ]),
    observedAt: z.string().datetime(),
  })
  .strict()

/** Positive readback from the configured private queue, not an enqueue ACK. */
export function createScanQueuePublicationProof(
  identity: ScanQueuePublicationIdentity,
  payloadInputJson: string,
  snapshot: ScanQueueJobSnapshot | null
) {
  if (!snapshot) throw new ScanQueueOutboxError("QUEUE_JOB_UNAVAILABLE")
  if (
    snapshot.id !== identity.jobId ||
    snapshot.queueName !== "scans" ||
    snapshot.name !== "scan" ||
    serializeScanQueuePayload(snapshot.data) !== payloadInputJson
  )
    throw new ScanQueueOutboxError("QUEUE_JOB_IDENTITY_MISMATCH")
  const receipt = receiptSchema.parse({
    version: "scan-queue-publication/1",
    outboxId: identity.outboxId,
    operationId: identity.operationId,
    jobId: identity.jobId,
    payloadDigest: identity.payloadDigest,
    queueName: "scans",
    jobName: "scan",
    jobState: snapshot.state,
    observedAt: new Date().toISOString(),
  })
  const input = JSON.stringify(receipt)
  return { input, checksum: scanQueueDigest(input) }
}

export function verifyScanQueuePublicationProof(
  identity: ScanQueuePublicationIdentity,
  input: string | null,
  checksum: string | null
) {
  if (!input || !checksum) throw new ScanQueueOutboxError("QUEUE_PUBLICATION_PROOF_UNAVAILABLE")
  if (Buffer.byteLength(input) > 2048 || scanQueueDigest(input) !== checksum)
    throw new ScanQueueOutboxError("QUEUE_PUBLICATION_PROOF_INTEGRITY")
  try {
    const receipt = receiptSchema.parse(JSON.parse(input))
    if (
      JSON.stringify(receipt) !== input ||
      (["outboxId", "operationId", "jobId", "payloadDigest"] as const).some(
        (key) => receipt[key] !== identity[key]
      )
    )
      throw new ScanQueueOutboxError("QUEUE_PUBLICATION_PROOF_IDENTITY_MISMATCH")
    return receipt
  } catch (error) {
    if (error instanceof ScanQueueOutboxError) throw error
    throw new ScanQueueOutboxError("QUEUE_PUBLICATION_PROOF_INVALID")
  }
}
