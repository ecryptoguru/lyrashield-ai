import { createHash, generateKeyPairSync } from "node:crypto"
import { requiredScannersForTarget } from "@lyrashield/gate"
import { RESULT_MANIFEST_VERSION } from "@lyrashield/types"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ withWorkspaceRLS: vi.fn() }))
vi.mock("./rls", () => ({ withWorkspaceRLS: mocks.withWorkspaceRLS }))
vi.mock("./report-service", () => ({ resolveReportDelegationTarget: vi.fn() }))
vi.mock("./gate-service", async () => {
  const { parseAssessmentSnapshot } = await import("./gate-assessment")
  return {
    parseAssessmentSnapshot,
    evaluateVerdictApplicability: async (
      _tx: unknown,
      _workspaceId: string,
      verdict: { state: string }
    ) => ({ applicable: true, effectiveState: verdict.state, reasons: [] }),
  }
})

import { issueReleasePacket } from "./release-packet-service"
import { releasePacketSigningKeyId } from "./release-packet-signing"
import { buildLaunchReportPayload, type LaunchReportSource } from "./launch-report-payload"
import { buildLaunchReportProvenance } from "./launch-report-provenance"
import { LAUNCH_REPORT_SIGNING_KEY_ID, signLaunchReportChecksum } from "./launch-report-signing"
import { launchReportIdentityCommitment } from "./launch-report-identity"

const now = new Date("2026-11-11T10:00:00Z")
const revision = "c".repeat(40)
const pair = generateKeyPairSync("ed25519")
const privateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString()
const publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString()
const input = {
  workspaceId: "workspace-1",
  targetId: "target-1",
  actorUserId: "user-1",
  expectedIdentity: { kind: "COMMIT" as const, value: revision },
  signingPrivateKey: privateKey,
  signingPublicKey: publicKey,
  verificationKeys: [{ id: releasePacketSigningKeyId(publicKey), publicKey, revoked: false }],
  now,
}

function evidenceScan(id: string, sourceRevision: string, endedAt: Date) {
  const coverageReceipts = requiredScannersForTarget("REPO", "STANDARD").map((scanner) => ({
    id: `${id}-${scanner}`,
    scanId: id,
    scanner,
    controlId: scanner,
    status: "COMPLETED",
    reason: null,
    subject: null,
    metadata: null,
  }))
  const manifest = {
    target: { id: input.targetId, type: "REPO", urlChecksum: null },
    sourceExecution: { sourceRevision },
    terminalOutcome: { status: "COMPLETED" },
    coverage: coverageReceipts.map(({ scanner, controlId, status }) => ({
      scanner,
      controlId,
      status,
    })),
  }
  const checksumInput = JSON.stringify(manifest)
  return {
    id,
    workspaceId: input.workspaceId,
    targetId: input.targetId,
    status: "COMPLETED",
    mode: "STANDARD",
    policyId: "policy-1",
    createdAt: endedAt,
    startedAt: endedAt,
    endedAt,
    resultManifest: {
      version: RESULT_MANIFEST_VERSION,
      checksum: createHash("sha256").update(checksumInput).digest("hex"),
      checksumInput,
      manifest,
    },
    coverageReceipts,
  }
}

