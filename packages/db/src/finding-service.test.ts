import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./client", () => ({
  prisma: {
    scan: { findFirst: vi.fn() },
    target: { findFirst: vi.fn() },
    finding: { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    evidence: { findMany: vi.fn(), count: vi.fn() },
    findingVerification: { findMany: vi.fn(), count: vi.fn() },
    fixProposal: { findMany: vi.fn(), count: vi.fn() },
    retest: { findMany: vi.fn(), count: vi.fn() },
  },
}))

vi.mock("@lyrashield/logger", () => ({
  logger: { info: vi.fn() },
}))

import { prisma } from "./client"
import {
  acceptRisk,
  getFinding,
  getFindingHistoryPage,
  listEvidenceFindings,
  listFindings,
  markFalsePositive,
  updateFindingStatus,
  validateFindingScope,
} from "./finding-service"

describe("validateFindingScope", () => {
  beforeEach(() => vi.clearAllMocks())

  it("requires a workspace-owned target and scan with matching target identity", async () => {
    vi.mocked(prisma.target.findFirst).mockResolvedValue({
      id: "target-1",
      name: "Production",
    } as never)
    vi.mocked(prisma.scan.findFirst).mockResolvedValue({
      id: "scan-1",
      targetId: "target-1",
    } as never)

    const result = await validateFindingScope({
      workspaceId: "workspace-1",
      targetId: "target-1",
      observedInScanId: "scan-1",
    })

    expect(result).toEqual({
      available: true,
      target: { id: "target-1", name: "Production" },
      scanId: "scan-1",
    })
    expect(prisma.target.findFirst).toHaveBeenCalledWith({
      where: { id: "target-1", workspaceId: "workspace-1", deletedAt: null },
      select: { id: true, name: true },
    })
    expect(prisma.scan.findFirst).toHaveBeenCalledWith({
      where: {
        id: "scan-1",
        workspaceId: "workspace-1",
        deletedAt: null,
        targetId: "target-1",
      },
      select: { id: true, targetId: true },
    })
  })

  it("fails closed when either workspace-owned scope row is unavailable", async () => {
    vi.mocked(prisma.target.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.scan.findFirst).mockResolvedValue(null)

    await expect(
      validateFindingScope({
        workspaceId: "workspace-1",
        targetId: "foreign-target",
        observedInScanId: "foreign-scan",
      })
    ).resolves.toEqual({ available: false, target: null, scanId: null })
  })
})

describe("getFinding", () => {
  beforeEach(() => vi.clearAllMocks())

  it("returns retest receipt identity without exposing raw storage URIs", async () => {
    vi.mocked(prisma.finding.findFirst).mockResolvedValue({
      id: "finding-1",
      evidence: [{ id: "evidence-1", type: "finding", redactionStatus: "complete" }],
      verificationReceipts: [
        {
          id: "receipt-1",
          status: "VALIDATED",
          method: "RETEST",
          reason: "Deterministic clean retest",
          scanId: "scan-2",
          sourceRevision: "a".repeat(40),
          verifierVersion: "result-integrity-v3",
          evidence: { retestId: "retest-1" },
          createdAt: new Date(),
        },
      ],
      fixProposals: [],
      retests: [],
      _count: { evidence: 1, verificationReceipts: 1, fixProposals: 0, retests: 0 },
    } as never)

    const finding = await getFinding("finding-1", "workspace-1")

    expect(prisma.finding.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "finding-1", workspaceId: "workspace-1", deletedAt: null },
        include: expect.objectContaining({
          evidence: expect.objectContaining({
            select: { id: true, type: true, redactionStatus: true, createdAt: true },
            take: 26,
          }),
          verificationReceipts: expect.objectContaining({
            select: expect.objectContaining({
              scanId: true,
              sourceRevision: true,
              verifierVersion: true,
              evidence: true,
            }),
          }),
        }),
      })
    )
    const serialized = JSON.stringify(finding)
    expect(serialized).not.toContain("storageUri")
    expect(serialized).not.toContain("s3://")
    expect(serialized).toContain('"sourceRevision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"')
  })

  it.each([100_000])("returns a bounded initial history preview for %i records", async (total) => {
    const createdAt = new Date("2026-09-07T00:00:00Z")
    vi.mocked(prisma.finding.findFirst).mockResolvedValue({
      id: "finding-1",
      evidence: Array.from({ length: 26 }, (_, index) => ({
        id: `evidence-${index}`,
        type: "finding",
        redactionStatus: "complete",
        createdAt,
      })),
      verificationReceipts: [],
      fixProposals: [],
      retests: [],
      _count: { evidence: total, verificationReceipts: 0, fixProposals: 0, retests: 0 },
    } as never)

    const finding = await getFinding("finding-1", "workspace-1")

    expect(finding?.evidence).toHaveLength(25)
    expect(finding?.historyPagination.evidence.total).toBe(total)
    expect(finding?.historyPagination.evidence.nextCursor).toBeTruthy()
  })
})

