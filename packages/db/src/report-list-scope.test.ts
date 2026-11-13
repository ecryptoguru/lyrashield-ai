import { beforeEach, describe, expect, it, vi } from "vitest"
import { LAUNCH_REPORT_PROVENANCE_VERSION } from "./launch-report-provenance"

const db = vi.hoisted(() => ({
  report: { findMany: vi.fn() },
  gateVerdict: { findMany: vi.fn() },
}))
vi.mock("./client", () => ({ prisma: db }))
vi.mock("./rls", () => ({
  withWorkspaceRLS: vi.fn(async (_workspaceId, run) => run(db)),
}))
vi.mock("@lyrashield/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn() } }))
import { listReports } from "./report-service"

const provenance = {
  schemaVersion: LAUNCH_REPORT_PROVENANCE_VERSION,
  gateVerdictId: "verdict-allowed",
  verdictChecksum: "checksum-allowed",
  assessedAt: "2026-10-30T00:00:00.000Z",
  issuedAt: "2026-10-30T00:00:00.000Z",
  applicabilityCheckedAt: "2026-10-30T00:00:00.000Z",
  applicability: "applicable",
  reasonCodes: [],
  historicalState: "READY",
  effectiveState: "READY",
}

describe("report list delegated target ownership", () => {
  beforeEach(() => vi.resetAllMocks())

  it("resolves immutable launch provenance before bounded page/cursor selection", async () => {
    db.report.findMany
      .mockResolvedValueOnce([
        { id: "launch-allowed", provenanceJson: provenance },
        {
          id: "launch-wrong-checksum",
          provenanceJson: { ...provenance, verdictChecksum: "changed" },
        },
        {
          id: "launch-other-target",
          provenanceJson: { ...provenance, gateVerdictId: "verdict-denied" },
        },
        { id: "launch-unknown", provenanceJson: null },
        { id: "launch-invalid", provenanceJson: { ...provenance, schemaVersion: "unknown" } },
      ])
      .mockResolvedValueOnce([
        { id: "scan-report-1", type: "developer", provenanceJson: null },
        { id: "launch-allowed", type: "launch_readiness", provenanceJson: provenance },
        { id: "scan-report-2", type: "developer", provenanceJson: null },
      ])
    db.gateVerdict.findMany.mockResolvedValueOnce([
      { id: "verdict-allowed", verdictChecksum: "checksum-allowed" },
    ])
    const result = await listReports("ws-1", "previous-allowed", 2, ["target-1"])
    expect(db.report.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: {
          workspaceId: "ws-1",
          deletedAt: null,
          OR: [
            { scan: { workspaceId: "ws-1", deletedAt: null, targetId: { in: ["target-1"] } } },
            { id: { in: ["launch-allowed"] }, scanId: null, type: "launch_readiness" },
          ],
        },
        cursor: { id: "previous-allowed" },
        skip: 1,
        take: 3,
      })
    )
    expect(db.gateVerdict.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ workspaceId: "ws-1", targetId: { in: ["target-1"] } }),
      })
    )
    expect(result.items.map((row) => row.id)).toEqual(["scan-report-1", "launch-allowed"])
    expect(result.nextCursor).toBe("launch-allowed")
  })

  it("returns no metadata or cursor for empty grants without enumerating reports", async () => {
    expect(await listReports("ws-1", "foreign-cursor", 2, [])).toEqual({
      items: [],
      nextCursor: null,
    })
    expect(db.report.findMany).not.toHaveBeenCalled()
  })

  it("preserves unrestricted lists including workspace-wide and ambiguous reports", async () => {
    db.report.findMany.mockResolvedValueOnce([
      { id: "workspace-report", type: "developer", scanId: null, provenanceJson: null },
    ])
    expect((await listReports("ws-1", undefined, 2)).items[0]?.id).toBe("workspace-report")
    expect(db.report.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: "ws-1", deletedAt: null } })
    )
    expect(db.gateVerdict.findMany).not.toHaveBeenCalled()
  })
})
