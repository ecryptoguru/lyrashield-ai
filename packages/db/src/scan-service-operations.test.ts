import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./client", () => ({
  prisma: {
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
    scan: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
    scanEvent: { create: vi.fn(), findMany: vi.fn() },
    scanResultManifest: { findUnique: vi.fn() },
    scanCoverageReceipt: { findMany: vi.fn() },
  },
}))

vi.mock("@lyrashield/logger", () => ({ logger: { info: vi.fn() } }))

import { prisma } from "./client"
import { createScan, getScanWithEvents, updateScanStatus } from "./scan-service"

const mockPrisma = prisma as unknown as {
  $transaction: ReturnType<typeof vi.fn>
  scan: {
    findUnique: ReturnType<typeof vi.fn>
    findFirst: ReturnType<typeof vi.fn>
    updateMany: ReturnType<typeof vi.fn>
  }
  scanEvent: { create: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> }
  scanResultManifest: { findUnique: ReturnType<typeof vi.fn> }
  scanCoverageReceipt: { findMany: ReturnType<typeof vi.fn> }
}

describe("updateScanStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.$transaction.mockImplementation(async (callback) => callback(mockPrisma))
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
  beforeEach(() => {
    vi.clearAllMocks()
  })

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
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.$transaction.mockImplementation(async (callback) => callback(mockPrisma))
    mockPrisma.scanResultManifest.findUnique.mockResolvedValue(null)
    mockPrisma.scanCoverageReceipt.findMany.mockResolvedValue([])
  })

  it("retains the newest bounded events in chronological display order", async () => {
    mockPrisma.scan.findFirst.mockResolvedValue({ id: "scan-1" })
    mockPrisma.scanEvent.findMany.mockResolvedValue([{ id: "new" }, { id: "old" }])

    const scan = await getScanWithEvents("scan-1", "ws-1")

    expect(mockPrisma.scan.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "scan-1", workspaceId: "ws-1", deletedAt: null },
      })
    )
    expect(mockPrisma.scanEvent.findMany).toHaveBeenCalledWith({
      where: { scanId: "scan-1", deletedAt: null },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 200,
    })
    expect(scan?.events.map((event) => event.id)).toEqual(["old", "new"])
  })

  it("does not query child records when the scoped scan is absent", async () => {
    mockPrisma.scan.findFirst.mockResolvedValue(null)

    await expect(getScanWithEvents("scan-1", "ws-1")).resolves.toBeNull()

    expect(mockPrisma.scanEvent.findMany).not.toHaveBeenCalled()
    expect(mockPrisma.scanResultManifest.findUnique).not.toHaveBeenCalled()
    expect(mockPrisma.scanCoverageReceipt.findMany).not.toHaveBeenCalled()
  })
})