describe("getFindingHistoryPage", () => {
  beforeEach(() => vi.clearAllMocks())

  it("binds evidence rows and counts to the finding's workspace", async () => {
    vi.mocked(prisma.finding.findFirst).mockResolvedValue({ id: "finding-1" } as never)
    vi.mocked(prisma.evidence.findMany).mockResolvedValue([])
    vi.mocked(prisma.evidence.count).mockResolvedValue(0)

    await getFindingHistoryPage("finding-1", "workspace-1", "evidence")

    expect(prisma.evidence.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          findingId: "finding-1",
          finding: { workspaceId: "workspace-1" },
        }),
      })
    )
    expect(prisma.evidence.count).toHaveBeenCalledWith({
      where: {
        findingId: "finding-1",
        finding: { workspaceId: "workspace-1" },
        redactionStatus: { not: "deleted" },
      },
    })
  })

  it("binds fix proposal rows and counts to the finding's workspace", async () => {
    vi.mocked(prisma.finding.findFirst).mockResolvedValue({ id: "finding-1" } as never)
    vi.mocked(prisma.fixProposal.findMany).mockResolvedValue([])
    vi.mocked(prisma.fixProposal.count).mockResolvedValue(0)

    await getFindingHistoryPage("finding-1", "workspace-1", "fixProposals")

    expect(prisma.fixProposal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          findingId: "finding-1",
          finding: { workspaceId: "workspace-1" },
          deletedAt: null,
        },
      })
    )
    expect(prisma.fixProposal.count).toHaveBeenCalledWith({
      where: {
        findingId: "finding-1",
        finding: { workspaceId: "workspace-1" },
        deletedAt: null,
      },
    })
  })

  it("uses a stable createdAt/id cursor and caps pages at 100", async () => {
    vi.mocked(prisma.finding.findFirst).mockResolvedValue({ id: "finding-1" } as never)
    vi.mocked(prisma.evidence.findMany).mockResolvedValue(
      Array.from({ length: 101 }, (_, index) => ({
        id: `evidence-${String(100 - index).padStart(3, "0")}`,
        type: "finding",
        redactionStatus: "complete",
        createdAt: new Date("2026-09-07T00:00:00Z"),
      })) as never
    )
    vi.mocked(prisma.evidence.count).mockResolvedValue(100000)

    const first = await getFindingHistoryPage("finding-1", "workspace-1", "evidence", {
      limit: 1000,
    })
    expect(first.items).toHaveLength(100)
    expect(first.total).toBe(100000)
    expect(first.nextCursor).toBeTruthy()

    vi.mocked(prisma.evidence.findMany).mockResolvedValue([])
    await getFindingHistoryPage("finding-1", "workspace-1", "evidence", {
      cursor: first.nextCursor!,
    })
    expect(prisma.evidence.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          findingId: "finding-1",
          OR: expect.any(Array),
        }),
      })
    )
  })

  it("rejects a cursor bound to another finding", async () => {
    vi.mocked(prisma.finding.findFirst).mockResolvedValue({ id: "finding-1" } as never)
    vi.mocked(prisma.evidence.findMany).mockResolvedValue([
      ...Array.from({ length: 26 }, (_, index) => ({
        id: `evidence-${index}`,
        type: "finding",
        redactionStatus: "complete",
        createdAt: new Date("2026-09-07T00:00:00Z"),
      })),
    ] as never)
    vi.mocked(prisma.evidence.count).mockResolvedValue(26)
    const first = await getFindingHistoryPage("finding-1", "workspace-1", "evidence")

    await expect(
      getFindingHistoryPage("finding-2", "workspace-1", "evidence", {
        cursor: first.nextCursor!,
      })
    ).rejects.toThrow("Invalid finding history cursor")
  })
})

