import { beforeEach, describe, expect, it, vi } from "vitest"

const { systemPrisma } = vi.hoisted(() => ({
  systemPrisma: { report: { findFirst: vi.fn() } },
}))

vi.mock("./client", () => ({
  prisma: {
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
    $queryRaw: vi.fn(),
    report: { findFirst: vi.fn() },
    scan: { findFirst: vi.fn() },
    finding: { findMany: vi.fn(), groupBy: vi.fn() },
  },
}))
vi.mock("./system-client", () => ({ getSystemPrisma: vi.fn(() => systemPrisma) }))

import { randomBytes } from "crypto"
import { prisma } from "./client"
import { buildLaunchReportPayload } from "./launch-report-payload"
import {
  generateReleasePacketShareToken,
  generateShareToken,
  getReportByShareToken,
  getShareableReport,
  getShareableReportByToken,
  revokeShareToken,
  revokeReleasePacketShareToken,
} from "./report-service"

const mockPrisma = prisma as unknown as {
  $transaction: ReturnType<typeof vi.fn>
  $executeRaw: ReturnType<typeof vi.fn>
  $queryRaw: ReturnType<typeof vi.fn>
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

  it.each([undefined, { client: mockPrisma as never }])(
    "rejects a release packet before reading any generic summary (options: %j)",
    async (options) => {
      mockPrisma.report.findFirst.mockResolvedValue({
        id: "packet-1",
        workspaceId: "ws-1",
        type: "release_packet",
        scanId: "scan-1",
        contentJson: { scanInfo: { scanId: "scan-1", summary: "Private snapshot" } },
      })
      await expect(getShareableReport("packet-1", "ws-1", options)).resolves.toBeNull()
      expect(mockPrisma.scan.findFirst).not.toHaveBeenCalled()
      expect(mockPrisma.finding.groupBy).not.toHaveBeenCalled()
    }
  )

  it("returns only safe launch metadata for an active token and valid payload", async () => {
    const payload = buildLaunchReportPayload(
      {
        standardVersion: "lyrashield-gate/2.4.0",
        state: "READY",
        coverageStatement: [],
        nonCoverage: [],
        blockingReasons: [],
        evidenceSummary: {
          verified: 0,
          retestConfirmed: 0,
          unresolvedCritical: 0,
          unresolvedHigh: 0,
        },
        staleness: { current: true },
        verdictChecksum: "fixture",
        evaluatedAt: new Date("2026-11-12T00:00:00Z"),
      },
      { issuedAt: new Date("2026-11-12T00:01:00Z") }
    )
    const row = {
      id: "report-1",
      workspaceId: "ws-1",
      type: "launch_readiness",
      scanId: null,
      contentJson: payload,
      status: "generated",
      format: "html",
      shareTokenHash: "fixture",
      shareExpiresAt: null,
      revokedAt: null,
      createdAt: new Date(),
    }
    mockPrisma.$queryRaw.mockResolvedValue([row])
    const result = await getShareableReportByToken("report-1", "ws-1", "a".repeat(64))
    expect(result).toMatchObject({ id: "report-1", type: "launch_readiness" })
    expect(result).not.toHaveProperty("contentJson")
    mockPrisma.$queryRaw.mockResolvedValue([
      { ...row, contentJson: { ...payload, reportChecksum: "forged" } },
    ])
    expect(await getShareableReportByToken("report-1", "ws-1", "a".repeat(64))).toBeNull()
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

  it("rejects a snapshot whose source scan contradicts the report scan link", async () => {
    mockPrisma.report.findFirst.mockResolvedValue({
      id: "report-1",
      workspaceId: "ws-1",
      scanId: "scan-a",
      title: "Shared report",
      type: "developer",
      status: "generated",
      format: "html",
      contentJson: {
        version: 2,
        scanInfo: {
          scanId: "scan-b",
          status: "COMPLETED",
          summary: "Foreign snapshot",
          targetName: "Foreign target",
        },
      },
      shareTokenHash: "hash",
      shareExpiresAt: null,
      revokedAt: null,
      createdAt: new Date(),
    })

    await expect(getShareableReport("report-1", "ws-1")).resolves.toBeNull()
  })

  it("requires an explicit snapshot scan binding for delegated readers", async () => {
    for (const contentJson of [
      null,
      {
        version: 2,
        totalFindings: 1,
        assurance: {
          verdict: "NOT_READY",
          score: 2,
          grade: "F",
          narrative: "Foreign assurance",
          scoreTrend: [],
          ageBuckets: {},
          priorityActions: [],
          methodology: [],
        },
      },
      { version: 2, scanInfo: null },
      { version: 2, scanInfo: "scan-a" },
      { version: 2, scanInfo: { scanId: null } },
    ]) {
      mockPrisma.report.findFirst.mockResolvedValue({
        id: "report-1",
        workspaceId: "ws-1",
        scanId: "scan-a",
        title: "Shared report",
        type: "developer",
        status: "generated",
        format: "html",
        contentJson,
        shareTokenHash: null,
        shareExpiresAt: null,
        revokedAt: null,
        createdAt: new Date(),
      })

      await expect(
        getShareableReport("report-1", "ws-1", {
          requireExplicitSnapshotBinding: true,
        })
      ).resolves.toBeNull()
    }
  })

  it("rejects an explicit delegated snapshot whose scan or target is deleted", async () => {
    mockPrisma.report.findFirst.mockResolvedValue({
      id: "report-1",
      workspaceId: "ws-1",
      scanId: "scan-a",
      title: "Shared report",
      type: "developer",
      status: "generated",
      format: "html",
      contentJson: { version: 2, scanInfo: { scanId: "scan-a" } },
      shareTokenHash: null,
      shareExpiresAt: null,
      revokedAt: null,
      createdAt: new Date(),
    })
    mockPrisma.scan.findFirst.mockResolvedValue(null)

    await expect(
      getShareableReport("report-1", "ws-1", {
        requireExplicitSnapshotBinding: true,
      })
    ).resolves.toBeNull()
  })

  it("requires a valid launch snapshot for delegated readers", async () => {
    mockPrisma.report.findFirst.mockResolvedValue({
      id: "report-1",
      workspaceId: "ws-1",
      scanId: null,
      title: "Launch",
      type: "launch_readiness",
      status: "generated",
      format: "html",
      contentJson: { malformed: true },
      shareTokenHash: null,
      shareExpiresAt: null,
      revokedAt: null,
      createdAt: new Date(),
    })

    await expect(
      getShareableReport("report-1", "ws-1", {
        requireExplicitSnapshotBinding: true,
      })
    ).resolves.toBeNull()
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

  it("never leaks execution-plan or attachment internals in the share payload", async () => {
    mockPrisma.report.findFirst.mockResolvedValue({
      id: "report-1",
      workspaceId: "ws-1",
      scanId: "scan-1",
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
    // Even if a future caller hands the projection a row carrying private
    // internals, the public payload must stay allowlisted.
    mockPrisma.scan.findFirst.mockResolvedValue({
      id: "scan-1",
      status: "COMPLETED",
      summary: "Done",
      executionPlan: {
        workflow: "REVIEW_TARGET",
        attachmentIds: ["att-private"],
        limits: { maxBudgetUsd: 5 },
        capabilities: ["engine"],
      },
      attachments: { manifestChecksum: "private-manifest-checksum" },
    })

    const report = await getShareableReport("report-1", "ws-1")

    const serialized = JSON.stringify(report)
    expect(serialized).not.toContain("executionPlan")
    expect(serialized).not.toContain("att-private")
    expect(serialized).not.toContain("maxBudgetUsd")
    expect(serialized).not.toContain("private-manifest-checksum")
    // The scan lookup is explicitly narrow — it may not widen to private
    // columns just because they exist on the model.
    expect(mockPrisma.scan.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        select: { id: true, status: true, summary: true },
      })
    )
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

  it("uses the safe launch-readiness title for launch reports", async () => {
    mockPrisma.report.findFirst.mockResolvedValue({
      id: "report-1",
      workspaceId: "ws-1",
      scanId: null,
      title: "LyraShield Launch Readiness Report",
      type: "launch_readiness",
      status: "generated",
      format: "html",
      shareTokenHash: "hash",
      shareExpiresAt: null,
      revokedAt: null,
      createdAt: new Date(),
      contentJson: null,
    })

    const report = await getShareableReport("report-1", "ws-1")

    expect(report?.title).toBe("LyraShield Launch Readiness Report")
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

describe("report-type-bound share mutations", () => {
  const updateMany = vi.fn()
  const client = { report: { updateMany } }

  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.$transaction.mockImplementation(async (callback) => callback(client))
    Object.assign(client, { $executeRaw: vi.fn().mockResolvedValue(1) })
    updateMany.mockResolvedValue({ count: 1 })
  })

  it.each([generateShareToken, revokeShareToken])(
    "rejects a packet atomically without changing its token via %s",
    async (mutate) => {
      const packet = {
        id: "packet-1",
        workspaceId: "ws-1",
        type: "release_packet",
        shareTokenHash: "persisted-packet-token-hash",
        shareExpiresAt: new Date("2030-01-01T00:00:00Z"),
        revokedAt: null,
      }
      const original = { ...packet }
      updateMany.mockImplementation(async ({ where, data }) => {
        if (where.type?.not === packet.type) return { count: 0 }
        Object.assign(packet, data)
        return { count: 1 }
      })

      await expect(mutate(packet.id, packet.workspaceId)).rejects.toThrow("Report not found")
      expect(updateMany).toHaveBeenCalledWith({
        where: {
          id: "packet-1",
          workspaceId: "ws-1",
          deletedAt: null,
          type: { not: "release_packet" },
        },
        data: expect.any(Object),
      })
      expect(packet).toEqual(original)
    }
  )

  it("preserves ordinary report token generation and caller-owned transactions", async () => {
    const result = await generateShareToken("report-1", "ws-1", { client: client as never })
    expect(result.token).toMatch(/^[a-f0-9]{64}$/)
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: "report-1",
        workspaceId: "ws-1",
        deletedAt: null,
        type: { not: "release_packet" },
      },
      data: { shareTokenHash: result.tokenHash, shareExpiresAt: result.expiresAt, revokedAt: null },
    })
    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
  })

  it("issues a packet token only through the packet-specific writer", async () => {
    const result = await generateReleasePacketShareToken("packet-1", "ws-1")
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "packet-1", workspaceId: "ws-1", deletedAt: null, type: "release_packet" },
      data: { shareTokenHash: result.tokenHash, shareExpiresAt: result.expiresAt, revokedAt: null },
    })
  })

  it("rejects a non-packet or missing row through the packet-specific writer", async () => {
    updateMany.mockResolvedValue({ count: 0 })
    await expect(generateReleasePacketShareToken("report-1", "ws-1")).rejects.toThrow(
      "Report not found"
    )
  })
  it("revokes only a packet in the given workspace while retaining its token hash", async () => {
    const revokedAt = await revokeReleasePacketShareToken("packet-1", "ws-1")
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "packet-1", workspaceId: "ws-1", deletedAt: null, type: "release_packet" },
      data: { revokedAt },
    })
  })

  it.each([generateReleasePacketShareToken, revokeReleasePacketShareToken])(
    "requires a held transaction when delegated authority is supplied to %s",
    async (mutate) => {
      await expect(
        mutate("packet-1", "ws-1", {
          authority: { targetIds: ["target-1"], allowedProfiles: ["STANDARD"] },
        })
      ).rejects.toThrow("FORBIDDEN")
      expect(updateMany).not.toHaveBeenCalled()
    }
  )

  it.each([generateReleasePacketShareToken, revokeReleasePacketShareToken])(
    "binds delegated target/profile and packet type atomically via %s",
    async (mutate) => {
      await mutate("packet-1", "ws-1", {
        client: client as never,
        authority: { targetIds: ["target-1"], allowedProfiles: ["STANDARD"] },
      })
      expect(updateMany).toHaveBeenCalledWith({
        where: {
          id: "packet-1",
          workspaceId: "ws-1",
          deletedAt: null,
          type: "release_packet",
          scan: {
            workspaceId: "ws-1",
            deletedAt: null,
            targetId: { in: ["target-1"] },
            mode: { in: ["STANDARD"] },
            target: { workspaceId: "ws-1", deletedAt: null },
          },
        },
        data: expect.any(Object),
      })
      expect(mockPrisma.$transaction).not.toHaveBeenCalled()
    }
  )
})
