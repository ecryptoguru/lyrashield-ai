import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@lyrashield/db", () => {
  const mockPrisma = {
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
    scanResultManifest: { findUnique: vi.fn(), create: vi.fn() },
    scanCoverageReceipt: { createMany: vi.fn() },
    findingCandidate: { upsert: vi.fn() },
    findingVerification: { upsert: vi.fn() },
    finding: { update: vi.fn() },
    retest: { findMany: vi.fn(), update: vi.fn() },
  }
  return {
    prisma: mockPrisma,
    getWorkspaceContext: vi.fn().mockReturnValue("ws-1"),
    withWorkspaceRLS: vi.fn(async (_workspaceId: string, fn: (tx: unknown) => Promise<unknown>) =>
      fn(mockPrisma)
    ),
  }
})

import { prisma } from "@lyrashield/db"
import {
  buildCoverageReceipts,
  completeRetestsForScan,
  persistDetectionReceipt,
  persistResultManifest,
} from "./result-integrity"

describe("result integrity", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prisma.$transaction).mockImplementation(async (callback) => callback(prisma))
  })

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
    expect(receipts).toHaveLength(55)
    expect(receipts.find((receipt) => receipt.controlId === "vibe-34")).toMatchObject({
      status: "BLOCKED",
      metadata: expect.objectContaining({ outcome: "EVIDENCE_REQUIRED" }),
    })
    expect(receipts.find((receipt) => receipt.controlId === "vibe-37")).toMatchObject({
      status: "BLOCKED",
      metadata: expect.objectContaining({ outcome: "INCONCLUSIVE" }),
    })
  })

  it("records an engine timeout as blocked coverage", () => {
    const receipts = buildCoverageReceipts({
      scanId: "scan-timeout",
      target: { id: "target-1", type: "REPO", repoFullName: "acme/app" },
      sourceCheckoutAvailable: true,
      engineFindingCount: 0,
      coverageIssues: [{ scanner: "engine", status: "bounded", reason: "Engine timed out" }],
    })

    expect(receipts.find((receipt) => receipt.scanner === "engine")).toMatchObject({
      status: "BLOCKED",
      reason: "Engine timed out",
    })
  })

  it("records detected and no-finding control outcomes without claiming verification", () => {
    const receipts = buildCoverageReceipts({
      scanId: "scan-1",
      target: { id: "target-1", type: "URL", url: "https://example.com" },
      sourceCheckoutAvailable: false,
      engineFindingCount: 0,
      coverageIssues: [],
      matchedControlRanks: [14],
    })

    expect(receipts.find((receipt) => receipt.controlId === "vibe-14")).toMatchObject({
      status: "COMPLETED",
      metadata: expect.objectContaining({ outcome: "DETECTED" }),
    })
    expect(receipts.find((receipt) => receipt.controlId === "vibe-27")).toMatchObject({
      status: "COMPLETED",
      reason: expect.stringContaining("not independent verification"),
      metadata: expect.objectContaining({ outcome: "NO_FINDING" }),
    })
  })

  it("does not attribute URL-only controls to a repository scan", () => {
    const receipts = buildCoverageReceipts({
      scanId: "scan-1",
      target: { id: "target-1", type: "REPO", repoFullName: "acme/app" },
      sourceCheckoutAvailable: true,
      engineFindingCount: 1,
      coverageIssues: [],
      matchedControlRanks: [29, 31],
    })

    expect(receipts.find((receipt) => receipt.controlId === "vibe-29")).toMatchObject({
      status: "NOT_APPLICABLE",
      metadata: expect.objectContaining({ outcome: "NOT_APPLICABLE" }),
    })
    expect(receipts.find((receipt) => receipt.controlId === "vibe-31")).toMatchObject({
      status: "NOT_APPLICABLE",
      metadata: expect.objectContaining({ outcome: "NOT_APPLICABLE" }),
    })
  })

  it("keeps unmatched model-only controls inconclusive", () => {
    const receipts = buildCoverageReceipts({
      scanId: "scan-1",
      target: { id: "target-1", type: "REPO", repoFullName: "acme/app" },
      sourceCheckoutAvailable: true,
      engineFindingCount: 0,
      coverageIssues: [],
    })

    expect(receipts.find((receipt) => receipt.controlId === "vibe-11")).toMatchObject({
      status: "BLOCKED",
      metadata: expect.objectContaining({ outcome: "INCONCLUSIVE" }),
    })
  })

  it("keeps unmatched hybrid controls inconclusive instead of treating absent signals as clean", () => {
    const receipts = buildCoverageReceipts({
      scanId: "scan-1",
      target: { id: "target-1", type: "URL", url: "https://example.com" },
      sourceCheckoutAvailable: false,
      engineFindingCount: 0,
      coverageIssues: [],
    })

    expect(receipts.find((receipt) => receipt.controlId === "vibe-14")).toMatchObject({
      status: "BLOCKED",
      metadata: expect.objectContaining({ outcome: "INCONCLUSIVE" }),
    })
  })

  it("preserves scanner limitations on hybrid control receipts", () => {
    const receipts = buildCoverageReceipts({
      scanId: "scan-1",
      target: { id: "target-1", type: "URL", url: "https://example.com" },
      sourceCheckoutAvailable: false,
      engineFindingCount: 0,
      coverageIssues: [{ scanner: "url", status: "partial", reason: "Target was unreachable" }],
    })

    expect(receipts.find((receipt) => receipt.controlId === "vibe-14")).toMatchObject({
      status: "BLOCKED",
      reason: expect.stringContaining("Target was unreachable"),
      metadata: expect.objectContaining({ outcome: "INCONCLUSIVE" }),
    })
  })

  it("retains every coverage limitation and subject in the scanner receipt", () => {
    const receipts = buildCoverageReceipts({
      scanId: "scan-1",
      target: { id: "target-1", type: "REPO", repoFullName: "acme/app" },
      sourceCheckoutAvailable: true,
      engineFindingCount: 2,
      coverageIssues: [
        {
          scanner: "sca",
          status: "partial",
          subject: "build.gradle",
          reason: "A Gradle dependency version could not be resolved",
        },
        {
          scanner: "sca",
          status: "bounded",
          subject: "packages/",
          reason: "Dependency-manifest discovery reached its bounded repository walk limit",
        },
      ],
    })

    expect(receipts.find((receipt) => receipt.scanner === "sca")).toMatchObject({
      status: "BLOCKED",
      subject: "build.gradle, packages/",
      metadata: {
        issues: [
          expect.objectContaining({ subject: "build.gradle" }),
          expect.objectContaining({ subject: "packages/" }),
        ],
      },
    })
  })

  it("stores urlExecution aggregate scope and no raw response bodies", async () => {
    vi.mocked(prisma.scanResultManifest.findUnique).mockResolvedValue(null)

    const urlExecution: import("@lyrashield/types").UrlExecutionSummary = {
      contractVersion: "url-scan/2.0.0",
      profile: "WEB_APP_STANDARD",
      methods: ["GET"],
      subjectCount: 17,
      documentCount: 10,
      assetCount: 7,
      operationCount: 0,
      methodProbeCount: 0,
      originProbeCount: 0,
      totalBytes: 2048,
      truncated: true,
      issueCodes: ["LIMIT_REACHED"],
    }

    await persistResultManifest({
      scanId: "scan-1",
      target: { id: "target-1", type: "WEB_APP", url: "https://example.com" },
      sourceCheckoutAvailable: false,
      engineFindingCount: 0,
      coverageIssues: [],
      urlExecution,
    })

    const createCall = vi.mocked(prisma.scanResultManifest.create).mock.calls[0][0] as {
      data: { manifest: unknown }
    }
    const manifest = createCall.data.manifest as { urlExecution: unknown }
    expect(manifest.urlExecution).toEqual(urlExecution)
    expect(JSON.stringify(manifest)).not.toContain("<html")
    expect(JSON.stringify(manifest)).not.toContain("token=")
  })

  it("blocks completed repository coverage when immutable receipt identity is missing", async () => {
    vi.mocked(prisma.scanResultManifest.findUnique).mockResolvedValue(null)

    await persistResultManifest({
      scanId: "scan-missing-identity",
      target: { id: "target-1", type: "REPO", repoFullName: "acme/app" },
      sourceCheckoutAvailable: true,
      engineFindingCount: 1,
      coverageIssues: [],
    })

    const createCall = vi.mocked(prisma.scanResultManifest.create).mock.calls[0][0] as {
      data: { manifest: { coverage: Array<Record<string, unknown>> } }
    }
    expect(
      createCall.data.manifest.coverage.find((receipt) => receipt.controlId === "engine")
    ).toMatchObject({
      status: "BLOCKED",
      subject: "result-manifest",
      reason: expect.stringContaining("engineExecution"),
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
      engineExecution: {
        model: "azure_ai/gpt-5.6-luna",
        reasoningEffort: "medium",
        image: "sandbox@sha256:abc",
        imageDigest: "sha256:abc",
        engineVersion: "1.1.0",
        promptBundleHash: "a".repeat(64),
        delegateModel: "azure_ai/gpt-5.6-luna",
        delegateReasoningEffort: "medium",
        routingPolicy: "coordinator-luna-med-delegate-luna-med-v1",
        compactionTriggerTokens: 200_000,
        compactionTargetTokens: 180_000,
        sourceRevision: "b".repeat(40),
      },
      accounting: {
        maxBudgetUsd: 1.2,
        billedCostUsd: 0.42,
        reconciled: true,
      },
    })

    expect(prisma.scanResultManifest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ scanId: "scan-1", checksum: expect.any(String) }),
      })
    )
    expect(prisma.scanCoverageReceipt.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true })
    )
    expect(prisma.scanResultManifest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          manifest: expect.objectContaining({
            coverage: expect.any(Array),
            scannerContractVersion: "2026-07-18",
            engineExecution: expect.objectContaining({
              model: "azure_ai/gpt-5.6-luna",
              imageDigest: "sha256:abc",
              sourceRevision: "b".repeat(40),
            }),
            accounting: expect.objectContaining({ maxBudgetUsd: 1.2, reconciled: true }),
          }),
        }),
      })
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

  it("retains a detection receipt for every corroborating scanner", async () => {
    vi.mocked(prisma.findingCandidate.upsert)
      .mockResolvedValueOnce({ id: "candidate-engine" } as never)
      .mockResolvedValueOnce({ id: "candidate-sca" } as never)

    await persistDetectionReceipt({
      scanId: "scan-1",
      workspaceId: "workspace-1",
      targetId: "target-1",
      findingId: "finding-1",
      severity: "HIGH",
      dedupeKey: "dedupe-1",
      finding: {
        id: "engine-1",
        title: "Dependency issue",
        severity: "high",
        timestamp: "2026-07-14T00:00:00Z",
        scannerSource: "engine",
        corroboratingSources: ["engine", "sca"],
        normalizedSeverity: "HIGH",
        normalizedCwe: null,
        normalizedCvss: 7.5,
        confidenceScore: 80,
        falsePositiveRisk: "low",
        dedupeKey: "dedupe-1",
        enrichment: {},
      },
    })

    expect(prisma.findingCandidate.upsert).toHaveBeenCalledTimes(2)
    expect(prisma.findingVerification.upsert).toHaveBeenCalledTimes(2)
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