describe("listFindings", () => {
  beforeEach(() => vi.clearAllMocks())

  it("selects the target environment for contextual priority and keeps the workspace scope", async () => {
    vi.mocked(prisma.finding.findMany).mockResolvedValue([] as never)

    await listFindings({ workspaceId: "workspace-1" })

    expect(prisma.finding.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ workspaceId: "workspace-1", deletedAt: null }),
        orderBy: [{ severity: "desc" }, { createdAt: "desc" }, { id: "desc" }],
        take: 51,
        include: expect.objectContaining({
          target: { select: { id: true, name: true, type: true, environment: true } },
        }),
      })
    )
  })

  it("keeps the limit bounded at 100 and derives the cursor from the original order", async () => {
    vi.mocked(prisma.finding.findMany).mockResolvedValue(
      Array.from({ length: 101 }, (_, index) => ({ id: `finding-${index}` })) as never
    )

    const result = await listFindings({ workspaceId: "workspace-1", limit: 1000 })

    expect(prisma.finding.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 101 }))
    expect(result.items).toHaveLength(100)
    expect(result.nextCursor).toBe("finding-99")
  })

  it("passes the cursor through and skips the cursor row", async () => {
    vi.mocked(prisma.finding.findMany).mockResolvedValue([{ id: "finding-50" }] as never)

    await listFindings({ workspaceId: "workspace-1", cursor: "finding-49" })

    expect(prisma.finding.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: { id: "finding-49" }, skip: 1 })
    )
  })

  it("returns a null cursor when no further page exists", async () => {
    vi.mocked(prisma.finding.findMany).mockResolvedValue([{ id: "finding-1" }] as never)

    const result = await listFindings({ workspaceId: "workspace-1", limit: 100 })

    expect(result.items).toHaveLength(1)
    expect(result.nextCursor).toBeNull()
  })

  it("keeps origin scan and observed scan as independent filters", async () => {
    vi.mocked(prisma.finding.findMany).mockResolvedValue([] as never)

    await listFindings({
      workspaceId: "workspace-1",
      targetId: "target-1",
      scanId: "origin-scan",
      observedInScanId: "later-scan",
    })

    expect(prisma.finding.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          workspaceId: "workspace-1",
          deletedAt: null,
          targetId: "target-1",
          candidates: {
            some: {
              workspaceId: "workspace-1",
              scanId: "later-scan",
              targetId: "target-1",
            },
          },
          scanId: "origin-scan",
        },
      })
    )
  })

  it("paginates evidence only after redaction and never selects storage URIs", async () => {
    vi.mocked(prisma.finding.findMany).mockResolvedValue(
      Array.from({ length: 26 }, (_, index) => ({ id: `finding-${index}` })) as never
    )

    const result = await listEvidenceFindings({
      workspaceId: "workspace-1",
      targetId: "target-1",
      observedInScanId: "scan-1",
      limit: 25,
    })

    expect(result.items).toHaveLength(25)
    expect(result.nextCursor).toBe("finding-24")
    expect(prisma.finding.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          workspaceId: "workspace-1",
          deletedAt: null,
          targetId: "target-1",
          candidates: {
            some: {
              workspaceId: "workspace-1",
              scanId: "scan-1",
              targetId: "target-1",
            },
          },
          verified: true,
          evidence: { some: { redactionStatus: "complete" } },
        },
        select: expect.objectContaining({
          evidence: expect.objectContaining({
            where: { redactionStatus: "complete" },
            select: { type: true, createdAt: true },
          }),
        }),
      })
    )
    expect(JSON.stringify(prisma.finding.findMany.mock.calls.at(-1))).not.toContain("storageUri")
  })
})