function fixture() {
  const baseline = evidenceScan("baseline", "b".repeat(40), new Date(now.getTime() - 120_000))
  const current = evidenceScan("retest-scan", revision, new Date(now.getTime() - 60_000))
  const identity = (scan: typeof current) => ({
    scanId: scan.id,
    manifestChecksum: scan.resultManifest.checksum,
    sourceRevision: scan.resultManifest.manifest.sourceExecution.sourceRevision,
    targetUrlChecksum: null,
  })
  const receipt = {
    status: "VALIDATED",
    method: "RETEST",
    scanId: current.id,
    verifierVersion: "result-integrity-v3",
    evidence: {
      retestId: "retest-1",
      scannerSource: "sca",
      baseline: identity(baseline),
      retest: identity(current),
      coverageReceiptIds: ["baseline-sca", "retest-scan-sca"],
    },
  }
  const finding = {
    id: "finding-1",
    scanId: baseline.id,
    dedupeKey: "finding-key",
    title: "Dependency vulnerability",
    severity: "HIGH",
    status: "FIXED",
    verificationStatus: "VALIDATED",
    baseCommit: "b".repeat(40),
    firstSeenAt: baseline.endedAt,
    lastSeenAt: baseline.endedAt,
    disposition: null,
    dispositionActorUserId: null,
    dispositionReason: null,
    dispositionAssessmentId: null,
    dispositionAt: null,
    canonicalFindingId: null,
    verificationReceipts: [receipt],
    retests: [{ status: "passed" }],
    fixProposals: [],
  }
  const retest = {
    id: "retest-1",
    workspaceId: input.workspaceId,
    findingId: finding.id,
    scanId: current.id,
    status: "passed",
  }
  const legacy = { id: "legacy-ready", state: "READY", evaluatedAt: now }
  const rows: Record<string, unknown>[] = [legacy]
  let evaluationCount = 0
  const tx = {
    target: {
      findFirst: vi.fn().mockResolvedValue({ id: input.targetId, type: "REPO", name: "App" }),
    },
    policy: { findFirst: vi.fn().mockResolvedValue({ id: "policy-1", name: "Policy" }) },
    scan: {
      findFirst: vi.fn(async ({ where }) =>
        !where.id || where.id === current.id ? current : { id: baseline.id }
      ),
      findMany: vi.fn().mockResolvedValue([baseline, current]),
    },
    finding: { findMany: vi.fn().mockResolvedValue([finding]) },
    retest: { findMany: vi.fn().mockResolvedValue([retest]) },
    findingCandidate: {
      findMany: vi.fn(async ({ where }) =>
        typeof where.scanId === "object" || where.scanId === baseline.id
          ? [
              {
                targetId: input.targetId,
                findingId: finding.id,
                scanId: baseline.id,
                dedupeKey: finding.dedupeKey,
                scannerSource: "sca",
                payload: {},
              },
            ]
          : []
      ),
      count: vi.fn().mockResolvedValue(0),
    },
    scanCoverageReceipt: { findMany: vi.fn().mockResolvedValue(current.coverageReceipts) },
    gateVerdict: {
      create: vi.fn(async ({ data }) => {
        evaluationCount += 1
        const id = evaluationCount === 1 ? "fresh-verdict" : `fresh-verdict-${evaluationCount}`
        rows.push({ id, evaluatedAt: now, ...data })
        // Model a racing old-worker assessment sorting after the new one.
        rows.push({ ...legacy, id: "zz-racing-ready" })
        return { id }
      }),
      findFirst: vi.fn(async ({ where }) => rows.find((row) => row.id === where.id) ?? rows.at(-1)),
    },
    $queryRaw: vi.fn(async (sql: TemplateStringsArray) => {
      if (sql.join("?").includes('AS "candidateManifest"'))
        return [{ candidateManifest: current.resultManifest }]
      if (sql.join("?").includes('AS "requestedTargetId"'))
        return [
          {
            requestedTargetId: input.targetId,
            targetId: input.targetId,
            targetWorkspaceId: input.workspaceId,
            targetType: "REPO",
            scanId: current.id,
            scanWorkspaceId: input.workspaceId,
            scanTargetId: input.targetId,
            status: current.status,
            mode: current.mode,
            endedAt: current.endedAt,
            policyId: current.policyId,
            resultManifest: current.resultManifest,
            coverageReceipts: current.coverageReceipts,
            overflow: false,
          },
        ]
      return []
    }),
    report: {
      create: vi.fn().mockResolvedValue({ id: "packet-1" }),
      findMany: vi.fn().mockResolvedValue([]),
    },
  }
  mocks.withWorkspaceRLS.mockImplementation(async (_workspaceId, fn) => fn(tx))
  return { tx, finding, receipt, baseline, current, retest, legacy, rows }
}

