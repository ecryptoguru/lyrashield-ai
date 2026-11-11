import type pg from "pg"
import type { ScanJobData } from "@lyrashield/types"
import { z } from "zod"
import { ScanQueueOutboxError } from "./scan-queue-payload"
import {
  createScanQueuePublicationProof,
  type ScanQueueJobSnapshot,
} from "./scan-queue-publication-proof"
import {
  createScanQueueOutboxStore,
  queueOutboxScopeSchema,
  verifyQueueOutboxAuthority,
  type QueueOutboxScope,
  type QueueOutboxStoreResult,
} from "./scan-queue-outbox-store"

/** Trusted internal adapter: publish=enqueueScan, read=exact getScanQueue().getJob readback. */
export interface ScanQueueOutboxTransport {
  publish(payload: ScanJobData): Promise<string>
  read(jobId: string): Promise<ScanQueueJobSnapshot | null>
}

async function bounded<T>(work: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new ScanQueueOutboxError("QUEUE_TRANSPORT_TIMEOUT")),
          timeoutMs
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Closed foundation: no caller, background worker, enforced admission or production adapter is registered. */
export function createScanQueueOutboxDispatcher(options: {
  pool: pg.Pool
  transport: ScanQueueOutboxTransport
  mode?: "closed" | "qualification"
  leaseMs?: number
  transportTimeoutMs?: number
}) {
  const settings = z
    .object({
      mode: z.enum(["closed", "qualification"]).default("closed"),
      leaseMs: z.number().int().min(1000).max(60_000).default(30_000),
      transportTimeoutMs: z.number().int().min(50).max(5000).default(3000),
    })
    .parse(options)
  const store = createScanQueueOutboxStore(options.pool, settings.leaseMs)

  async function readAndConfirm(
    scope: QueueOutboxScope,
    claim: Extract<QueueOutboxStoreResult, { kind: "leased" | "recoverable" }>
  ) {
    try {
      const snapshot = await bounded(
        () => options.transport.read(claim.row.jobId),
        settings.transportTimeoutMs
      )
      const proof = createScanQueuePublicationProof(
        claim.row,
        claim.row.payloadInputJson!,
        snapshot
      )
      return await store.confirm(
        scope,
        claim.row,
        claim.kind === "leased" ? claim.token : null,
        proof
      )
    } catch {
      if (claim.kind === "leased")
        return store.unknown(scope, claim.token, "QUEUE_READBACK_UNKNOWN")
      return { kind: "unknown", reasonCode: "QUEUE_READBACK_UNKNOWN" } as const
    }
  }

  return {
    /** For a future broker-mode worker; current legacy worker is not wired. */
    async verifyDispatch(input: QueueOutboxScope, snapshot: ScanQueueJobSnapshot) {
      const scope = queueOutboxScopeSchema.parse(input)
      if (settings.mode === "closed") return { kind: "closed" } as const
      return store.fence(scope, snapshot)
    },
    async dispatch(input: QueueOutboxScope): Promise<QueueOutboxStoreResult> {
      const scope = queueOutboxScopeSchema.parse(input)
      if (settings.mode === "closed") return { kind: "closed" }
      const claim = await store.claim(scope)
      if (claim.kind === "recoverable") return readAndConfirm(scope, claim)
      if (claim.kind !== "leased") return claim
      try {
        const id = await bounded(
          () => options.transport.publish(verifyQueueOutboxAuthority(claim.row)),
          settings.transportTimeoutMs
        )
        if (id !== claim.row.jobId)
          throw new ScanQueueOutboxError("QUEUE_ENQUEUE_IDENTITY_MISMATCH")
      } catch {
        // A missing ACK never proves non-delivery. Quarantine before readback;
        // recovery can confirm the same job but never publishes UNKNOWN again.
        const unknown = await store.unknown(scope, claim.token, "QUEUE_ENQUEUE_ACK_UNKNOWN")
        if (unknown.kind !== "unknown") return unknown
        return readAndConfirm(scope, { kind: "recoverable", row: claim.row })
      }
      return readAndConfirm(scope, claim)
    },
  }
}