describe("updateFindingStatus", () => {
  beforeEach(() => vi.clearAllMocks())

  it("keeps a manually claimed fix pending a server-owned retest", async () => {
    vi.mocked(prisma.finding.findFirst).mockResolvedValue({ id: "finding-1" } as never)
    vi.mocked(prisma.finding.update).mockResolvedValue({
      id: "finding-1",
      status: "FIXED_PENDING_RETEST",
    } as never)

    await updateFindingStatus("finding-1", "workspace-1", "FIXED")

    expect(prisma.finding.update).toHaveBeenCalledWith({
      where: { id: "finding-1" },
      data: {
        status: "FIXED_PENDING_RETEST",
        fixedAt: expect.any(Date),
      },
    })
  })

  it("persists an optional statusReason", async () => {
    vi.mocked(prisma.finding.findFirst).mockResolvedValue({ id: "finding-1" } as never)
    vi.mocked(prisma.finding.update).mockResolvedValue({
      id: "finding-1",
      status: "ACCEPTED_RISK",
    } as never)

    await updateFindingStatus(
      "finding-1",
      "workspace-1",
      "ACCEPTED_RISK",
      "Accepted by security lead"
    )

    expect(prisma.finding.update).toHaveBeenCalledWith({
      where: { id: "finding-1" },
      data: {
        status: "ACCEPTED_RISK",
        statusReason: "Accepted by security lead",
      },
    })
  })

  it("passes reason through acceptRisk", async () => {
    vi.mocked(prisma.finding.findFirst).mockResolvedValue({ id: "finding-1" } as never)
    vi.mocked(prisma.finding.update).mockResolvedValue({
      id: "finding-1",
      status: "ACCEPTED_RISK",
    } as never)

    await acceptRisk("finding-1", "workspace-1", "Risk accepted per SLA")

    expect(prisma.finding.update).toHaveBeenCalledWith({
      where: { id: "finding-1" },
      data: {
        status: "ACCEPTED_RISK",
        statusReason: "Risk accepted per SLA",
      },
    })
  })

  it("passes reason through markFalsePositive", async () => {
    vi.mocked(prisma.finding.findFirst).mockResolvedValue({ id: "finding-1" } as never)
    vi.mocked(prisma.finding.update).mockResolvedValue({
      id: "finding-1",
      status: "FALSE_POSITIVE",
    } as never)

    await markFalsePositive("finding-1", "workspace-1", "Confirmed test artifact")

    expect(prisma.finding.update).toHaveBeenCalledWith({
      where: { id: "finding-1" },
      data: {
        status: "FALSE_POSITIVE",
        statusReason: "Confirmed test artifact",
      },
    })
  })

  it("binds a human disposition to the finding's source assessment", async () => {
    vi.mocked(prisma.finding.findFirst).mockResolvedValue({
      id: "finding-1",
      scanId: "scan-1",
    } as never)
    vi.mocked(prisma.finding.update).mockResolvedValue({
      id: "finding-1",
      scanId: "scan-1",
    } as never)

    await acceptRisk("finding-1", "workspace-1", "Accepted by owner", "user-1")

    expect(prisma.finding.update).toHaveBeenCalledWith({
      where: { id: "finding-1" },
      data: expect.objectContaining({
        disposition: "ACCEPTED_RISK",
        dispositionActorUserId: "user-1",
        dispositionAssessmentId: "scan-1",
        dispositionAt: expect.any(Date),
      }),
    })
  })

  it("requires a same-target canonical finding for a duplicate", async () => {
    vi.mocked(prisma.finding.findFirst)
      .mockResolvedValueOnce({ id: "finding-1", targetId: "target-1" } as never)
      .mockResolvedValueOnce(null)

    await expect(
      updateFindingStatus("finding-1", "workspace-1", "DUPLICATE", undefined, "finding-2")
    ).rejects.toThrow("Canonical finding not found on this target")
    expect(prisma.finding.update).not.toHaveBeenCalled()
  })
})
