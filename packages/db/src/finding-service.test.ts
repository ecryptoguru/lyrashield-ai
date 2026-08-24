import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./client", () => ({
  prisma: {
    finding: { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn() },
  },
}))

vi.mock("@lyrashield/logger", () => ({
  logger: { info: vi.fn() },
}))

import { prisma } from "./client"
import {
  acceptRisk,
  listFindings,
  markFalsePositive,
  updateFindingStatus,
} from "./finding-service"

describe("listFindings", () => {
  beforeEach(() => vi.clearAllMocks())

  it("selects the target environment for contextual priority and keeps the workspace scope", async () => {
    vi.mocked(prisma.finding.findMany).mockResolvedValue([] as never)

    await listFindings({ workspaceId: "workspace-1" })

    expect(prisma.finding.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ workspaceId: "workspace-1", deletedAt: null }),
        orderBy: [{ severity: "desc" }, { createdAt: "desc" }],
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

    expect(prisma.finding.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 101 })
    )
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
})
