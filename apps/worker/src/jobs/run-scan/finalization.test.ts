import { beforeEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { parseWriterTuple } from "../../engine/fixtures/mutate-http-tuple"
import { parseEngineOutput } from "../../engine/output-parser"

const mocks = vi.hoisted(() => ({
  addScanEvent: vi.fn(),
  assertEvidenceEncrypted: vi.fn(),
  completeRetestsForScan: vi.fn(),
  completeScanWithScore: vi.fn(),
  createAiSecurityScoreSnapshot: vi.fn(),
  notifyCriticalFinding: vi.fn(),
  notifyScanCompleted: vi.fn(),
  notifyScanFailed: vi.fn(),
  persistFindings: vi.fn(),
  persistResultManifest: vi.fn(),
  prisma: {
    scan: { update: vi.fn() },
    workspace: { findFirst: vi.fn() },
    finding: { findMany: vi.fn(), create: vi.fn() },
    evidence: { findMany: vi.fn(), createMany: vi.fn() },
    findingCandidate: { upsert: vi.fn() },
    findingVerification: { upsert: vi.fn() },
  },
  qualifyReferralForWorkspace: vi.fn(),
  refreshGateVerdictAfterTerminalScan: vi.fn(),
  updateScanStatus: vi.fn(),
  uploadScanArtifact: vi.fn(),
  uploadEvidence: vi.fn(),
  withScanFinalizationClaim: vi.fn(),
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))

vi.mock("@lyrashield/db", async () => ({
  ...(await import("@lyrashield/db/src/evidence-observation")),
  resolveDbPoolMax: () => 4,
  withWorkspaceRLS: (_workspace: string, fn: (tx: typeof mocks.prisma) => unknown) =>
    fn(mocks.prisma),
  addScanEvent: mocks.addScanEvent,
  assertEvidenceEncrypted: mocks.assertEvidenceEncrypted,
  completeScanWithScore: mocks.completeScanWithScore,
  createAiSecurityScoreSnapshot: mocks.createAiSecurityScoreSnapshot,
  prisma: mocks.prisma,
  qualifyReferralForWorkspace: mocks.qualifyReferralForWorkspace,
  updateScanStatus: mocks.updateScanStatus,
  withScanFinalizationClaim: mocks.withScanFinalizationClaim,
}))
vi.mock("@lyrashield/logger", () => ({ logger: mocks.logger }))
vi.mock("../../engine/finding-persister", () => ({ persistFindings: mocks.persistFindings }))
vi.mock("../../engine/evidence-storage", () => ({
  EvidenceStorageConfigurationError: class extends Error {},
  uploadScanArtifact: mocks.uploadScanArtifact,
  uploadEvidence: mocks.uploadEvidence,
}))
vi.mock("../../engine/result-integrity", async () => ({
  ...(await import("../../engine/result-integrity/detection-receipt")),
  completeRetestsForScan: mocks.completeRetestsForScan,
  persistResultManifest: mocks.persistResultManifest,
}))
vi.mock("./lifecycle-utils", () => ({
  refreshGateVerdictAfterTerminalScan: mocks.refreshGateVerdictAfterTerminalScan,
}))
vi.mock("../../notifications", () => ({
  notifyCriticalFinding: mocks.notifyCriticalFinding,
  notifyScanCompleted: mocks.notifyScanCompleted,
  notifyScanFailed: mocks.notifyScanFailed,
}))

import { finalizeEarlyEngineTerminal, finalizeScanLifecycle } from "./finalization"
import type { EngineRunResult } from "../../engine/runner"

const findings = [
  { id: "finding-new", isNew: true, severity: "CRITICAL", title: "New issue" },
  { id: "finding-existing", isNew: false, severity: "HIGH", title: "Existing issue" },
] as never[]

function params(overrides: Record<string, unknown> = {}) {
  const callOrder: string[] = []
  mocks.persistFindings.mockImplementation(async () => {
    callOrder.push("findings")
    return findings
  })
  mocks.prisma.scan.update.mockImplementation(async () => {
    callOrder.push("summary")
    return { id: "scan-1" }
  })
  mocks.persistResultManifest.mockImplementation(async () => {
    callOrder.push("manifest")
  })
  mocks.completeRetestsForScan.mockImplementation(async () => {
    callOrder.push("retests")
  })
  mocks.updateScanStatus.mockImplementation(async () => {
    callOrder.push("terminal-status")
  })
  mocks.completeScanWithScore.mockImplementation(async () => {
    callOrder.push("score")
  })
  mocks.refreshGateVerdictAfterTerminalScan.mockImplementation(async () => {
    callOrder.push("gate-refresh")
  })

  const onDurableResult = vi.fn((result: unknown) => {
    callOrder.push("durable-result")
    return result
  })
  const meterEngineRun = vi.fn(async (_outcome: unknown, finishEvidence?: () => Promise<void>) => {
    callOrder.push("meter")
    await finishEvidence?.()
  })
  const base = {
    scanId: "scan-1",
    workspaceId: "workspace-1",
    targetId: "target-1",
    target: {
      id: "target-1",
      type: "REPO",
      repoFullName: "owner/repo",
      branch: "main",
      url: null,
    },
    grace: { assertRemaining: vi.fn() },
    engineResult: {
      sourceRevision: "a".repeat(40),
      sourceCheckoutPath: "/tmp/scan-1",
      output: {
        findingCount: 2,
        ingestionIssues: [],
        scopedCoverage: [],
        summary: "Two findings retained",
      },
    },
    orchestratorResult: {
      allFindings: findings,
      engineFindings: [{ id: "engine-finding" }],
      coverageIssues: [],
    },
    coverageMatchedControlRanks: [1, 2],
    routingCoverageIssue: null,
    truncationCoverageIssue: {
      scanner: "engine",
      status: "bounded",
      subject: "runtime-deadline",
      reason: "partial findings preserved",
    },
    engineBacked: true,
    budgetExceeded: false,
    billedCostUsd: 0.37,
    costReconciled: true,
    maxBudgetUsd: 2,
    workerExecution: { executionDigest: "worker-digest" },
    terminalErrorAfterMeter: vi.fn(() => null),
    meterEngineRun,
    onDurableResult,
    callOrder,
    ...overrides,
  }

  return base
}

describe("finalizeScanLifecycle", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.addScanEvent.mockResolvedValue(undefined)
    mocks.assertEvidenceEncrypted.mockImplementation(() => undefined)
    mocks.completeRetestsForScan.mockResolvedValue(undefined)
    mocks.completeScanWithScore.mockResolvedValue(undefined)
    mocks.createAiSecurityScoreSnapshot.mockResolvedValue(undefined)
    mocks.notifyCriticalFinding.mockResolvedValue(undefined)
    mocks.notifyScanCompleted.mockResolvedValue(undefined)
    mocks.notifyScanFailed.mockResolvedValue(undefined)
    mocks.persistFindings.mockResolvedValue(findings)
    mocks.persistResultManifest.mockResolvedValue(undefined)
    mocks.prisma.scan.update.mockResolvedValue({ id: "scan-1" })
    mocks.prisma.workspace.findFirst.mockResolvedValue({ name: "Workspace" })
    mocks.qualifyReferralForWorkspace.mockResolvedValue(undefined)
    mocks.refreshGateVerdictAfterTerminalScan.mockResolvedValue(undefined)
    mocks.updateScanStatus.mockResolvedValue(undefined)
    mocks.uploadScanArtifact.mockResolvedValue(undefined)
    mocks.withScanFinalizationClaim.mockImplementation(
      async (_scanId: string, _workspaceId: string, finalize: () => Promise<unknown>) => ({
        status: "finalized",
        value: await finalize(),
      })
    )
  })

  it("does not upload a foreign HTTP sibling into the current scan during finalization", async () => {
    const read = (name: string) =>
      readFileSync(new URL(`../../engine/fixtures/run-json-1.2/${name}`, import.meta.url), "utf8")
    const run = JSON.parse(read("run.json"))
    const exported = JSON.parse(read("http_exchanges.json"))
    exported.binding.run_id = exported.binding.run_name = "other-run"
    exported.exchanges[0].request.body_sample = "foreign capture content"
    const exportRaw = JSON.stringify(exported)
    const digest = createHash("sha256").update(exportRaw).digest("hex")
    run.result_manifest.artifacts["http_exchanges.json"] = {
      path: "http_exchanges.json",
      bytes: Buffer.byteLength(exportRaw),
      sha256: digest,
    }
    run.evidence_export.sha256 = digest
    const output = parseEngineOutput(
      read("vulnerabilities.json"),
      JSON.stringify(run),
      { httpExchangesRaw: exportRaw },
      { expectedRunName: "task5-writer-fixture" }
    )
    const input = params({
      scanId: "task5-writer-fixture",
      engineResult: { output },
      orchestratorResult: {
        allFindings: output.vulnerabilities,
        engineFindings: output.vulnerabilities,
        coverageIssues: [],
      },
    })
    await finalizeScanLifecycle(input as never)
    expect(mocks.uploadScanArtifact).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "http_exchanges" })
    )
    expect(mocks.persistResultManifest).toHaveBeenCalledWith(
      expect.objectContaining({ scanId: "task5-writer-fixture", httpExchangeEvidence: null })
    )
    expect(mocks.persistFindings.mock.calls[0]?.[0]).not.toHaveProperty(
      "httpExchangeArtifactChecksum"
    )
    expect(mocks.persistFindings).toHaveBeenCalledWith(
      expect.objectContaining({
        vulnerabilities: expect.arrayContaining([
          expect.objectContaining({ pending_http_exchange_ids: ["18"] }),
        ]),
      })
    )
  })

  it.each([
    "receipt false",
    "receipt absent",
    "receipt string",
    "unbounded pending overlap",
    "foreign body",
    "orphan body",
    "duplicate body",
    "absent owners",
    "foreign owner",
    "stale owner",
    "downgraded empty",
    "downgraded malformed",
  ])("quarantines %s before upload or capture-bearing persistence", async (change) => {
    const output = parseWriterTuple(change)
    const input = params({
      scanId: "task5-writer-fixture",
      engineResult: { output },
      orchestratorResult: {
        allFindings: output.vulnerabilities,
        engineFindings: output.vulnerabilities,
        coverageIssues: [],
      },
    })
    await finalizeScanLifecycle(input as never)
    expect(mocks.uploadScanArtifact).not.toHaveBeenCalled()
    expect(output.httpExchangeExport).toBeNull()
    expect(output.ingestionIssues.length).toBeGreaterThan(0)
    for (const finding of output.vulnerabilities) {
      expect(finding.pending_http_exchange_ids).toEqual(
        change === "unbounded pending overlap" ? undefined : ["18"]
      )
      expect(finding.http_exchange_ids).toBeUndefined()
    }
  })

  it("retries storage for the same 1.2 scan before any immutable capture receipt", async () => {
    const output = parseWriterTuple()
    const input = params({
      scanId: "task5-writer-fixture",
      engineResult: { output },
      orchestratorResult: {
        allFindings: output.vulnerabilities,
        engineFindings: output.vulnerabilities,
        coverageIssues: [],
      },
    })
    const { persistFindings } = await vi.importActual<
      typeof import("../../engine/finding-persister")
    >("../../engine/finding-persister")
    mocks.persistFindings.mockImplementation(persistFindings)
    mocks.prisma.evidence.findMany.mockResolvedValue([])
    mocks.prisma.finding.findMany.mockResolvedValue([])
    mocks.prisma.finding.create.mockResolvedValue({ id: "finding-1" })
    mocks.prisma.findingCandidate.upsert.mockResolvedValue({ id: "candidate-1" })
    mocks.uploadEvidence.mockResolvedValue({
      storageUri: "private://context",
      checksum: "c".repeat(64),
      encryptionKeyRef: "vault://test",
    })
    const checksum = createHash("sha256").update(output.httpExchangeExport!.document).digest("hex")
    mocks.uploadScanArtifact
      .mockRejectedValueOnce(new Error("storage unavailable"))
      .mockRejectedValueOnce(new Error("storage still unavailable"))
      .mockRejectedValueOnce(new Error("temporary transport failure"))
      .mockResolvedValueOnce({
        checksum,
        byteLength: 100,
        encryptionKeyRef: "vault://test",
      })
    await expect(finalizeScanLifecycle(input as never)).rejects.toThrow()
    expect(mocks.persistFindings).not.toHaveBeenCalled()
    expect(mocks.prisma.findingCandidate.upsert).not.toHaveBeenCalled()
    expect(mocks.prisma.findingVerification.upsert).not.toHaveBeenCalled()
    await finalizeScanLifecycle(input as never)
    expect(mocks.uploadScanArtifact).toHaveBeenCalledTimes(4)
    expect(mocks.persistFindings).toHaveBeenCalledOnce()
    const claim = mocks.uploadEvidence.mock.calls.find(([input]) => input.type === "claim_context")
    expect(JSON.parse(claim![0].content)).toMatchObject({
      httpExchangeArtifactChecksum: checksum,
      httpExchangeIds: ["17"],
      pendingHttpExchangeIds: ["18"],
    })
    expect(
      mocks.prisma.findingCandidate.upsert.mock.calls[0][0].create.payload.httpExchangeIds
    ).toEqual(["17"])
    expect(mocks.prisma.findingVerification.upsert.mock.calls[0][0].create).toMatchObject({
      status: "DETECTED",
      evidence: { httpExchangeIds: ["17"], httpExchangeArtifactChecksum: checksum },
    })
    expect(mocks.persistFindings.mock.calls[0][0]).toMatchObject({
      httpExchangeArtifactChecksum: checksum,
      vulnerabilities: [expect.objectContaining({ http_exchange_ids: ["17"] })],
    })
  })

  it("uploads only owned exchange bodies, excluding opaque target metadata from the 1.2 document", async () => {
    const output = parseWriterTuple("private target metadata")
    const document = output.httpExchangeExport!.document
    mocks.uploadScanArtifact.mockResolvedValue({
      checksum: createHash("sha256").update(document).digest("hex"),
      encryptionKeyRef: "vault://test",
    })
    await finalizeScanLifecycle(
      params({
        scanId: "task5-writer-fixture",
        engineResult: { output },
        orchestratorResult: {
          allFindings: output.vulnerabilities,
          engineFindings: output.vulnerabilities,
          coverageIssues: [],
        },
      }) as never
    )
    const content = mocks.uploadScanArtifact.mock.calls[0][0].content
    expect(content).not.toContain("unowned body in opaque metadata")
    expect(
      JSON.parse(content).exchanges.map(
        (entry: { proxy_request_id: string }) => entry.proxy_request_id
      )
    ).toEqual(["17"])
  })

  it("refuses capture-bearing writes when storage returns a different checksum", async () => {
    const output = parseWriterTuple()
    const input = params({
      scanId: "task5-writer-fixture",
      engineResult: { output },
      orchestratorResult: {
        allFindings: output.vulnerabilities,
        engineFindings: output.vulnerabilities,
        coverageIssues: [],
      },
    })
    mocks.uploadScanArtifact.mockResolvedValue({
      checksum: "0".repeat(64),
      encryptionKeyRef: "vault://test",
    })
    await expect(finalizeScanLifecycle(input as never)).rejects.toThrow("checksum")
    expect(mocks.persistFindings).not.toHaveBeenCalled()
  })

  it("seals findings and the manifest before retests, score and durable completion", async () => {
    const input = params()

    const result = await finalizeScanLifecycle(input as never)

    expect(result).toMatchObject({
      status: "finalized",
      value: {
        persistedFindings: findings,
        newFindings: 1,
        scanSummary: "Two findings retained",
        terminalResult: null,
      },
    })
    expect(input.callOrder).toEqual([
      "findings",
      "summary",
      "meter",
      "manifest",
      "retests",
      "score",
      "gate-refresh",
      "durable-result",
    ])
    expect(mocks.persistResultManifest).toHaveBeenCalledWith(
      expect.objectContaining({
        scanId: "scan-1",
        engineFindingCount: 1,
        coverageIssues: [expect.objectContaining({ subject: "runtime-deadline" })],
        terminalOutcome: { status: "COMPLETED", errorCategory: null, errorMessage: null },
      })
    )
    expect(mocks.completeScanWithScore).toHaveBeenCalledWith(
      "scan-1",
      "workspace-1",
      "Two findings retained"
    )
    expect(mocks.updateScanStatus).not.toHaveBeenCalled()
    expect(input.meterEngineRun).toHaveBeenCalledWith("completed", expect.any(Function))
  })

  it("preserves partial findings and refreshes the gate without promoting a score", async () => {
    const input = params({
      terminalErrorAfterMeter: vi.fn(() => ({
        status: "PARTIAL",
        errorCategory: "RUNTIME_LIMIT",
        errorMessage: "Engine reached its runtime limit",
      })),
    })

    const result = await finalizeScanLifecycle(input as never)

    expect(result).toMatchObject({
      status: "finalized",
      value: {
        persistedFindings: findings,
        newFindings: 1,
        terminalResult: {
          status: "failed",
          errorCategory: "RUNTIME_LIMIT",
          errorMessage: "Engine reached its runtime limit",
        },
      },
    })
    expect(input.meterEngineRun).toHaveBeenCalledWith("partial", expect.any(Function))
    expect(mocks.persistResultManifest).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalOutcome: {
          status: "PARTIAL",
          errorCategory: "RUNTIME_LIMIT",
          errorMessage: "Engine reached its runtime limit",
        },
      })
    )
    expect(mocks.updateScanStatus).toHaveBeenCalledWith(
      "scan-1",
      "PARTIAL",
      expect.objectContaining({ actualCostCents: 37, errorCategory: "RUNTIME_LIMIT" })
    )
    expect(mocks.refreshGateVerdictAfterTerminalScan).toHaveBeenCalledWith(
      "workspace-1",
      "target-1",
      "scan-1"
    )
    expect(mocks.completeScanWithScore).not.toHaveBeenCalled()
    expect(input.onDurableResult).toHaveBeenCalledWith({
      status: "failed",
      errorCategory: "RUNTIME_LIMIT",
      errorMessage: "Engine reached its runtime limit",
    })
  })

  it("records a budget stop after retaining evidence and never promotes a score", async () => {
    const input = params({ budgetExceeded: true, billedCostUsd: 2 })

    const result = await finalizeScanLifecycle(input as never)

    expect(result).toMatchObject({
      status: "finalized",
      value: {
        persistedFindings: findings,
        terminalResult: {
          status: "failed",
          errorCategory: "BUDGET_EXCEEDED",
          errorMessage: "Protected run limit reached",
        },
      },
    })
    expect(input.meterEngineRun).toHaveBeenCalledWith("failed", expect.any(Function))
    expect(mocks.persistResultManifest).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalOutcome: {
          status: "STOPPED_BUDGET",
          errorCategory: "BUDGET_EXCEEDED",
          errorMessage: "Protected run limit reached",
        },
      })
    )
    expect(mocks.updateScanStatus).toHaveBeenCalledWith(
      "scan-1",
      "STOPPED_BUDGET",
      expect.objectContaining({ actualCostCents: 200, errorCategory: "BUDGET_EXCEEDED" })
    )
    expect(mocks.refreshGateVerdictAfterTerminalScan).toHaveBeenCalledWith(
      "workspace-1",
      "target-1",
      "scan-1"
    )
    expect(mocks.completeScanWithScore).not.toHaveBeenCalled()
  })

  it("uses a terminal error discovered during metering to seal the final state", async () => {
    let terminalError: {
      status: "FAILED"
      errorCategory: string
      errorMessage: string
    } | null = null
    const meterEngineRun = vi.fn(async (outcome: unknown, finishEvidence?: () => Promise<void>) => {
      expect(outcome).toBe("completed")
      terminalError = {
        status: "FAILED",
        errorCategory: "AGENT_MINUTES_EXHAUSTED",
        errorMessage: "Protected run minute limit reached",
      }
      await finishEvidence?.()
    })
    const input = params({
      meterEngineRun,
      terminalErrorAfterMeter: vi.fn(() => terminalError),
    })

    const result = await finalizeScanLifecycle(input as never)

    expect(result).toMatchObject({
      status: "finalized",
      value: {
        terminalResult: {
          status: "failed",
          errorCategory: "AGENT_MINUTES_EXHAUSTED",
          errorMessage: "Protected run minute limit reached",
        },
      },
    })
    expect(mocks.persistResultManifest).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalOutcome: {
          status: "FAILED",
          errorCategory: "AGENT_MINUTES_EXHAUSTED",
          errorMessage: "Protected run minute limit reached",
        },
      })
    )
    expect(mocks.updateScanStatus).toHaveBeenCalledWith(
      "scan-1",
      "FAILED",
      expect.objectContaining({ errorCategory: "AGENT_MINUTES_EXHAUSTED" })
    )
    expect(mocks.completeScanWithScore).not.toHaveBeenCalled()
    expect(mocks.refreshGateVerdictAfterTerminalScan).toHaveBeenCalledWith(
      "workspace-1",
      "target-1",
      "scan-1"
    )
  })

  it("does not start persistence or settlement when cancellation owns the finalization race", async () => {
    mocks.withScanFinalizationClaim.mockResolvedValueOnce({ status: "cancelled" })
    const input = params()

    await expect(finalizeScanLifecycle(input as never)).resolves.toEqual({ status: "cancelled" })

    expect(mocks.persistFindings).not.toHaveBeenCalled()
    expect(mocks.persistResultManifest).not.toHaveBeenCalled()
    expect(input.meterEngineRun).not.toHaveBeenCalled()
    expect(input.onDurableResult).not.toHaveBeenCalled()
  })

  it("does not replay evidence sealing or settlement after a duplicate delivery loses the claim", async () => {
    let claimAcquired = false
    mocks.withScanFinalizationClaim.mockImplementation(
      async (_scanId: string, _workspaceId: string, finalize: () => Promise<unknown>) => {
        if (claimAcquired) throw new Error("Scan finalization already started")
        claimAcquired = true
        return { status: "finalized", value: await finalize() }
      }
    )
    const input = params()

    await finalizeScanLifecycle(input as never)
    await expect(finalizeScanLifecycle(input as never)).rejects.toThrow(
      "Scan finalization already started"
    )

    expect(mocks.persistFindings).toHaveBeenCalledOnce()
    expect(mocks.persistResultManifest).toHaveBeenCalledOnce()
    expect(mocks.completeRetestsForScan).toHaveBeenCalledOnce()
    expect(mocks.completeScanWithScore).toHaveBeenCalledOnce()
    expect(input.meterEngineRun).toHaveBeenCalledOnce()
  })

  it("does not commit the meter when evidence sealing fails", async () => {
    const failure = new Error("manifest write failed")
    mocks.persistResultManifest.mockRejectedValueOnce(failure)
    let settlementCommitted = false
    const input = params({
      meterEngineRun: vi.fn(async (_outcome: unknown, finishEvidence?: () => Promise<void>) => {
        await finishEvidence?.()
        settlementCommitted = true
      }),
    })

    await expect(finalizeScanLifecycle(input as never)).rejects.toBe(failure)

    expect(settlementCommitted).toBe(false)
    expect(mocks.completeRetestsForScan).not.toHaveBeenCalled()
    expect(mocks.completeScanWithScore).not.toHaveBeenCalled()
    expect(input.onDurableResult).not.toHaveBeenCalled()
  })

  it("does not replay finalized evidence when the settlement commit fails after the durable result", async () => {
    const failure = new Error("settlement acknowledgement lost")
    const meterEngineRun = vi.fn(
      async (_outcome: unknown, finishEvidence?: () => Promise<void>) => {
        await finishEvidence?.()
        throw failure
      }
    )
    const input = params({ meterEngineRun })

    await expect(finalizeScanLifecycle(input as never)).rejects.toBe(failure)

    expect(mocks.withScanFinalizationClaim).toHaveBeenCalledWith(
      "scan-1",
      "workspace-1",
      expect.any(Function)
    )
    expect(mocks.persistFindings).toHaveBeenCalledOnce()
    expect(mocks.persistResultManifest).toHaveBeenCalledOnce()
    expect(mocks.completeRetestsForScan).toHaveBeenCalledOnce()
    expect(mocks.completeScanWithScore).toHaveBeenCalledOnce()
    expect(meterEngineRun).toHaveBeenCalledOnce()
    expect(input.onDurableResult).toHaveBeenCalledOnce()
  })
})

