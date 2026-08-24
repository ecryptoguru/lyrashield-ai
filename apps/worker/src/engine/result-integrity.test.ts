import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@lyrashield/db", () => {
  const mockPrisma = {
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
    scanResultManifest: { findUnique: vi.fn(), create: vi.fn() },
    scanCoverageReceipt: { createMany: vi.fn(), findMany: vi.fn() },
    findingCandidate: { upsert: vi.fn(), findMany: vi.fn() },
    findingVerification: { upsert: vi.fn() },
    finding: { update: vi.fn(), findMany: vi.fn() },
    retest: { findMany: vi.fn(), update: vi.fn() },
    scan: { findUnique: vi.fn(), findMany: vi.fn() },
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

const REV_A = "a".repeat(40)
const REV_B = "b".repeat(40)
const REV_SHORT = "abc123"
const URL_HASH_A = "1".repeat(64)
const URL_HASH_B = "2".repeat(64)

function manifestRow(scanId: string, targetId: string, targetType: string, overrides: object = {}) {
  const defaultManifest = {
    target: { id: targetId, type: targetType },
    engineExecution: { sourceRevision: REV_A },
  }
  const merged = { ...defaultManifest, ...overrides }
  if ("engineExecution" in overrides) {
    merged.engineExecution = {
      ...defaultManifest.engineExecution,
      ...(overrides as { engineExecution?: object }).engineExecution,
    }
  }
  return {
    id: `manifest-${scanId}`,
    scanId,
    checksum: `checksum-${scanId}`,
    manifest: merged,
  }
}

/**
 * Default deterministic repo-retest state: baseline scan-1 (REPO) found the
 * finding through "secrets", the retest scan-2 re-ran and did not retain it,
 * both manifests exist with valid revisions, and both family coverage
 * receipts are COMPLETED.
 */
function mockRepoRetestState(
  overrides: {
    baselineRevision?: string | null
    retestRevision?: string | null
    baselineManifest?: ReturnType<typeof manifestRow> | null
    retestManifest?: ReturnType<typeof manifestRow> | null
    candidates?: Array<{ findingId: string; scanId: string; scannerSource: string }>
    baselineReceipts?: Array<{ id: string; controlId: string; status: string }>
    retestReceipts?: Array<{ id: string; controlId: string; status: string }>
    retestFindingIds?: string[]
  } = {}
) {
  const baselineManifest =
    "baselineManifest" in overrides
      ? overrides.baselineManifest
      : manifestRow("scan-1", "target-1", "REPO", {
          engineExecution: { sourceRevision: overrides.baselineRevision ?? REV_A },
        })
  const retestManifest =
    "retestManifest" in overrides
      ? overrides.retestManifest
      : manifestRow("scan-2", "target-1", "REPO", {
          engineExecution: { sourceRevision: overrides.retestRevision ?? REV_B },
        })
  const candidates = overrides.candidates ?? [
    { findingId: "finding-1", scanId: "scan-1", scannerSource: "secrets" },
  ]
  const baselineReceipts = overrides.baselineReceipts ?? [
    { id: "baseline-secrets", controlId: "secrets", status: "COMPLETED" },
  ]
  const retestReceipts = overrides.retestReceipts ?? [
    { id: "retest-secrets", controlId: "secrets", status: "COMPLETED" },
  ]

  vi.mocked(prisma.retest.findMany).mockResolvedValue([
    { id: "retest-1", findingId: "finding-1", finding: { id: "finding-1", scanId: "scan-1" } },
  ] as never)
  vi.mocked(prisma.scan.findUnique).mockResolvedValue({
    id: "scan-2",
    targetId: "target-1",
  } as never)
  vi.mocked(prisma.scan.findMany).mockResolvedValue([
    { id: "scan-1", targetId: "target-1" },
  ] as never)
  vi.mocked(prisma.findingCandidate.findMany).mockResolvedValue(candidates as never)
  vi.mocked(prisma.finding.findMany).mockResolvedValue(
    (overrides.retestFindingIds ?? []).map((id) => ({ id })) as never
  )
  vi.mocked(prisma.scanResultManifest.findUnique).mockImplementation(async ({ where }) => {
    if (where.scanId === "scan-1") return baselineManifest as never
    if (where.scanId === "scan-2") return retestManifest as never
    return null
  })
  vi.mocked(prisma.scanCoverageReceipt.findMany).mockImplementation(async ({ where }) => {
    if (where.scanId === "scan-1") return baselineReceipts as never
    if (where.scanId === "scan-2") return retestReceipts as never
    return []
  })
}

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
    expect(receipts).toHaveLength(57)
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

  it("persists AI App Security discovery counts and blocks clean claims when bounded", () => {
    const discovery = {
      version: "ai-app-security-discovery/1" as const,
      mode: "QUICK" as const,
      maxFiles: 200,
      eligibleFiles: 206,
      scannedFiles: 200,
      skippedFiles: 6,
      scannedBytes: 1024,
      representativeSkippedPaths: ["tests/unit/200.test.ts"],
      skippedByReason: { fileLimit: 6, totalByteLimit: 0, oversized: 0, unreadable: 0 },
      limitsReached: ["max_files" as const],
    }
    const receipts = buildCoverageReceipts({
      scanId: "scan-1",
      target: { id: "target-1", type: "REPO", repoFullName: "acme/app" },
      sourceCheckoutAvailable: true,
      engineFindingCount: 0,
      aiAppSecurityDiscovery: discovery,
      coverageIssues: [
        {
          scanner: "ai_app_security",
          status: "bounded",
          reason: "AI App Security file limit reached",
          metadata: { ...discovery },
        },
      ],
    })

    expect(receipts.find((receipt) => receipt.controlId === "ai_app_security")).toMatchObject({
      status: "BLOCKED",
      metadata: {
        discovery: expect.objectContaining({
          eligibleFiles: 206,
          scannedFiles: 200,
          skippedFiles: 6,
          representativeSkippedPaths: ["tests/unit/200.test.ts"],
        }),
        issues: [expect.objectContaining({ metadata: discovery })],
      },
    })
    expect(receipts.find((receipt) => receipt.controlId === "vibe-33")).toMatchObject({
      status: "BLOCKED",
      metadata: expect.objectContaining({ outcome: "INCONCLUSIVE" }),
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
            scannerContractVersion: "2026-08-21",
            engineExecution: expect.objectContaining({
              model: "azure_ai/gpt-5.6-luna",
              imageDigest: "sha256:abc",
              sourceRevision: "b".repeat(40),
            }),
            accounting: expect.objectContaining({ maxBudgetUsd: 1.2, reconciled: true }),
            workerExecution: null,
          }),
        }),
      })
    )
  })

  it("binds worker execution provenance into the stored manifest checksum", async () => {
    vi.mocked(prisma.scanResultManifest.findUnique).mockResolvedValue(null)

    const workerExecution = {
      productRevision: "a".repeat(40),
      workerImageDigest: `sha256:${"b".repeat(64)}`,
      engineRevision: "c".repeat(40),
    }
    await persistResultManifest({
      scanId: "scan-provenance",
      target: { id: "target-1", type: "URL", url: "https://example.com" },
      sourceCheckoutAvailable: false,
      engineFindingCount: 0,
      coverageIssues: [],
      workerExecution,
    })

    const createCall = vi.mocked(prisma.scanResultManifest.create).mock.calls[0][0] as {
      data: { checksum: string; manifest: { workerExecution: unknown } }
    }
    expect(createCall.data.manifest.workerExecution).toEqual(workerExecution)

    const firstChecksum = createCall.data.checksum

    // Same contents again is idempotent: the existing checksum matches.
    vi.mocked(prisma.scanResultManifest.findUnique).mockResolvedValue({
      checksum: firstChecksum,
    } as never)
    vi.mocked(prisma.scanResultManifest.create).mockClear()
    await persistResultManifest({
      scanId: "scan-provenance",
      target: { id: "target-1", type: "URL", url: "https://example.com" },
      sourceCheckoutAvailable: false,
      engineFindingCount: 0,
      coverageIssues: [],
      workerExecution,
    })
    expect(prisma.scanResultManifest.create).not.toHaveBeenCalled()

    // Any single provenance field change must fail closed against the stored
    // manifest instead of silently overwriting it.
    vi.mocked(prisma.scanResultManifest.create).mockClear()
    await expect(
      persistResultManifest({
        scanId: "scan-provenance",
        target: { id: "target-1", type: "URL", url: "https://example.com" },
        sourceCheckoutAvailable: false,
        engineFindingCount: 0,
        coverageIssues: [],
        workerExecution: { ...workerExecution, engineRevision: "d".repeat(40) },
      })
    ).rejects.toThrow("Scan result manifest already exists with different contents")
    expect(prisma.scanResultManifest.create).not.toHaveBeenCalled()
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

  describe("completeRetestsForScan — immutable evidence binding", () => {
    it("validates a same-revision repository retest against stored manifests", async () => {
      mockRepoRetestState({ baselineRevision: REV_A, retestRevision: REV_A })

      await completeRetestsForScan({ scanId: "scan-2", workspaceId: "workspace-1" })

      expect(prisma.finding.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "finding-1" },
          data: expect.objectContaining({
            verified: false,
            verificationStatus: "VALIDATED",
            verificationMethod: "RETEST",
          }),
        })
      )
      expect(prisma.findingVerification.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            status: "VALIDATED",
            sourceRevision: REV_A,
            evidence: expect.objectContaining({
              retestId: "retest-1",
              scannerSource: "secrets",
              baseline: expect.objectContaining({
                scanId: "scan-1",
                manifestChecksum: "checksum-scan-1",
                sourceRevision: REV_A,
              }),
              retest: expect.objectContaining({
                scanId: "scan-2",
                manifestChecksum: "checksum-scan-2",
                sourceRevision: REV_A,
              }),
              coverageReceiptIds: ["baseline-secrets", "retest-secrets"],
            }),
          }),
        })
      )
      expect(prisma.retest.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: "passed" }) })
      )
    })

    it("validates a changed-revision retest because a fix normally changes the SHA", async () => {
      mockRepoRetestState({ baselineRevision: REV_A, retestRevision: REV_B })

      await completeRetestsForScan({ scanId: "scan-2", workspaceId: "workspace-1" })

      expect(prisma.finding.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: "FIXED" }) })
      )
    })

    it.each([
      ["malformed baseline SHA", { baselineRevision: REV_SHORT }],
      ["malformed retest SHA", { retestRevision: REV_SHORT }],
    ])("leaves %s inconclusive and never fixes the finding", async (_label, overrides) => {
      mockRepoRetestState(overrides as never)

      await completeRetestsForScan({ scanId: "scan-2", workspaceId: "workspace-1" })

      expect(prisma.finding.update).not.toHaveBeenCalled()
      expect(prisma.findingVerification.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ status: "INCONCLUSIVE" }),
        })
      )
      expect(prisma.retest.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: "inconclusive" }) })
      )
    })

    it("leaves a missing baseline manifest inconclusive", async () => {
      mockRepoRetestState({ baselineManifest: null })

      await completeRetestsForScan({ scanId: "scan-2", workspaceId: "workspace-1" })

      expect(prisma.finding.update).not.toHaveBeenCalled()
      expect(prisma.findingVerification.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ status: "INCONCLUSIVE" }),
        })
      )
    })

    it("leaves a missing retest manifest inconclusive", async () => {
      mockRepoRetestState({ retestManifest: null })

      await completeRetestsForScan({ scanId: "scan-2", workspaceId: "workspace-1" })

      expect(prisma.finding.update).not.toHaveBeenCalled()
      expect(prisma.findingVerification.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ status: "INCONCLUSIVE" }),
        })
      )
    })

    it("leaves an engine-mixed origin inconclusive", async () => {
      mockRepoRetestState({
        candidates: [
          { findingId: "finding-1", scanId: "scan-1", scannerSource: "engine" },
          { findingId: "finding-1", scanId: "scan-1", scannerSource: "secrets" },
        ],
      })

      await completeRetestsForScan({ scanId: "scan-2", workspaceId: "workspace-1" })

      expect(prisma.finding.update).not.toHaveBeenCalled()
      expect(prisma.findingVerification.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ status: "INCONCLUSIVE" }),
        })
      )
    })

    it("leaves incomplete one-of-many deterministic coverage inconclusive", async () => {
      mockRepoRetestState({
        candidates: [
          { findingId: "finding-1", scanId: "scan-1", scannerSource: "secrets" },
          { findingId: "finding-1", scanId: "scan-1", scannerSource: "sca" },
        ],
        baselineReceipts: [
          { id: "baseline-secrets", controlId: "secrets", status: "COMPLETED" },
          { id: "baseline-sca", controlId: "sca", status: "BLOCKED" },
        ],
        retestReceipts: [
          { id: "retest-secrets", controlId: "secrets", status: "COMPLETED" },
          { id: "retest-sca", controlId: "sca", status: "COMPLETED" },
        ],
      })

      await completeRetestsForScan({ scanId: "scan-2", workspaceId: "workspace-1" })

      expect(prisma.finding.update).not.toHaveBeenCalled()
    })

    it("validates complete one-of-many deterministic coverage with a joined source label", async () => {
      mockRepoRetestState({
        candidates: [
          { findingId: "finding-1", scanId: "scan-1", scannerSource: "secrets" },
          { findingId: "finding-1", scanId: "scan-1", scannerSource: "sca" },
        ],
        baselineReceipts: [
          { id: "baseline-secrets", controlId: "secrets", status: "COMPLETED" },
          { id: "baseline-sca", controlId: "sca", status: "COMPLETED" },
        ],
        retestReceipts: [
          { id: "retest-secrets", controlId: "secrets", status: "COMPLETED" },
          { id: "retest-sca", controlId: "sca", status: "COMPLETED" },
        ],
      })

      await completeRetestsForScan({ scanId: "scan-2", workspaceId: "workspace-1" })

      expect(prisma.findingVerification.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            status: "VALIDATED",
            evidence: expect.objectContaining({
              scannerSource: "sca+secrets",
              coverageReceiptIds: [
                "baseline-sca",
                "baseline-secrets",
                "retest-sca",
                "retest-secrets",
              ],
            }),
          }),
        })
      )
    })

    it("marks a redetected finding failed without touching the finding record", async () => {
      mockRepoRetestState({ retestFindingIds: ["finding-1"] })

      await completeRetestsForScan({ scanId: "scan-2", workspaceId: "workspace-1" })

      expect(prisma.finding.update).not.toHaveBeenCalled()
      expect(prisma.retest.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: "failed" }) })
      )
      expect(prisma.findingVerification.upsert).not.toHaveBeenCalled()
    })

    it("is a no-op on a second finalization call after the retest is terminal", async () => {
      mockRepoRetestState()
      vi.mocked(prisma.retest.findMany).mockResolvedValue([] as never)

      await completeRetestsForScan({ scanId: "scan-2", workspaceId: "workspace-1" })

      expect(prisma.finding.update).not.toHaveBeenCalled()
      expect(prisma.scanResultManifest.findUnique).not.toHaveBeenCalled()
    })

    it("binds URL targets to matching URL checksums and rejects changed identity", async () => {
      const urlBaseline = manifestRow("scan-1", "target-1", "WEB_APP", {
        target: { id: "target-1", type: "WEB_APP", urlChecksum: URL_HASH_A },
      })
      const urlRetest = manifestRow("scan-2", "target-1", "WEB_APP", {
        target: { id: "target-1", type: "WEB_APP", urlChecksum: URL_HASH_A },
      })
      mockRepoRetestState({
        baselineManifest: urlBaseline,
        retestManifest: urlRetest,
        candidates: [{ findingId: "finding-1", scanId: "scan-1", scannerSource: "url" }],
        baselineReceipts: [{ id: "baseline-url", controlId: "url", status: "COMPLETED" }],
        retestReceipts: [{ id: "retest-url", controlId: "url", status: "COMPLETED" }],
      })

      await completeRetestsForScan({ scanId: "scan-2", workspaceId: "workspace-1" })

      expect(prisma.finding.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: "FIXED" }) })
      )
      expect(prisma.findingVerification.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            status: "VALIDATED",
            evidence: expect.objectContaining({
              baseline: expect.objectContaining({ targetUrlChecksum: URL_HASH_A }),
              retest: expect.objectContaining({ targetUrlChecksum: URL_HASH_A }),
            }),
          }),
        })
      )

      vi.clearAllMocks()
      mockRepoRetestState({
        baselineManifest: urlBaseline,
        retestManifest: manifestRow("scan-2", "target-1", "WEB_APP", {
          target: { id: "target-1", type: "WEB_APP", urlChecksum: URL_HASH_B },
        }),
        candidates: [{ findingId: "finding-1", scanId: "scan-1", scannerSource: "url" }],
        baselineReceipts: [{ id: "baseline-url", controlId: "url", status: "COMPLETED" }],
        retestReceipts: [{ id: "retest-url", controlId: "url", status: "COMPLETED" }],
      })

      await completeRetestsForScan({ scanId: "scan-2", workspaceId: "workspace-1" })

      expect(prisma.finding.update).not.toHaveBeenCalled()
      expect(prisma.findingVerification.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ create: expect.objectContaining({ status: "INCONCLUSIVE" }) })
      )
    })

    it("rejects a missing URL checksum for a URL target", async () => {
      mockRepoRetestState({
        baselineManifest: manifestRow("scan-1", "target-1", "WEB_APP", {
          target: { id: "target-1", type: "WEB_APP", urlChecksum: null },
        }),
        retestManifest: manifestRow("scan-2", "target-1", "WEB_APP", {
          target: { id: "target-1", type: "WEB_APP", urlChecksum: URL_HASH_A },
        }),
        candidates: [{ findingId: "finding-1", scanId: "scan-1", scannerSource: "url" }],
        baselineReceipts: [{ id: "baseline-url", controlId: "url", status: "COMPLETED" }],
        retestReceipts: [{ id: "retest-url", controlId: "url", status: "COMPLETED" }],
      })

      await completeRetestsForScan({ scanId: "scan-2", workspaceId: "workspace-1" })

      expect(prisma.finding.update).not.toHaveBeenCalled()
      expect(prisma.findingVerification.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ create: expect.objectContaining({ status: "INCONCLUSIVE" }) })
      )
    })
  })
})
