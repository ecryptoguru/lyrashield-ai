import { createHash } from "node:crypto"
import { ScanJobDataSchema, type ScanJobData } from "@lyrashield/types"
import type { Scan } from "./generated/prisma"

export const SCAN_QUEUE_PAYLOAD_MAX_BYTES = 4096

export class ScanQueueOutboxError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = "ScanQueueOutboxError"
  }
}

const payloadSchema = ScanJobDataSchema.strict()
export type ScanQueueIdentity = Pick<
  Scan,
  "id" | "workspaceId" | "targetId" | "goal" | "mode" | "policyId"
>

export function scanQueueDigest(input: string): string {
  return createHash("sha256").update(input).digest("hex")
}

export function serializeScanQueuePayload(value: unknown): string {
  const payload = payloadSchema.parse(value)
  const input = JSON.stringify(payload)
  if (Buffer.byteLength(input) > SCAN_QUEUE_PAYLOAD_MAX_BYTES)
    throw new ScanQueueOutboxError("QUEUE_PAYLOAD_TOO_LARGE")
  return input
}

/** Focus is normalized by the server and persisted in immutable outbox bytes. */
export function buildScanQueuePayload(
  scan: ScanQueueIdentity,
  focus?: ScanJobData["focus"]
): string {
  return serializeScanQueuePayload({
    scanId: scan.id,
    workspaceId: scan.workspaceId,
    targetId: scan.targetId,
    goal: scan.goal,
    mode: scan.mode,
    ...(scan.policyId ? { policyId: scan.policyId } : {}),
    ...(focus !== undefined ? { focus } : {}),
  })
}

export function verifyScanQueuePayload(
  input: string | null,
  digest: string,
  scan: ScanQueueIdentity
): ScanJobData {
  if (!input) throw new ScanQueueOutboxError("QUEUE_PAYLOAD_UNAVAILABLE")
  if (Buffer.byteLength(input) > SCAN_QUEUE_PAYLOAD_MAX_BYTES || scanQueueDigest(input) !== digest)
    throw new ScanQueueOutboxError("QUEUE_PAYLOAD_INTEGRITY")
  try {
    const payload = payloadSchema.parse(JSON.parse(input))
    if (
      serializeScanQueuePayload(payload) !== input ||
      buildScanQueuePayload(scan, payload.focus) !== input
    )
      throw new ScanQueueOutboxError("QUEUE_PAYLOAD_IDENTITY_CHANGED")
    return payload
  } catch (error) {
    if (error instanceof ScanQueueOutboxError) throw error
    throw new ScanQueueOutboxError("QUEUE_PAYLOAD_INVALID")
  }
}
