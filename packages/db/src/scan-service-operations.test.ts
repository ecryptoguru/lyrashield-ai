import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./client", () => ({
  prisma: {
    $transaction: vi.fn(),
    scan: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    scanEvent: { create: vi.fn() },
  },
}))

vi.mock("@lyrashield/logger", () => ({ logger: { info: vi.fn() } }))

import { prisma } from "./client"
import { createScan, getScanWithEvents, updateScanStatus } from "./scan-service"

const mockPrisma = prisma as unknown as {
  $transaction: ReturnType<typeof vi.fn>
  scan: { findUnique: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> }
  scanEvent: { create: ReturnType<typeof vi.fn> }
}

describe("updateScanStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.scanEvent.create.mockResolvedValue({ id: "event-1" })
  })

  it("does not overwrite a concurrent cancellation with a worker transition", async () => {
    mockPrisma.scan.findUnique
      .mockResolvedValueOnce({ id: "scan-1", status: "RUNNING", startedAt: new Date() })
      .mockResolvedValueOnce({
        id: "scan-1",
        status: "CANCELLED",
        startedAt: new Date(),
        endedAt: new Date(),
      })
    mockPrisma.scan.updateMany.mockResolvedValue({ count: 0 })

    await expect(updateScanStatus("scan-1", "VERIFYING")).rejects.toThrow("CANCELLED")
    expect(mockPrisma.scan.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "scan-1", status: "RUNNING" },
      })
    )
  })
})

describe("createScan", () => {
  it("rejects an invalid determinism mode before opening a transaction", async () => {
    await expect(
      createScan({
        workspaceId: "ws-1",
        targetId: "target-1",
        goal: "TEST_APP",
        createdById: "user-1",
        determinismMode: "invalid" as never,
      })
    ).rejects.toThrow()
    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
  })

  it("rejects a second active scan while holding the target lock", async () => {
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(undefined),
      scan: {
        count: vi.fn().mockResolvedValue(1),
        create: vi.fn(),
      },
    }
    mockPrisma.$transaction.mockImplementation(async (callback) => callback(tx))

    await expect(
      createScan({
        workspaceId: "ws-1",
        targetId: "target-1",
        goal: "TEST_APP",
        createdById: "user-1",
      })
    ).rejects.toThrow("Target already has an active scan")
    expect(tx.$executeRaw).toHaveBeenCalled()
    expect(tx.scan.create).not.toHaveBeenCalled()
  })
})

describe("getScanWithEvents", () => {
  it("retains the newest bounded events in chronological display order", async () => {
    mockPrisma.scan.findUnique.mockResolvedValue({
      id: "scan-1",
      events: [{ id: "new" }, { id: "old" }],
      resultManifest: null,
      coverageReceipts: [],
    })

    const scan = await getScanWithEvents("scan-1")

    expect(mockPrisma.scan.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          events: {
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: 200,
          },
        }),
      })
    )
    expect(scan?.events.map((event) => event.id)).toEqual(["old", "new"])
  })
})
