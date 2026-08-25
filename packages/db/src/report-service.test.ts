import { beforeEach, describe, expect, it, vi } from "vitest"

const { systemPrisma } = vi.hoisted(() => ({
  systemPrisma: { report: { findFirst: vi.fn() } },
}))

vi.mock("./client", () => ({
  prisma: {
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
    report: { findFirst: vi.fn() },
    scan: { findFirst: vi.fn() },
    finding: { findMany: vi.fn(), groupBy: vi.fn() },
  },
}))
vi.mock("./system-client", () => ({ getSystemPrisma: vi.fn(() => systemPrisma) }))

import { randomBytes } from "crypto"
import { prisma } from "./client"
import { getReportByShareToken, getShareableReport } from "./report-service"

const mockPrisma = prisma as unknown as {
  $transaction: ReturnType<typeof vi.fn>
  $executeRaw: ReturnType<typeof vi.fn>
  report: { findFirst: ReturnType<typeof vi.fn> }
  scan: { findFirst: ReturnType<typeof vi.fn> }
  finding: { findMany: ReturnType<typeof vi.fn>; groupBy: ReturnType<typeof vi.fn> }
}
const mockSystemPrisma = systemPrisma as unknown as {
  report: { findFirst: ReturnType<typeof vi.fn> }
}

describe("getShareableReport", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // The read sequence runs inside withWorkspaceRLS: "Report", "Scan" and
    // "Finding" are all FORCE ROW LEVEL SECURITY, so the transaction-local
    // context is the isolation boundary on this public share path.
    mockPrisma.$transaction.mockImplementation(async (callback) => callback(mockPrisma))
    mockPrisma.$executeRaw.mockResolvedValue(1)
    mockPrisma.finding.groupBy.mockResolvedValue([])
  })

  it("does not load a scan outside the report workspace", async () => {
    mockPrisma.report.findFirst.mockResolvedValue({
      id: "report-1",
      workspaceId: "ws-1",
      scanId: "scan-other-workspace",
      title: "Shared report",
      type: "developer",
      status: "generated",
      format: "html",
      shareTokenHash: "hash",
      shareExpiresAt: null,
      revokedAt: null,
      createdAt: new Date(),
    })
    mockPrisma.scan.findFirst.mockResolvedValue(null)

    const report = await getShareableReport("report-1", "ws-1")

    expect(report?.scanSummary).toBeNull()
    expect(mockPrisma.scan.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "scan-other-workspace", workspaceId: "ws-1", deletedAt: null },
      })
    )
  })

  it("renders the immutable report snapshot without reloading live scan data", async () => {
    mockPrisma.report.findFirst.mockResolvedValue({
      id: "report-1",
      workspaceId: "ws-1",
      scanId: "scan-1",
      title: "Shared report",
      type: "executive",
      status: "generated",
      format: "html",
      contentJson: {
        version: 2,
        scanInfo: {
          scanId: "scan-1",
          status: "COMPLETED",
          summary: "Snapshot summary",
          targetName: "Snapshot target",
        },
        totalFindings: 3,
        findingsBySeverity: { HIGH: 2, MEDIUM: 1 },
        verifiedCount: 3,
        fixedCount: 1,
        findingsByStatus: { OPEN: 2, FIXED: 1 },
        findingsByCategory: { injection: 2, auth: 1 },
        retestSummary: { passed: 1, failed: 0, pending: 1 },
        assurance: {
          verdict: "GO_WITH_CONDITIONS",
          score: 74,
          grade: "B",
          narrative: "Two high-severity findings remain.",
          scoreTrend: [{ score: 74, grade: "B", computedAt: "2026-07-14T00:00:00.000Z" }],
          ageBuckets: { "0–7 days": 2, "8–30 days": 1 },
          priorityActions: [
            { label: "Assign remediation", detail: "Set owners.", severity: "HIGH" },
          ],
          methodology: ["Frozen at report creation time."],
        },
      },
      shareTokenHash: "hash",
      shareExpiresAt: null,
      revokedAt: null,
      createdAt: new Date("2026-07-14T00:00:00.000Z"),
    })

    const report = await getShareableReport("report-1", "ws-1")

    expect(report?.scanSummary).toEqual({
      scanId: "scan-1",
      status: "COMPLETED",
      summary: "Snapshot summary",
      targetName: "Private target",
      findingsCount: 3,
      findingsBySeverity: { HIGH: 2, MEDIUM: 1 },
    })
    expect(mockPrisma.scan.findFirst).not.toHaveBeenCalled()
    expect(mockPrisma.finding.findMany).not.toHaveBeenCalled()
    expect(report?.title).toBe("LyraShield Security Assurance Report")
    expect(report?.assurance).toEqual(
      expect.objectContaining({
        verdict: "GO_WITH_CONDITIONS",
        score: 74,
        verifiedCount: 3,
        fixedCount: 1,
      })
    )
  })

  it("does not expose private AI assurance data in public share payloads", async () => {
    mockPrisma.report.findFirst.mockResolvedValue({
      id: "report-1",
      workspaceId: "ws-1",
      scanId: null,
      title: "Shared report",
      type: "executive",
      status: "generated",
      format: "html",
      contentJson: {
        version: 2,
        totalFindings: 0,
        assurance: {
          verdict: "GO",
          score: 95,
          grade: "A",
          narrative: "Ready.",
          scoreTrend: [],
          ageBuckets: {},
          priorityActions: [],
          methodology: ["Frozen."],
        },
        aiAssurance: {
          controls: [
            {
              controlId: "vibe-34",
              controlTitle: "Missing audit trails",
              state: "EVIDENCE_ACCEPTED",
              status: "ACCEPTED",
              version: 1,
              attestation: "audit log present",
              artifacts: [
                {
                  filename: "proof.pdf",
                  mediaType: "application/pdf",
                  byteLength: 1234,
                  checksum: "sha-1",
                  storageUri: "s3://lyrashield-bucket/evidence/ws-1/...",
                  encryptionKeyRef: "vault/lyrashield-evidence-key/v1",
                },
              ],
            },
          ],
          generatedAt: "2026-07-14T00:00:00.000Z",
        },
        aiAppSecurity: {
          score: 98,
          methodology: "ai-app-security-score/1.0.0",
          advisoryReceipt: { snapshotId: "private-advisory-snapshot" },
          triage: { modelRoute: "private-model-route" },
        },
        aiSystemProfile: { systemName: "Private assistant" },
        threatModel: { currentVersion: "private-threat-model-version" },
      },
      shareTokenHash: "hash",
      shareExpiresAt: null,
      revokedAt: null,
      createdAt: new Date("2026-07-14T00:00:00.000Z"),
    })
    mockPrisma.scan.findFirst.mockResolvedValue(null)

    const report = await getShareableReport("report-1", "ws-1")

    expect(report).not.toBeNull()
    expect(report).not.toHaveProperty("aiAssurance")
    expect(report).not.toHaveProperty("aiAppSecurity")
    expect(report).not.toHaveProperty("aiSystemProfile")
    expect(report).not.toHaveProperty("threatModel")
    expect(JSON.stringify(report)).not.toContain("aiAssurance")
    expect(JSON.stringify(report)).not.toContain("private-advisory-snapshot")
    expect(JSON.stringify(report)).not.toContain("private-model-route")
    expect(JSON.stringify(report)).not.toContain("Private assistant")
    expect(JSON.stringify(report)).not.toContain("private-threat-model-version")
    expect(JSON.stringify(report)).not.toContain("s3://")
    expect(JSON.stringify(report)).not.toContain("storageUri")
  })

  it("runs the public-share read sequence inside workspace RLS", async () => {
    mockPrisma.report.findFirst.mockResolvedValue({
      id: "report-1",
      workspaceId: "ws-1",
      scanId: null,
      title: "Shared report",
      type: "developer",
      status: "generated",
      format: "html",
      shareTokenHash: "hash",
      shareExpiresAt: null,
      revokedAt: null,
      createdAt: new Date(),
      contentJson: null,
    })

    await getShareableReport("report-1", "ws-1")

    // No request-scoped workspace context exists on the public share path, so the
    // Prisma extension will not inject RLS context — this helper must, or the
    // FORCE-RLS policy returns zero rows for the restricted production role.
    expect(mockPrisma.$transaction).toHaveBeenCalled()
    expect(mockPrisma.$executeRaw).toHaveBeenCalled()
  })
})

