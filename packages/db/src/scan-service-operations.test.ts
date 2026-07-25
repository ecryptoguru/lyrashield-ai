import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./client", () => ({
  prisma: {
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
    scan: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
    scanEvent: { create: vi.fn(), findMany: vi.fn() },
    scanResultManifest: { findUnique: vi.fn() },
    scanCoverageReceipt: { findMany: vi.fn() },
  },
}))

vi.mock("@lyrashield/logger", () => ({ logger: { info: vi.fn() } }))

import { prisma } from "./client"
import { createScan, getScanWithEvents, listScans, updateScanStatus } from "./scan-service"

const mockPrisma = prisma as unknown as {
  $transaction: ReturnType<typeof vi.fn>
  scan: {
    findUnique: ReturnType<typeof vi.fn>
    findFirst: ReturnType<typeof vi.fn>
    findMany: ReturnType<typeof vi.fn>
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
  })

  it("retains the newest bounded events in chronological display order", async () => {
    // getScanWithEvents now uses a single findFirst with include, so the mock
    // must return the full nested shape that Prisma would resolve.
    mockPrisma.scan.findFirst.mockResolvedValue({
      id: "scan-1",
      events: [{ id: "new" }, { id: "old" }],
      resultManifest: null,
      coverageReceipts: [],
      target: null,
    })

    const scan = await getScanWithEvents("scan-1", "ws-1")

    expect(mockPrisma.scan.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "scan-1", workspaceId: "ws-1", deletedAt: null },
        include: expect.objectContaining({
          events: expect.objectContaining({
            where: { deletedAt: null },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: 200,
          }),
        }),
      })
    )
    // Events are reversed from desc to chronological order.
    expect(scan?.events.map((event) => event.id)).toEqual(["old", "new"])
  })

  it("projects only the manifest checksum, never the manifest blob", async () => {
    mockPrisma.scan.findFirst.mockResolvedValue({
      id: "scan-1",
      events: [],
      resultManifest: { checksum: "abc123" },
      coverageReceipts: [],
      target: null,
    })

    const scan = await getScanWithEvents("scan-1", "ws-1")

    // This shape is returned on every scan-detail poll; fetching the manifest's
    // Json column here would move tens of KB per tick for a field nothing reads.
    expect(mockPrisma.scan.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          resultManifest: { select: { checksum: true } },
        }),
      })
    )
    expect(scan?.resultManifest?.checksum).toBe("abc123")
  })

  it("does not query child records when the scoped scan is absent", async () => {
    mockPrisma.scan.findFirst.mockResolvedValue(null)

    await expect(getScanWithEvents("scan-1", "ws-1")).resolves.toBeNull()

    // With the include approach a single findFirst call is made;
    // separate relation queries are no longer issued.
    expect(mockPrisma.scanEvent.findMany).not.toHaveBeenCalled()
    expect(mockPrisma.scanResultManifest.findUnique).not.toHaveBeenCalled()
    expect(mockPrisma.scanCoverageReceipt.findMany).not.toHaveBeenCalled()
  })
})

describe("listScans", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // listScans runs inside withWorkspaceRLS, so the transaction must be driven
    // for the query to execute at all.
    mockPrisma.$transaction.mockImplementation(async (callback) => callback(mockPrisma))
    mockPrisma.$executeRaw.mockResolvedValue(1)
  })

  it("runs the query inside a workspace-RLS transaction", async () => {
    mockPrisma.scan.findMany.mockResolvedValue([])

    await listScans({ workspaceId: "ws-1" })

    // "Scan" is under FORCE ROW LEVEL SECURITY: the workspaceId predicate alone
    // is not the isolation boundary, the transaction-local context is.
    expect(mockPrisma.$transaction).toHaveBeenCalled()
    expect(mockPrisma.$executeRaw).toHaveBeenCalled()
  })

  it("selects a narrow list projection and flattens findingCount", async () => {
    mockPrisma.scan.findMany.mockResolvedValue([
      { id: "scan-1", status: "COMPLETED", _count: { findings: 3 }, target: null },
    ])

    const { items } = await listScans({ workspaceId: "ws-1" })

    // The Scan row carries ~10 further columns (LLM token counters, provider and
    // billed cost, risk scores) that no list surface renders; this query runs on
    // every scans-page load and active-scan poll tick, so it must stay projected.
    const args = mockPrisma.scan.findMany.mock.calls[0]![0]
    expect(args.select).toBeDefined()
    expect(args.include).toBeUndefined()
    expect(args.select.providerCostUsd).toBeUndefined()
    expect(args.select.llmInputTokens).toBeUndefined()

    // `_count` is flattened so API and SSR callers share one shape.
    expect(items[0]!.findingCount).toBe(3)
    expect("_count" in items[0]!).toBe(false)
  })

  it("treats a missing _count as zero findings", async () => {
    mockPrisma.scan.findMany.mockResolvedValue([{ id: "scan-1", target: null }])

    const { items } = await listScans({ workspaceId: "ws-1" })

    expect(items[0]!.findingCount).toBe(0)
  })
})
