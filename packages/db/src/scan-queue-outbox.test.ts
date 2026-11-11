import { describe, expect, it, vi, beforeEach } from "vitest"
import {
  buildScanQueuePayload,
  scanQueueDigest,
  verifyScanQueuePayload,
} from "./scan-queue-payload"
import {
  createScanQueuePublicationProof,
  verifyScanQueuePublicationProof,
} from "./scan-queue-publication-proof"
import type { QueueOutboxRow } from "./scan-queue-outbox-store"
import type pg from "pg"
import { buildScanExecutionPlan } from "@lyrashield/types"
import { computeScanExecutionPlanHash } from "./scan-execution-plan"

const store = vi.hoisted(() => ({
  claim: vi.fn(),
  unknown: vi.fn(),
  confirm: vi.fn(),
  fence: vi.fn(),
}))
vi.mock("./scan-queue-outbox-store", async (original) => ({
  ...(await original<typeof import("./scan-queue-outbox-store")>()),
  createScanQueueOutboxStore: () => store,
}))
import { createScanQueueOutboxDispatcher } from "./scan-queue-outbox-dispatcher"

const scan = {
  id: "scan-1",
  workspaceId: "ws-1",
  targetId: "target-1",
  goal: "TEST_APP",
  mode: "SAFE",
  policyId: null,
} as const
const input = buildScanQueuePayload(scan, "payments")
const plan = buildScanExecutionPlan({
  targetType: "REPO",
  mode: "SAFE",
  source: { revision: "a".repeat(40) },
})
const identity = {
  outboxId: "outbox-1",
  operationId: "op-1",
  jobId: scan.id,
  payloadDigest: scanQueueDigest(input),
}
const snapshot = {
  id: scan.id,
  queueName: "scans",
  name: "scan",
  data: JSON.parse(input),
  state: "waiting",
}

describe("immutable queue payload and positive publication proof", () => {
  it("binds all optional fields, focus presence and canonical bytes", () => {
    expect(verifyScanQueuePayload(input, identity.payloadDigest, scan).focus).toBe("payments")
    const changed = buildScanQueuePayload(scan, "auth")
    expect(() => verifyScanQueuePayload(changed, identity.payloadDigest, scan)).toThrow()
    const noFocus = buildScanQueuePayload(scan)
    expect(noFocus).not.toBe(input)
    expect(() =>
      verifyScanQueuePayload(input, identity.payloadDigest, { ...scan, policyId: "policy-1" })
    ).toThrow()
  })
  it.each([
    null,
    "",
    "{}",
    input.replace('"scanId":"scan-1"', '"scanId":"scan-1","scanId":"scan-1"'),
  ])("rejects absent or malformed immutable payload bytes (%s)", (value) => {
    expect(() =>
      verifyScanQueuePayload(value, value ? scanQueueDigest(value) : identity.payloadDigest, scan)
    ).toThrow()
  })
  it("rejects oversized and unknown transport fields", () => {
    expect(() => buildScanQueuePayload({ ...scan, id: "x".repeat(5000) })).toThrow()
    const unknown = JSON.stringify({ ...snapshot.data, payerId: "attacker" })
    expect(() => verifyScanQueuePayload(unknown, scanQueueDigest(unknown), scan)).toThrow()
  })
  it("verifies exact positive proof and rejects identity or receipt-byte drift", () => {
    const proof = createScanQueuePublicationProof(identity, input, snapshot)
    expect(verifyScanQueuePublicationProof(identity, proof.input, proof.checksum).jobId).toBe(
      scan.id
    )
    expect(() =>
      verifyScanQueuePublicationProof(
        { ...identity, operationId: "foreign" },
        proof.input,
        proof.checksum
      )
    ).toThrow()
    expect(() =>
      verifyScanQueuePublicationProof(identity, proof.input + " ", proof.checksum)
    ).toThrow()
  })
  it.each([
    null,
    { ...snapshot, id: "foreign" },
    { ...snapshot, queueName: "foreign" },
    { ...snapshot, data: { ...snapshot.data, focus: "auth" } },
    { ...snapshot, state: "unknown" },
  ])("never treats absence or a spoofed queue snapshot as positive proof", (value) => {
    expect(() => createScanQueuePublicationProof(identity, input, value)).toThrow()
  })
})

