import { createHash } from "node:crypto"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./client", () => ({ prisma: { $transaction: vi.fn() } }))
vi.mock("./extension", () => ({ getWorkspaceContext: () => null }))
vi.mock("@lyrashield/logger", () => ({ logger: { info: vi.fn() } }))

import { prisma } from "./client"
import { createScan } from "./scan-service"
import { hashDelegatedAdmissionProof } from "./agent-operation-hash"
import type { CreateScanParams } from "./scan-service-types"

const params: CreateScanParams = {
  workspaceId: "ws-1",
  targetId: "target-1",
  goal: "TEST_APP",
  mode: "STANDARD",
  createdById: "user-1",
}

function makeTx() {
  return {
    $executeRaw: vi.fn().mockResolvedValue(undefined),
    $queryRaw: vi.fn().mockResolvedValue([{ requestDigest: "a".repeat(64) }]),
    userScanSlot: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn() },
    scanCapacityReservation: { create: vi.fn() },
    target: { findFirst: vi.fn().mockResolvedValue({ id: "target-1", type: "REPO" }) },
    workspace: { findUnique: vi.fn().mockResolvedValue({ agencySponsorAccountId: "sponsor-1" }) },
    scan: {
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockImplementation(async ({ data }) => ({ id: "scan-1", ...data })),
    },
    scanEvent: { create: vi.fn() },
    scanDispatchOperation: {
      create: vi.fn().mockResolvedValue({ operationId: "dispatch-1" }),
      update: vi.fn(),
    },
    scanQueueOutbox: { create: vi.fn() },
    agentOperation: {
      findFirst: vi.fn().mockResolvedValue({
        id: "delegated-1",
        inputHash: "input-hash",
        admissionProofHash: hashDelegatedAdmissionProof("server-proof"),
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    delegatedScanProvenance: { create: vi.fn() },
  }
}

describe("internal shadow dispatch admission", () => {
  beforeEach(() => vi.clearAllMocks())

  it("keeps default admission unchanged and ignores request fields that resemble internal options", async () => {
    const tx = makeTx()
    await createScan({ ...params, dispatchAuthority: "shadow" } as CreateScanParams, tx as never)
    expect(tx.scanDispatchOperation.create).not.toHaveBeenCalled()
    expect(tx.scanQueueOutbox.create).not.toHaveBeenCalled()
    expect(tx.$queryRaw).not.toHaveBeenCalled()
  })

  it.each(["manual", "scheduled", "api", "agent", "retest"])(
    "records and quarantines %s admission in its caller's transaction",
    async (triggerType) => {
      const tx = makeTx()
      const scan = await createScan({ ...params, triggerType }, tx as never, {
        dispatchAuthority: "shadow",
      })
      expect(prisma.$transaction).not.toHaveBeenCalled()
      expect(scan.id).toBe("scan-1")
      expect(tx.scanDispatchOperation.create).toHaveBeenCalledWith({
        data: {
          scanId: "scan-1",
          workspaceId: "ws-1",
          protocolVersion: 3,
          requestDigest: "a".repeat(64),
          state: "QUEUED",
        },
      })
      expect(tx.scanDispatchOperation.update).toHaveBeenCalledWith({
        where: { operationId: "dispatch-1", scanId: "scan-1", workspaceId: "ws-1" },
        data: { state: "UNKNOWN" },
      })
      expect(tx.scanQueueOutbox.create).toHaveBeenCalledWith({
        data: {
          scanId: "scan-1",
          operationId: "dispatch-1",
          jobId: "scan-1",
          payloadInputJson: JSON.stringify({
            scanId: "scan-1",
            workspaceId: "ws-1",
            targetId: "target-1",
            goal: "TEST_APP",
            mode: "STANDARD",
          }),
          payloadDigest: createHash("sha256")
            .update(
              JSON.stringify({
                scanId: "scan-1",
                workspaceId: "ws-1",
                targetId: "target-1",
                goal: "TEST_APP",
                mode: "STANDARD",
              })
            )
            .digest("hex"),
          state: "UNKNOWN",
          lastErrorCode: "SHADOW_ADMISSION_CLOSED",
        },
      })
      expect(tx.scanEvent.create.mock.invocationCallOrder[0]).toBeLessThan(
        tx.$queryRaw.mock.invocationCallOrder[0]!
      )
      expect(tx.scanCapacityReservation.create.mock.invocationCallOrder[0]).toBeLessThan(
        tx.scanDispatchOperation.create.mock.invocationCallOrder[0]!
      )
      const [sql, ...values] = tx.$queryRaw.mock.calls[0]!
      expect(String(sql)).toContain("app.scan_dispatch_scope_digest")
      expect(values).toEqual(["scan-1", "scan-1", "ws-1"])
      expect(
        tx.$executeRaw.mock.calls.some(
          ([sql, accountId]) =>
            String(sql).includes("app.current_account_id") && accountId === "sponsor-1"
        )
      ).toBe(true)
    }
  )

  it.each(["scan.create", "retest.create"] as const)(
    "preserves separate delegated %s operation provenance",
    async (operationName) => {
      const tx = makeTx()
      await createScan(
        {
          ...params,
          delegatedConnection: { connectionId: "conn-1", authorizationVersion: 3 },
          delegatedOperation: {
            operationId: "delegated-1",
            operationName,
            admissionProof: "server-proof",
            connectionId: "conn-1",
            authorizationVersion: 3,
          },
        },
        tx as never,
        { dispatchAuthority: "shadow" }
      )
      expect(tx.agentOperation.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: "delegated-1", operationName }),
          data: { resultReference: "scan-1" },
        })
      )
      expect(tx.delegatedScanProvenance.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ operationId: "delegated-1", scanId: "scan-1" }),
        })
      )
      expect(tx.scanDispatchOperation.create.mock.calls[0]![0].data).not.toHaveProperty(
        "operationId"
      )
      expect(tx.scanQueueOutbox.create.mock.calls[0]![0].data.operationId).toBe("dispatch-1")
      expect(tx.delegatedScanProvenance.create.mock.invocationCallOrder[0]).toBeLessThan(
        tx.$queryRaw.mock.invocationCallOrder[0]!
      )
    }
  )

  it.each([[], [{ requestDigest: null }], [{ requestDigest: "invalid" }]])(
    "fails admission if the scoped SQL digest is unavailable or malformed (%j)",
    async (rows) => {
      const tx = makeTx()
      tx.$queryRaw.mockResolvedValue(rows)
      await expect(
        createScan(params, tx as never, { dispatchAuthority: "shadow" })
      ).rejects.toThrow()
      expect(tx.scanDispatchOperation.create).not.toHaveBeenCalled()
      expect(tx.scanQueueOutbox.create).not.toHaveBeenCalled()
    }
  )

  it("propagates outbox failure from the same admission transaction", async () => {
    const tx = makeTx()
    tx.scanQueueOutbox.create.mockRejectedValue(new Error("outbox insert denied"))
    vi.mocked(prisma.$transaction).mockImplementation(
      async (callback: never) => (callback as (value: unknown) => Promise<unknown>)(tx) as never
    )
    await expect(createScan(params, undefined, { dispatchAuthority: "shadow" })).rejects.toThrow(
      "outbox insert denied"
    )
    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
  })

  it("rejects an unimplemented enforced mode before opening a transaction", async () => {
    await expect(
      createScan(params, undefined, { dispatchAuthority: "enforced" } as never)
    ).rejects.toThrow()
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })
})
