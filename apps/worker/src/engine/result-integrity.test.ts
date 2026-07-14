import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@lyrashield/db", () => ({
  prisma: {
    scanResultManifest: { findUnique: vi.fn(), create: vi.fn() },
    scanCoverageReceipt: { createMany: vi.fn() },
    findingCandidate: { upsert: vi.fn() },
    findingVerification: { upsert: vi.fn() },
    finding: { update: vi.fn() },
    retest: { findMany: vi.fn(), update: vi.fn() },
  },
}))

import { prisma } from "@lyrashield/db"
import {
  buildCoverageReceipts,
  completeRetestsForScan,
  persistDetectionReceipt,
  persistResultManifest,
} from "./result-integrity"

describe("result integrity", () => {
  beforeEach(() => vi.clearAllMocks())

  it("records blocked source-scanner coverage instead of treating it as clean", () => {
    const receipts = buildCoverageReceipts({
      scanId: "scan-1",
      target: { id: "target-1", type: "REPO", repoFullName: "acme/app" },
      sourceCheckoutAvailable: true,
      engineFindingCount: 2,
      coverageIssues: [{ scanner: "sca", status: "unsupported", reason: "Lockfile unavailable" }],
    })

    expect(receipts.find((receipt) => receipt.scanner === "sca")).toMatchObject({
      status: "BLOCKED",
      reason: "Lockfile unavailable",
    })
    expect(receipts.find((receipt) => receipt.scanner === "secrets")).toMatchObject({
      status: "COMPLETED",
    })
  })

  it("stores a manifest once and uses idempotent coverage receipts", async () => {
    vi.mocked(prisma.scanResultManifest.findUnique).mockResolvedValue(null)

    await persistResultManifest({
      scanId: "scan-1",
      target: { id: "target-1", type: "URL", url: "https://example.com" },
      sourceCheckoutAvailable: false,
      engineFindingCount: 0,
      coverageIssues: [],
    })

    expect(prisma.scanResultManifest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ scanId: "scan-1", checksum: expect.any(String) }),
      })
    )
    expect(prisma.scanCoverageReceipt.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true })
    )
  })

  it("never stores raw PoC content in a detection ledger payload", async () => {
    vi.mocked(prisma.findingCandidate.upsert).mockResolvedValue({ id: "candidate-1" } as never)

    await persistDetectionReceipt({
      scanId: "scan-1",
      workspaceId: "workspace-1",
      targetId: "target-1",
      findingId: "finding-1",
      severity: "HIGH",
      dedupeKey: "dedupe-1",
      finding: {
        id: "engine-1",
        title: "Potential injection",
        severity: "high",
        timestamp: "2026-07-14T00:00:00Z",
        poc_script_code: "secret=do-not-store",
        code_locations: [{ file: "src/api.ts", start_line: 10, snippet: "secret" }],
      },
    })

    const call = vi.mocked(prisma.findingCandidate.upsert).mock.calls[0]?.[0]
    expect(JSON.stringify(call)).not.toContain("do-not-store")
    expect(JSON.stringify(call)).not.toContain('"snippet"')
    expect(prisma.findingVerification.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ status: "DETECTED" }) })
    )
  })

  it("marks a completed deterministic retest as validated, not independently verified", async () => {
    vi.mocked(prisma.retest.findMany).mockResolvedValue([
      {
        id: "retest-1",
        findingId: "finding-1",
        finding: { id: "finding-1", candidates: [{ scannerSource: "secrets" }] },
      },
    ] as never)

    await completeRetestsForScan({
      scanId: "scan-2",
      workspaceId: "workspace-1",
      persistedFindingIds: [],
      coverageIssues: [],
    })

    expect(prisma.finding.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          verified: false,
          verificationStatus: "VALIDATED",
          verificationMethod: "RETEST",
        }),
      })
    )
    expect(prisma.findingVerification.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ status: "VALIDATED" }) })
    )
  })

  it("leaves engine-only retests inconclusive rather than treating absence as proof", async () => {
    vi.mocked(prisma.retest.findMany).mockResolvedValue([
      {
        id: "retest-1",
        findingId: "finding-1",
        finding: { id: "finding-1", candidates: [{ scannerSource: "engine" }] },
      },
    ] as never)

    await completeRetestsForScan({
      scanId: "scan-2",
      workspaceId: "workspace-1",
      persistedFindingIds: [],
      coverageIssues: [],
    })

    expect(prisma.finding.update).not.toHaveBeenCalled()
    expect(prisma.retest.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "inconclusive" }) })
    )
  })
})
