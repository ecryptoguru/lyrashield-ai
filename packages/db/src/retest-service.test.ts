import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("./client", () => ({
  prisma: {
    retest: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    finding: {
      findFirst: vi.fn(),
    },
    scan: {
      findFirst: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
  },
}))

import { prisma } from "./client"
import { createRetest, getRetest, listRetests, updateRetestStatus } from "./retest-service"

const mockPrisma = prisma as unknown as {
  retest: {
    create: ReturnType<typeof vi.fn>
    findFirst: ReturnType<typeof vi.fn>
    findMany: ReturnType<typeof vi.fn>
    update: ReturnType<typeof vi.fn>
  }
}

const baseRetest = {
  id: "retest-1",
  workspaceId: "ws-1",
  findingId: "finding-1",
  scanId: "scan-1",
  status: "pending",
  resultBefore: null,
  resultAfter: null,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
}

const baseFinding = { id: "finding-1", title: "XSS", severity: "HIGH", status: "OPEN" }
const baseScan = { id: "scan-1", status: "completed", summary: "Done" }

describe("retest-service", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe("createRetest", () => {
    it("creates a retest with pending status", async () => {
      mockPrisma.retest.create.mockResolvedValue(baseRetest)

      const result = await createRetest({
        workspaceId: "ws-1",
        findingId: "finding-1",
        scanId: "scan-1",
      })

      expect(result.status).toBe("pending")
      expect(mockPrisma.retest.create).toHaveBeenCalledWith({
        data: {
          workspaceId: "ws-1",
          findingId: "finding-1",
          scanId: "scan-1",
          status: "pending",
        },
      })
    })
  })

  describe("getRetest", () => {
    it("returns retest with finding and scan details", async () => {
      mockPrisma.retest.findFirst.mockResolvedValue({
        ...baseRetest,
        finding: baseFinding,
        scan: baseScan,
      })

      const result = await getRetest("retest-1", "ws-1")

      expect(result).not.toBeNull()
      expect(result?.finding.title).toBe("XSS")
      expect(result?.scan.status).toBe("completed")
      expect(mockPrisma.retest.findFirst).toHaveBeenCalledWith({
        where: { id: "retest-1", workspaceId: "ws-1" },
        include: {
          finding: { select: { id: true, title: true, severity: true, status: true } },
          scan: { select: { id: true, status: true, summary: true } },
        },
      })
    })

    it("returns null when retest not found", async () => {
      mockPrisma.retest.findFirst.mockResolvedValue(null)

      const result = await getRetest("nonexistent", "ws-1")

      expect(result).toBeNull()
    })
  })

  describe("listRetests", () => {
    it("lists retests with default limit", async () => {
      mockPrisma.retest.findMany.mockResolvedValue([
        { ...baseRetest, finding: baseFinding, scan: baseScan },
      ])

      const result = await listRetests({ workspaceId: "ws-1" })

      expect(result.items).toHaveLength(1)
      expect(result.nextCursor).toBeNull()
      expect(mockPrisma.retest.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { workspaceId: "ws-1" },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 21,
        })
      )
    })

    it("returns nextCursor when more results exist", async () => {
      const retests = Array.from({ length: 21 }, (_, i) => ({
        ...baseRetest,
        id: `retest-${i}`,
        finding: baseFinding,
        scan: baseScan,
      }))
      mockPrisma.retest.findMany.mockResolvedValue(retests)

      const result = await listRetests({ workspaceId: "ws-1", limit: 20 })

      expect(result.items).toHaveLength(20)
      expect(result.nextCursor).toBe("retest-19")
    })

    it("filters by findingId and status", async () => {
      mockPrisma.retest.findMany.mockResolvedValue([])

      await listRetests({ workspaceId: "ws-1", findingId: "finding-1", status: "passed" })

      expect(mockPrisma.retest.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            workspaceId: "ws-1",
            findingId: "finding-1",
            status: "passed",
          },
        })
      )
    })
  })

  describe("updateRetestStatus", () => {
    it("updates status when retest exists", async () => {
      mockPrisma.retest.findFirst.mockResolvedValue(baseRetest)
      mockPrisma.retest.update.mockResolvedValue({ ...baseRetest, status: "passed" })

      const result = await updateRetestStatus("retest-1", "ws-1", "passed")

      expect(result.status).toBe("passed")
      expect(mockPrisma.retest.update).toHaveBeenCalledWith({
        where: { id: "retest-1" },
        data: { status: "passed" },
      })
    })

    it("updates status with resultAfter", async () => {
      mockPrisma.retest.findFirst.mockResolvedValue(baseRetest)
      mockPrisma.retest.update.mockResolvedValue({
        ...baseRetest,
        status: "passed",
        resultAfter: "No issues found",
      })

      await updateRetestStatus("retest-1", "ws-1", "passed", "No issues found")

      expect(mockPrisma.retest.update).toHaveBeenCalledWith({
        where: { id: "retest-1" },
        data: { status: "passed", resultAfter: "No issues found" },
      })
    })

    it("throws when retest not found", async () => {
      mockPrisma.retest.findFirst.mockResolvedValue(null)

      await expect(updateRetestStatus("nonexistent", "ws-1", "passed")).rejects.toThrow(
        "Retest not found: nonexistent"
      )
    })

    it("throws on invalid status value", async () => {
      await expect(updateRetestStatus("retest-1", "ws-1", "hacked")).rejects.toThrow(
        "Invalid retest status: hacked"
      )
      expect(mockPrisma.retest.findFirst).not.toHaveBeenCalled()
    })
  })
})
