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
import { updateFindingStatus } from "./finding-service"

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
})
