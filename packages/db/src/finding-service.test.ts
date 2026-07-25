import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./client", () => ({
  prisma: {
    finding: { findFirst: vi.fn(), update: vi.fn() },
  },
}))

vi.mock("@lyrashield/logger", () => ({
  logger: { info: vi.fn() },
}))

import { prisma } from "./client"
import { acceptRisk, markFalsePositive, updateFindingStatus } from "./finding-service"

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