describe("getReportByShareToken", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const validToken = randomBytes(32).toString("hex")

  it("rejects tokens that do not match the 64-hex share format", async () => {
    for (const token of ["", "short", "g".repeat(64), validToken.slice(0, 63)]) {
      const report = await getReportByShareToken(token)
      expect(report).toBeNull()
    }
    expect(mockSystemPrisma.report.findFirst).not.toHaveBeenCalled()
  })

  it("returns null when no unrevoked report matches the token hash", async () => {
    mockSystemPrisma.report.findFirst.mockResolvedValue(null)

    const report = await getReportByShareToken(validToken)

    expect(report).toBeNull()
    expect(mockSystemPrisma.report.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          revokedAt: null,
          deletedAt: null,
        }),
      })
    )
  })

  it("returns null when the shared report has expired", async () => {
    mockSystemPrisma.report.findFirst.mockResolvedValue({
      id: "report-1",
      workspaceId: "ws-1",
      shareExpiresAt: new Date(Date.now() - 60_000),
    })

    const report = await getReportByShareToken(validToken)

    expect(report).toBeNull()
  })

  it("returns the report when the token is valid, unrevoked, and not expired", async () => {
    mockSystemPrisma.report.findFirst.mockResolvedValue({
      id: "report-1",
      workspaceId: "ws-1",
      shareExpiresAt: new Date(Date.now() + 60_000),
    })

    const report = await getReportByShareToken(validToken)

    expect(report).toEqual({
      id: "report-1",
      workspaceId: "ws-1",
      shareExpiresAt: expect.any(Date),
    })
  })
})