describe("release packet current gate compatibility", () => {
  beforeEach(() => vi.clearAllMocks())

  it("refuses READY issuance when complete receipt rows contradict checksum-bound coverage", async () => {
    const { tx, current } = fixture()
    tx.finding.findMany.mockResolvedValue([])
    current.resultManifest.manifest.coverage.find((row) => row.scanner === "engine")!.status =
      "BLOCKED"
    current.resultManifest.checksumInput = JSON.stringify(current.resultManifest.manifest)
    current.resultManifest.checksum = createHash("sha256")
      .update(current.resultManifest.checksumInput)
      .digest("hex")
    await expect(issueReleasePacket(input)).rejects.toMatchObject({ code: "ASSESSMENT_INCOMPLETE" })
    expect(tx.report.create).not.toHaveBeenCalled()
  })

  it("binds the exact receipt-backed assessment despite a racing legacy READY verdict", async () => {
    const { tx, legacy, rows } = fixture()
    const packet = await issueReleasePacket(input)
    expect(packet.payload.assessment).toMatchObject({ verdictId: "fresh-verdict", state: "READY" })
    expect(packet.payload.remediation.counts.resolvedFindings).toBe(1)
    expect(tx.gateVerdict.findFirst).toHaveBeenLastCalledWith({
      where: { id: "fresh-verdict", workspaceId: input.workspaceId, targetId: input.targetId },
    })
    expect(mocks.withWorkspaceRLS).toHaveBeenCalledExactlyOnceWith(
      input.workspaceId,
      expect.any(Function),
      { isolationLevel: "RepeatableRead" }
    )
    expect(rows[0]).toBe(legacy)
    expect(legacy).toEqual({ id: "legacy-ready", state: "READY", evaluatedAt: now })
    expect(tx.scan.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "retest-scan",
          workspaceId: input.workspaceId,
          targetId: input.targetId,
          status: "COMPLETED",
          deletedAt: null,
        },
      })
    )
  })

  it.each(["valid", "wrong-lineage", "bad-signature", "legacy"])(
    "reuses equivalent current evidence while retaining only a %s signed report",
    async (kind) => {
      const { tx, rows } = fixture()
      await issueReleasePacket(input)
      const assessed = rows[1] as unknown as LaunchReportSource & {
        id: string
        assessmentVersion: number
      }
      rows.splice(2)
      const identityBindingKey = "d".repeat(64)
      const identityCommitment = launchReportIdentityCommitment(identityBindingKey, {
        workspaceId: input.workspaceId,
        targetId: input.targetId,
        verdictId: assessed.id,
        verdictChecksum: assessed.verdictChecksum,
        assessmentVersion: assessed.assessmentVersion,
        identity: input.expectedIdentity,
      })
      const payload = buildLaunchReportPayload(assessed, {
        issuedAt: now,
        ...(kind === "legacy" ? {} : { identityCommitment }),
      })
      const report = {
        id: "signed-report-1",
        contentJson: {
          ...payload,
          signingKeyId: LAUNCH_REPORT_SIGNING_KEY_ID,
          signature:
            kind === "bad-signature"
              ? "invalid"
              : signLaunchReportChecksum(payload.reportChecksum, privateKey),
        },
        provenanceJson: {
          ...buildLaunchReportProvenance({
            verdictId: assessed.id,
            verdictChecksum: kind === "wrong-lineage" ? "f".repeat(64) : assessed.verdictChecksum,
            assessmentVersion: assessed.assessmentVersion,
            assessedIdentity: input.expectedIdentity,
            assessedAt: assessed.evaluatedAt,
            issuedAt: now,
            applicabilityCheckedAt: now,
            applicability: "applicable",
            reasonCodes: [],
            historicalState: assessed.state,
            effectiveState: assessed.state,
          }),
          ...(kind === "legacy" ? {} : { identityBindingKey }),
        },
      }
      tx.report.findMany.mockResolvedValue([report])
      tx.gateVerdict.create.mockClear()
      const packet = await issueReleasePacket(input)
      expect(tx.gateVerdict.create).not.toHaveBeenCalled()
      expect(packet.payload.assessment.verdictId).toBe(assessed.id)
      expect(packet.payload.signedAssessment.state).toBe(
        kind === "valid"
          ? "SIGNED"
          : kind === "bad-signature"
            ? "INVALID"
            : kind === "legacy"
              ? "HISTORICAL"
              : "UNAVAILABLE"
      )
      if (kind === "valid") expect(packet.payload.signedAssessment.reportId).toBe(report.id)
    }
  )

  it.each(["legacy", "missing", "foreign", "incomplete", "tampered"])(
    "does not carry historical READY into issuance with %s retest evidence",
    async (kind) => {
      const { tx, receipt, retest, baseline } = fixture()
      if (kind === "legacy") receipt.verifierVersion = "result-integrity-1"
      if (kind === "missing") tx.retest.findMany.mockResolvedValue([])
      if (kind === "foreign") retest.workspaceId = "foreign-workspace"
      if (kind === "incomplete")
        baseline.coverageReceipts.find((row) => row.scanner === "sca")!.status = "INCOMPLETE"
      if (kind === "tampered")
        baseline.resultManifest.manifest.sourceExecution.sourceRevision = "d".repeat(40)
      const packet = await issueReleasePacket(input)
      expect(packet.payload.assessment.state).not.toBe("READY")
      expect(packet.payload.assessment.historicalState).not.toBe("READY")
      expect(packet.payload.remediation.counts).toMatchObject({
        resolvedFindings: 0,
        uncertainMatches: 1,
      })
    }
  )

  it.each([
    "scanner",
    "control",
    "reason",
    "subject",
    "metadata",
    "missing",
    "extra",
    "duplicate",
    "absent",
  ])("rejects %s coverage discordance during current evaluation", async (kind) => {
    const { tx, current } = fixture()
    tx.finding.findMany.mockResolvedValue([])
    const manifest = current.resultManifest.manifest as {
      coverage?: Array<Record<string, unknown>>
    }
    const row = manifest.coverage![0]!
    if (kind === "scanner") row.scanner = "foreign-scanner"
    if (kind === "control") row.controlId = "foreign-control"
    if (kind === "reason") row.reason = "Blocked input"
    if (kind === "subject") row.subject = "other-input"
    if (kind === "metadata") row.metadata = { evidence: "different" }
    if (kind === "missing") manifest.coverage!.pop()
    if (kind === "extra") manifest.coverage!.push({ ...row, controlId: "extra-control" })
    if (kind === "duplicate") manifest.coverage!.push({ ...row })
    if (kind === "absent") delete manifest.coverage
    current.resultManifest.checksumInput = JSON.stringify(current.resultManifest.manifest)
    current.resultManifest.checksum = createHash("sha256")
      .update(current.resultManifest.checksumInput)
      .digest("hex")
    await expect(issueReleasePacket(input)).rejects.toMatchObject({
      code: "ASSESSMENT_INCOMPLETE",
    })
    expect(tx.gateVerdict.create.mock.calls[0]![0].data.state).toBe("INSUFFICIENT_EVIDENCE")
    expect(tx.report.create).not.toHaveBeenCalled()
  })

  it("accepts matching coverage regardless of row order or omitted nullable fields", async () => {
    const { tx, current } = fixture()
    tx.finding.findMany.mockResolvedValue([])
    const row = current.coverageReceipts[0] as { metadata: unknown }
    const entry = current.resultManifest.manifest.coverage[0] as Record<string, unknown>
    row.metadata = { alpha: 1, beta: ["complete"] }
    entry.metadata = { beta: ["complete"], alpha: 1 }
    current.resultManifest.manifest.coverage.reverse()
    current.resultManifest.checksumInput = JSON.stringify(current.resultManifest.manifest)
    current.resultManifest.checksum = createHash("sha256")
      .update(current.resultManifest.checksumInput)
      .digest("hex")
    const packet = await issueReleasePacket(input)
    expect(packet.payload.assessment.state).toBe("READY")
  })

  it("keeps a stored READY historical when its retest claim no longer satisfies current trust", async () => {
    const { rows, receipt } = fixture()
    await issueReleasePacket(input)
    const historical = structuredClone(rows[1])
    rows.splice(2)
    receipt.verifierVersion = "result-integrity-1"
    const packet = await issueReleasePacket(input)
    expect(packet.payload.assessment.verdictId).toBe("fresh-verdict-2")
    expect(packet.payload.assessment.state).not.toBe("READY")
    expect(packet.payload.remediation.counts.resolvedFindings).toBe(0)
    expect(rows[1]).toEqual(historical)
    expect(historical?.state).toBe("READY")
  })

  it.each(["state", "coverageStatement", "inputChecksum"])(
    "does not reuse a stored verdict with changed %s despite retained claimed checksums",
    async (field) => {
      const { rows } = fixture()
      await issueReleasePacket(input)
      rows.splice(2)
      rows[1]![field] =
        field === "state" ? "NOT_READY" : field === "inputChecksum" ? "0".repeat(64) : ["tampered"]
      const packet = await issueReleasePacket(input)
      expect(packet.payload.assessment.verdictId).toBe("fresh-verdict-2")
      expect(packet.payload.assessment.state).toBe("READY")
    }
  )

  it("requires a supported assessment identity when the completed manifest is absent", async () => {
    const { tx, current } = fixture()
    current.resultManifest = null as never
    await expect(issueReleasePacket(input)).rejects.toMatchObject({ code: "ASSESSMENT_INCOMPLETE" })
    expect(tx.report.create).not.toHaveBeenCalled()
  })

  it.each(["missing-checksum-input", "foreign-target", "tampered-current", "partial-current"])(
    "refuses issuance from %s assessed manifest evidence",
    async (kind) => {
      const { tx, current } = fixture()
      if (kind === "missing-checksum-input") current.resultManifest.checksumInput = ""
      if (kind === "foreign-target") {
        current.resultManifest.manifest.target.id = "foreign-target"
        current.resultManifest.checksumInput = JSON.stringify(current.resultManifest.manifest)
        current.resultManifest.checksum = createHash("sha256")
          .update(current.resultManifest.checksumInput)
          .digest("hex")
      }
      if (kind === "tampered-current")
        current.resultManifest.manifest.terminalOutcome.status = "PARTIAL"
      if (kind === "partial-current") {
        current.resultManifest.manifest.terminalOutcome.status = "PARTIAL"
        current.resultManifest.checksumInput = JSON.stringify(current.resultManifest.manifest)
        current.resultManifest.checksum = createHash("sha256")
          .update(current.resultManifest.checksumInput)
          .digest("hex")
      }
      await expect(issueReleasePacket(input)).rejects.toMatchObject({
        code: "ASSESSMENT_INCOMPLETE",
      })
      expect(tx.report.create).not.toHaveBeenCalled()
    }
  )

  it("fails closed instead of falling back to latest when the exact new verdict is unavailable", async () => {
    const { tx } = fixture()
    tx.gateVerdict.findFirst.mockResolvedValue(null)
    await expect(issueReleasePacket(input)).rejects.toMatchObject({ code: "NOT_EVALUATED" })
    expect(tx.report.create).not.toHaveBeenCalled()
  })
})
