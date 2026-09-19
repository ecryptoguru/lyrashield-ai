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
    terminalOutcome: { status: "COMPLETED" },
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
  vi.mocked(prisma.scanResultManifest.findUnique).mockImplementation((async (args: unknown) => {
    const scanId = (args as { where?: { scanId?: unknown } } | undefined)?.where?.scanId
    if (scanId === "scan-1") return baselineManifest
    if (scanId === "scan-2") return retestManifest
    return null
  }) as never)
  vi.mocked(prisma.scanCoverageReceipt.findMany).mockImplementation((async (args: unknown) => {
    const scanId = (args as { where?: { scanId?: unknown } } | undefined)?.where?.scanId
    if (scanId === "scan-1") return baselineReceipts
    if (scanId === "scan-2") return retestReceipts
    return []
  }) as never)
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
    expect(receipts).toHaveLength(59)
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

  it("marks the engine NOT_APPLICABLE on deterministic-only URL tiers and evaluates it when engine-backed", () => {
    const base = {
      scanId: "scan-url",
      target: { id: "t1", type: "WEB_APP", url: "https://example.com" },
      sourceCheckoutAvailable: false,
      engineFindingCount: 0,
      coverageIssues: [],
    }

    const safe = buildCoverageReceipts({ ...base, scanId: "scan-url-safe" })
    expect(safe.find((receipt) => receipt.scanner === "engine")).toMatchObject({
      status: "NOT_APPLICABLE",
      reason: expect.stringContaining("Deterministic-only tier"),
      metadata: expect.objectContaining({ outcome: "NOT_ASSESSED" }),
    })

    const backed = buildCoverageReceipts({
      ...base,
      scanId: "scan-url-std",
      engineBacked: true,
      engineFindingCount: 1,
    })
    expect(backed.find((receipt) => receipt.scanner === "engine")).toMatchObject({
      status: "COMPLETED",
    })

    const blocked = buildCoverageReceipts({
      ...base,
      scanId: "scan-url-blocked",
      engineBacked: true,
      coverageIssues: [
        { scanner: "engine", status: "bounded", reason: "Relay denied out-of-scope host" },
      ],
    })
    expect(blocked.find((receipt) => receipt.scanner === "engine")).toMatchObject({
      status: "BLOCKED",
      reason: "Relay denied out-of-scope host",
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

    // Control 29 gained deterministic source coverage from the sast family:
    // on a repo with a checkout it is applicable and the matched rank detects.
    expect(receipts.find((receipt) => receipt.controlId === "vibe-29")).toMatchObject({
      status: "COMPLETED",
      metadata: expect.objectContaining({ outcome: "DETECTED" }),
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
      contractVersion: "url-scan/3.0.0",
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
            scannerContractVersion: "2026-09-13a",
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

  it("versions and checksum-binds the durable terminal outcome", async () => {
    vi.mocked(prisma.scanResultManifest.findUnique).mockResolvedValue(null)

    const persist = async (status: "COMPLETED" | "FAILED") => {
      vi.mocked(prisma.scanResultManifest.create).mockClear()
      await persistResultManifest({
        scanId: `scan-${status.toLowerCase()}`,
        target: { id: "target-1", type: "URL", url: "https://example.com" },
        sourceCheckoutAvailable: false,
        engineFindingCount: 0,
        coverageIssues: [],
        terminalOutcome: {
          status,
          errorCategory: status === "FAILED" ? "TIMEOUT" : null,
          errorMessage: status === "FAILED" ? "Scan timed out" : null,
        },
      })
      return vi.mocked(prisma.scanResultManifest.create).mock.calls[0][0].data as {
        version: number
        checksum: string
        manifest: { version: number; terminalOutcome: { status: string } }
      }
    }

    const completed = await persist("COMPLETED")
    const failed = await persist("FAILED")

    expect(completed).toMatchObject({
      version: 7,
      manifest: { version: 7, terminalOutcome: { status: "COMPLETED" } },
    })
    expect(failed.checksum).not.toBe(completed.checksum)
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

    it.each(["COMPLETED", "PARTIAL"])(
      "reads v7 deterministic source receipts with %s outcome",
      async (status) => {
        mockRepoRetestState({
          retestManifest: manifestRow("scan-2", "target-1", "REPO", {
            engineExecution: { sourceRevision: null },
            sourceExecution: { kind: "deterministic_retest", sourceRevision: REV_B },
            terminalOutcome: { status },
          }),
        })
        await completeRetestsForScan({ scanId: "scan-2", workspaceId: "workspace-1" })
        if (status === "COMPLETED")
          expect(prisma.finding.update).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ status: "FIXED" }) })
          )
        else expect(prisma.finding.update).not.toHaveBeenCalled()
      }
    )
    it.each(["PARTIAL", "FAILED", undefined])(
      "does not validate an engine baseline with %s terminal status",
      async (status) => {
        mockRepoRetestState({
          baselineManifest: manifestRow("scan-1", "target-1", "REPO", {
            terminalOutcome: status ? { status } : undefined,
          }),
        })
        await completeRetestsForScan({ scanId: "scan-2", workspaceId: "workspace-1" })
        expect(prisma.finding.update).not.toHaveBeenCalled()
        expect(prisma.findingVerification.upsert).toHaveBeenCalledWith(
          expect.objectContaining({
            create: expect.objectContaining({
              status: "INCONCLUSIVE",
              reason: expect.stringContaining("completed baseline and retest terminal receipts"),
            }),
          })
        )
      }
    )
    it.each(["PARTIAL", "FAILED", undefined])(
      "does not validate an engine retest with %s terminal status",
      async (status) => {
        mockRepoRetestState({
          retestManifest: manifestRow("scan-2", "target-1", "REPO", {
            terminalOutcome: status ? { status } : undefined,
          }),
        })
        await completeRetestsForScan({ scanId: "scan-2", workspaceId: "workspace-1" })
        expect(prisma.finding.update).not.toHaveBeenCalled()
      }
    )
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

    it.each(["ai_app_security", "ml_supply_chain"])(
      "validates complete %s deterministic coverage",
      async (scannerSource) => {
        mockRepoRetestState({
          candidates: [{ findingId: "finding-1", scanId: "scan-1", scannerSource }],
          baselineReceipts: [
            { id: `baseline-${scannerSource}`, controlId: scannerSource, status: "COMPLETED" },
          ],
          retestReceipts: [
            { id: `retest-${scannerSource}`, controlId: scannerSource, status: "COMPLETED" },
          ],
        })

        await completeRetestsForScan({ scanId: "scan-2", workspaceId: "workspace-1" })

        expect(prisma.finding.update).toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ status: "FIXED" }) })
        )
      }
    )

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

  describe("run.json 1.1 scoped coverage and artifact evidence", () => {
    it("persists model-declared coverage under namespaced receipt ids", async () => {
      vi.mocked(prisma.scanResultManifest.findUnique).mockResolvedValue(null)

      await persistResultManifest({
        scanId: "scan-scoped",
        target: { id: "target-1", type: "URL", url: "https://example.com" },
        sourceCheckoutAvailable: false,
        engineFindingCount: 1,
        coverageIssues: [],
        scopedCoverage: {
          entries: [
            {
              id: "a1b2c3",
              subject: "src/auth/login.ts — SQL injection",
              outcome: "reported",
              reason: "vuln-1-1-0001",
              evidenceRefs: ["42"],
              recordedBy: "vulnerability-scanner",
              previousOutcomes: ["needs_follow_up"],
            },
            {
              id: "7a8b9c",
              subject: "src/api/admin.ts",
              outcome: "needs_follow_up",
              reason: "Agent limit reached mid-review.",
            },
          ],
          gaps: [
            {
              kind: "agent_recorded_no_coverage",
              subject: "config-scanner",
              detail: "config-scanner ran without recording coverage.",
            },
          ],
          completeness: { complete: false, caveats: ["coverage is agent-reported"] },
        },
      })

      const receiptCall = vi.mocked(prisma.scanCoverageReceipt.createMany).mock.calls[0][0] as {
        data: Array<Record<string, unknown>>
      }
      const scoped = receiptCall.data.filter(
        (row) => typeof row.controlId === "string" && row.controlId.startsWith("engine-scope:")
      )
      expect(scoped).toHaveLength(2)
      expect(scoped.find((row) => row.controlId === "engine-scope:a1b2c3")).toMatchObject({
        status: "COMPLETED",
        subject: "src/auth/login.ts — SQL injection",
        metadata: expect.objectContaining({
          declaredBy: "engine_model",
          outcome: "reported",
          evidenceRefs: ["42"],
          recordedBy: "vulnerability-scanner",
          previousOutcomes: ["needs_follow_up"],
        }),
      })
      expect(scoped.find((row) => row.controlId === "engine-scope:7a8b9c")).toMatchObject({
        status: "PARTIAL",
        subject: "src/api/admin.ts",
      })
      const gaps = receiptCall.data.filter(
        (row) => typeof row.controlId === "string" && row.controlId.startsWith("engine-gap:")
      )
      expect(gaps).toHaveLength(1)
      expect(gaps[0]).toMatchObject({
        status: "PARTIAL",
        subject: "config-scanner",
        metadata: expect.objectContaining({
          declaredBy: "engine_runtime",
          kind: "agent_recorded_no_coverage",
        }),
      })
      // Scoped rows never collide with deterministic families or vibe controls.
      expect(
        receiptCall.data.every((row) =>
          !String(row.controlId).startsWith("engine-scope:") &&
          !String(row.controlId).startsWith("engine-gap:")
            ? !String(row.scanner).startsWith("engine-")
            : true
        )
      ).toBe(true)
    })

    it("binds artifact checksums and ingestion warnings into the immutable manifest", async () => {
      vi.mocked(prisma.scanResultManifest.findUnique).mockResolvedValue(null)

      await persistResultManifest({
        scanId: "scan-artifacts",
        target: { id: "target-1", type: "URL", url: "https://example.com" },
        sourceCheckoutAvailable: false,
        engineFindingCount: 2,
        coverageIssues: [],
        ingestionWarnings: ["coverage.json: malformed entries dropped"],
        scopedCoverage: {
          schemaVersion: "1",
          entries: [{ id: "a1b2c3", subject: "src/auth/login.ts", outcome: "reported" }],
          gaps: [],
          completeness: { complete: true, caveats: [] },
        },
        threatModel: { checksum: "a".repeat(64), byteLength: 512, modelCount: 1 },
        httpExchangeEvidence: {
          checksum: "b".repeat(64),
          byteLength: 1024,
          exchangeCount: 2,
        },
      })

      const createCall = vi.mocked(prisma.scanResultManifest.create).mock.calls[0][0] as {
        data: { manifest: Record<string, unknown> }
      }
      expect(createCall.data.manifest).toMatchObject({
        version: 7,
        ingestionWarnings: ["coverage.json: malformed entries dropped"],
        threatModel: { checksum: "a".repeat(64), byteLength: 512, modelCount: 1 },
        httpExchangeEvidence: {
          checksum: "b".repeat(64),
          byteLength: 1024,
          exchangeCount: 2,
        },
      })
      expect(createCall.data.manifest.scopedCoverage).toEqual({
        schemaVersion: "1",
        entryCount: 1,
        gapCount: 0,
        completeness: { complete: true, caveats: [] },
      })
    })

    it("carries richer evidence hashes in the detection ledger without promoting trust", async () => {
      vi.mocked(prisma.findingCandidate.upsert).mockResolvedValue({ id: "candidate-1" } as never)

      await persistDetectionReceipt({
        scanId: "scan-1",
        workspaceId: "workspace-1",
        targetId: "target-1",
        findingId: "finding-1",
        severity: "HIGH",
        dedupeKey: "dedupe-1",
        httpExchangeArtifactChecksum: "c".repeat(64),
        finding: {
          id: "engine-1",
          title: "SQL injection in login handler",
          severity: "high",
          timestamp: "2026-09-10T11:03:12Z",
          engine_confidence: "high",
          counterevidence: "A WAF rule could still block exploitation.",
          confidence_rationale: "Sink reachable; payload round-trips.",
          severity_change_conditions: "Downgrade if auth precedes handler.",
          fix_verification: {
            kind: "engine_attestation",
            statement: "Filing agent replayed the request.",
            method: "proxy_replay",
            evidence_refs: ["42"],
          },
          contextual_cvss_reasoning: "Unauthenticated remote reach.",
          advisory_cvss: { score: 8.6, vector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/C:H/I:H/A:H" },
          http_exchange_ids: ["42"],
          update_history: [{ timestamp: "t", fields: ["severity"] }],
          evidence_warnings: ["poc script omitted"],
          evidence_contract_version: "1.1",
          engine_verification_state: "engine_asserted",
          poc_script_code: "raw-script-body-must-not-persist",
        },
      })

      const upsert = vi.mocked(prisma.findingCandidate.upsert).mock.calls[0][0] as {
        create: { payload: Record<string, unknown> }
      }
      const payload = upsert.create.payload
      // Structured values persist; every other new field lands in contentHashes.
      expect(payload.advisoryCvss).toEqual({
        score: 8.6,
        vector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/C:H/I:H/A:H",
      })
      expect(payload.httpExchangeIds).toEqual(["42"])
      const hashes = payload.contentHashes as Record<string, string>
      for (const key of [
        "engineConfidence",
        "counterevidence",
        "confidenceRationale",
        "severityChangeConditions",
        "fixVerification",
        "contextualCvssReasoning",
        "updateHistory",
        "evidenceWarnings",
        "evidenceContractVersion",
        "engineVerificationState",
      ]) {
        expect(hashes[key], key).toMatch(/^[0-9a-f]{64}$/)
      }
      // The candidate ledger never stores raw PoC or verification claims.
      expect(JSON.stringify(payload)).not.toContain("raw-script-body")
      expect(JSON.stringify(payload)).not.toContain('"verified"')

      // An engine-source finding records an ENGINE_CLAIM detection receipt —
      // never a verification — even with richer 1.1 evidence attached.
      expect(prisma.findingVerification.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            status: "DETECTED",
            method: "ENGINE_CLAIM",
            evidence: expect.objectContaining({
              httpExchangeArtifactChecksum: "c".repeat(64),
            }),
          }),
        })
      )
    })
  })
})
