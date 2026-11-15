import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  retestFindMany: vi.fn(),
  retestUpdate: vi.fn(),
  verificationUpsert: vi.fn(),
}))

vi.mock("@lyrashield/db", () => ({
  prisma: {
    retest: { findMany: mocks.retestFindMany, update: mocks.retestUpdate },
    findingVerification: { upsert: mocks.verificationUpsert },
  },
  verifyStoredManifestChecksum: vi.fn(),
  withWorkspaceRLS: vi.fn(),
}))

import { inconclusiveRetestsForScan } from "./retest-completion"

const reason = "The original scan does not provide a complete deterministic baseline."

describe("inconclusive retest finalization", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.retestUpdate.mockResolvedValue({})
    mocks.verificationUpsert.mockResolvedValue({})
  })

  it("records an inconclusive verification instead of an internal error", async () => {
    mocks.retestFindMany.mockResolvedValue([
      { id: "retest-1", workspaceId: "ws-1", findingId: "finding-1" },
    ])
    await inconclusiveRetestsForScan("scan-1", reason)
    expect(mocks.verificationUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          status: "INCONCLUSIVE",
          method: "RETEST",
          reason,
          findingId: "finding-1",
          scanId: "scan-1",
        }),
      })
    )
    expect(mocks.retestUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "retest-1" },
        data: { status: "inconclusive", resultAfter: reason },
      })
    )
  })

  it("only settles retests that are still pending or running", async () => {
    mocks.retestFindMany.mockResolvedValue([])
    await inconclusiveRetestsForScan("scan-1", reason)
    expect(mocks.retestFindMany).toHaveBeenCalledWith({
      where: { scanId: "scan-1", status: { in: ["pending", "running"] } },
      select: { id: true, workspaceId: true, findingId: true },
    })
    expect(mocks.verificationUpsert).not.toHaveBeenCalled()
    expect(mocks.retestUpdate).not.toHaveBeenCalled()
  })
})
