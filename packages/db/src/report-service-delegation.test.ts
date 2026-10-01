import { beforeEach, describe, expect, it, vi } from "vitest"
import { LAUNCH_REPORT_PROVENANCE_VERSION } from "./launch-report-provenance"

/**
 * W0.3 — resolveReportDelegationTarget maps a persisted report to the target
 * it is bound to. `null` targetId means "cannot be attributed to one persisted
 * target" (workspace-wide scan, deleted scan/target, launch report without
 * verifiable provenance or a contradictory verdict binding). Callers must
 * treat that as requiring an all-targets delegated grant — never as "no check".
 */
vi.mock("./client", () => ({
  prisma: {
    report: { findFirst: vi.fn() },
    scan: { findFirst: vi.fn() },
    gateVerdict: { findFirst: vi.fn() },
  },
}))
vi.mock("./rls", () => ({
  withWorkspaceRLS: vi.fn(async (_workspaceId, fn) => fn((await import("./client")).prisma)),
}))
vi.mock("@lyrashield/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { prisma } from "./client"
import { resolveReportDelegationTarget } from "./report-service"

const reportFindFirst = vi.mocked(prisma.report.findFirst)
const scanFindFirst = vi.mocked(prisma.scan.findFirst)
const verdictFindFirst = vi.mocked(prisma.gateVerdict.findFirst)

const PROVENANCE = {
  schemaVersion: LAUNCH_REPORT_PROVENANCE_VERSION,
  gateVerdictId: "verdict-1",
  verdictChecksum: "checksum-1",
  assessmentVersion: 1,
  assessedIdentity: { kind: "COMMIT", value: "a".repeat(40) },
  assessedAt: "2026-09-10T00:00:00.000Z",
  issuedAt: "2026-09-10T01:00:00.000Z",
  applicabilityCheckedAt: "2026-09-10T01:00:00.000Z",
  applicability: "applicable",
  reasonCodes: [],
  historicalState: "READY",
  effectiveState: "READY",
}

describe("resolveReportDelegationTarget", () => {
  beforeEach(() => vi.clearAllMocks())

  it("returns null when the report does not exist in the workspace", async () => {
    reportFindFirst.mockResolvedValue(null as never)
    await expect(resolveReportDelegationTarget("report-1", "ws-1")).resolves.toBeNull()
    expect(reportFindFirst).toHaveBeenCalledWith({
      where: { id: "report-1", workspaceId: "ws-1", deletedAt: null },
      select: { id: true, scanId: true, type: true, provenanceJson: true },
    })
  })

  it("resolves the linked scan's persisted target", async () => {
    reportFindFirst.mockResolvedValue({
      id: "report-1",
      scanId: "scan-1",
      type: "developer",
    } as never)
    scanFindFirst.mockResolvedValue({ targetId: "target-1" } as never)
    await expect(resolveReportDelegationTarget("report-1", "ws-1")).resolves.toEqual({
      targetId: "target-1",
    })
    expect(scanFindFirst).toHaveBeenCalledWith({
      where: { id: "scan-1", workspaceId: "ws-1", deletedAt: null },
      select: { targetId: true },
    })
  })

  it("requires all-targets when the linked scan was deleted", async () => {
    reportFindFirst.mockResolvedValue({
      id: "report-1",
      scanId: "scan-gone",
      type: "developer",
    } as never)
    scanFindFirst.mockResolvedValue(null as never)
    await expect(resolveReportDelegationTarget("report-1", "ws-1")).resolves.toEqual({
      targetId: null,
    })
  })

  it("requires all-targets for a workspace-wide scan (no persisted target)", async () => {
    reportFindFirst.mockResolvedValue({
      id: "report-1",
      scanId: "scan-1",
      type: "developer",
    } as never)
    scanFindFirst.mockResolvedValue({ targetId: null } as never)
    await expect(resolveReportDelegationTarget("report-1", "ws-1")).resolves.toEqual({
      targetId: null,
    })
  })

  it("resolves a launch report's target through validated provenance and the stored verdict", async () => {
    reportFindFirst.mockResolvedValue({
      id: "report-1",
      scanId: null,
      type: "launch_readiness",
      provenanceJson: { ...PROVENANCE },
    } as never)
    verdictFindFirst.mockResolvedValue({
      targetId: "target-7",
      verdictChecksum: "checksum-1",
    } as never)
    await expect(resolveReportDelegationTarget("report-1", "ws-1")).resolves.toEqual({
      targetId: "target-7",
    })
    expect(verdictFindFirst).toHaveBeenCalledWith({
      where: { id: "verdict-1", workspaceId: "ws-1" },
      select: { targetId: true, verdictChecksum: true },
    })
  })

  it("requires all-targets for a legacy launch report without parseable provenance", async () => {
    reportFindFirst.mockResolvedValue({
      id: "report-1",
      scanId: null,
      type: "launch_readiness",
      provenanceJson: { schemaVersion: "unknown" },
    } as never)
    await expect(resolveReportDelegationTarget("report-1", "ws-1")).resolves.toEqual({
      targetId: null,
    })
    expect(verdictFindFirst).not.toHaveBeenCalled()
  })

  it("requires all-targets when the stored verdict is missing", async () => {
    reportFindFirst.mockResolvedValue({
      id: "report-1",
      scanId: null,
      type: "launch_readiness",
      provenanceJson: { ...PROVENANCE },
    } as never)
    verdictFindFirst.mockResolvedValue(null as never)
    await expect(resolveReportDelegationTarget("report-1", "ws-1")).resolves.toEqual({
      targetId: null,
    })
  })

  it("requires all-targets when the stored verdict contradicts the provenance binding", async () => {
    reportFindFirst.mockResolvedValue({
      id: "report-1",
      scanId: null,
      type: "launch_readiness",
      provenanceJson: { ...PROVENANCE },
    } as never)
    verdictFindFirst.mockResolvedValue({
      targetId: "target-7",
      verdictChecksum: "different-checksum",
    } as never)
    await expect(resolveReportDelegationTarget("report-1", "ws-1")).resolves.toEqual({
      targetId: null,
    })
  })

  it("requires all-targets for non-launch reports with no scan link", async () => {
    reportFindFirst.mockResolvedValue({
      id: "report-1",
      scanId: null,
      type: "developer",
      provenanceJson: { ...PROVENANCE },
    } as never)
    await expect(resolveReportDelegationTarget("report-1", "ws-1")).resolves.toEqual({
      targetId: null,
    })
    // Provenance on a non-launch report is not a delegation binding.
    expect(verdictFindFirst).not.toHaveBeenCalled()
  })
})