describe("finalizeEarlyEngineTerminal", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.completeRetestsForScan.mockResolvedValue(undefined)
    mocks.persistResultManifest.mockResolvedValue(undefined)
    mocks.updateScanStatus.mockResolvedValue(undefined)
    mocks.notifyScanFailed.mockRejectedValue(new Error("notification unavailable"))
  })

  it("records a bounded early budget stop before failing the scan and tolerates notification failure", async () => {
    const engineResult: EngineRunResult = {
      exitCode: 3,
      cancelled: false,
      timedOut: false,
      sourceCheckoutPath: "/tmp/scan-1",
      output: {
        vulnerabilities: [],
        runRecord: null,
        summary: "Budget reached",
        findingCount: 0,
        findingsComplete: true,
        ingestionIssues: [],
        scopedCoverage: null,
        threatModels: null,
        httpExchangeExport: null,
      },
    }
    const result = await finalizeEarlyEngineTerminal({
      scanId: "scan-1",
      workspaceId: "workspace-1",
      target: {
        id: "target-1",
        type: "REPO",
        name: "Production repository",
        repoFullName: "owner/repo",
        branch: "main",
        url: null,
        apiSpecUrl: null,
        environment: null,
        installationId: null,
        repoProvider: "github",
      },
      engineBacked: true,
      engineResult,
      workerExecution: null,
      maxBudgetUsd: 2,
      billedCostUsd: 2,
      costReconciled: true,
      terminalOutcome: {
        status: "STOPPED_BUDGET",
        errorCategory: "BUDGET_EXCEEDED",
        errorMessage: "Protected run limit reached",
      },
      actualCostCents: 200,
      notificationDescription: "budget-stop",
    })

    expect(result).toEqual({
      status: "failed",
      errorCategory: "BUDGET_EXCEEDED",
      errorMessage: "Protected run limit reached",
    })
    expect(mocks.persistResultManifest).toHaveBeenCalledWith(
      expect.objectContaining({
        engineFindingCount: 0,
        coverageIssues: [
          {
            scanner: "engine",
            status: "bounded",
            reason: "Protected run limit reached",
          },
        ],
        terminalOutcome: {
          status: "STOPPED_BUDGET",
          errorCategory: "BUDGET_EXCEEDED",
          errorMessage: "Protected run limit reached",
        },
      })
    )
    expect(mocks.completeRetestsForScan).toHaveBeenCalledWith({
      scanId: "scan-1",
      workspaceId: "workspace-1",
    })
    expect(mocks.updateScanStatus).toHaveBeenCalledWith(
      "scan-1",
      "STOPPED_BUDGET",
      expect.objectContaining({ actualCostCents: 200, errorCategory: "BUDGET_EXCEEDED" })
    )
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      "Failed to send budget-stop notification",
      expect.objectContaining({ scanId: "scan-1" })
    )
  })
})