describe("closed queue dispatcher and uncertain acknowledgements", () => {
  let row: QueueOutboxRow
  const scope = { workspaceId: "ws-1", operationId: "op-1" }
  const pool = Object.create(null) as pg.Pool
  beforeEach(() => {
    vi.resetAllMocks()
    row = {
      ...scan,
      ...identity,
      payloadInputJson: input,
      publicationReceiptInputJson: null,
      publicationReceiptChecksum: null,
      state: "PENDING",
      operationState: "QUEUED",
      live: true,
      requestDigest: "a".repeat(64),
      currentScopeDigest: "a".repeat(64),
      leaseOwner: null,
      leaseExpiresAt: null,
      leaseLive: false,
      executionPlan: plan,
      executionPlanHash: computeScanExecutionPlanHash(plan),
    }
    // The store already qualified the admitted plan before returning its lease.
    store.claim.mockResolvedValue({ kind: "leased", row, token: "token-1" })
    store.unknown.mockResolvedValue({ kind: "unknown", reasonCode: "QUEUE_READBACK_UNKNOWN" })
    store.confirm.mockResolvedValue({ kind: "published", row })
  })
  it("defaults closed, including its consumer fence", async () => {
    const transport = { publish: vi.fn(), read: vi.fn() }
    const dispatcher = createScanQueueOutboxDispatcher({ pool: pool, transport })
    expect(await dispatcher.dispatch(scope)).toEqual({ kind: "closed" })
    expect(await dispatcher.verifyDispatch(scope, snapshot)).toEqual({ kind: "closed" })
    expect(store.claim).not.toHaveBeenCalled()
    expect(transport.publish).not.toHaveBeenCalled()
  })
  it("does not deliver after a lost database lease COMMIT acknowledgement", async () => {
    store.claim.mockResolvedValue({ kind: "unknown", reasonCode: "QUEUE_DB_COMMIT_UNKNOWN" })
    const transport = { publish: vi.fn(), read: vi.fn() }
    expect(
      (
        await createScanQueueOutboxDispatcher({
          pool: pool,
          transport,
          mode: "qualification",
        }).dispatch(scope)
      ).kind
    ).toBe("unknown")
    expect(transport.publish).not.toHaveBeenCalled()
    expect(transport.read).not.toHaveBeenCalled()
  })
  it("recovers UNKNOWN only from positive readback, without another enqueue", async () => {
    store.claim.mockResolvedValue({ kind: "recoverable", row })
    const transport = { publish: vi.fn(), read: vi.fn().mockResolvedValue(snapshot) }
    const result = await createScanQueueOutboxDispatcher({
      pool: pool,
      transport,
      mode: "qualification",
    }).dispatch(scope)
    expect(result.kind).toBe("published")
    expect(transport.publish).not.toHaveBeenCalled()
    expect(store.confirm).toHaveBeenCalledWith(scope, row, null, expect.any(Object))
  })
  it("keeps a negative UNKNOWN readback quarantined", async () => {
    store.claim.mockResolvedValue({ kind: "recoverable", row })
    const transport = { publish: vi.fn(), read: vi.fn().mockResolvedValue(null) }
    const result = await createScanQueueOutboxDispatcher({
      pool: pool,
      transport,
      mode: "qualification",
    }).dispatch(scope)
    expect(result.kind).toBe("unknown")
    expect(transport.publish).not.toHaveBeenCalled()
    expect(store.confirm).not.toHaveBeenCalled()
  })
  it("bounds a lost enqueue acknowledgement and never republishes after timeout", async () => {
    vi.useFakeTimers()
    try {
      const transport = {
        publish: vi.fn(() => new Promise<string>(() => undefined)),
        read: vi.fn().mockResolvedValue(null),
      }
      const pending = createScanQueueOutboxDispatcher({
        pool,
        transport,
        mode: "qualification",
        transportTimeoutMs: 50,
      }).dispatch(scope)
      await vi.advanceTimersByTimeAsync(60)
      expect((await pending).kind).toBe("unknown")
      expect(transport.publish).toHaveBeenCalledTimes(1)
      expect(store.unknown).toHaveBeenCalledWith(scope, "token-1", "QUEUE_ENQUEUE_ACK_UNKNOWN")
      expect(store.confirm).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
