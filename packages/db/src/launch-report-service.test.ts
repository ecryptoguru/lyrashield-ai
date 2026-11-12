import { createHash, generateKeyPairSync } from "node:crypto"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { buildLaunchReportPayload, computeLaunchReportChecksum } from "./launch-report-payload"
import { isLaunchReportShareablePayload } from "./launch-report-html"
import { signLaunchReportChecksum, verifyLaunchReportSignature } from "./launch-report-signing"
import { launchReportIdentityCommitment } from "./launch-report-identity"

const signingKeys = generateKeyPairSync("ed25519")
const privateKey = signingKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString()
const publicKey = signingKeys.publicKey.export({ type: "spki", format: "pem" }).toString()

const policy = {
  id: "policy-1",
  workspaceId: "workspace-1",
  name: "Default",
  description: null,
  scanWindow: null,
  blockedPaths: [],
  allowedDomains: [],
  rateLimit: null,
  networkEgressPolicy: "target_only",
  destructiveTestsAllowed: false,
  approvalRequired: false,
  maxBudgetUsd: null,
  maxDurationMinutes: 60,
  piiRedactionEnabled: true,
  evidenceRetentionDays: 30,
}
const policyFingerprint = createHash("sha256")
  .update(
    JSON.stringify(
      Object.fromEntries(Object.entries(policy).sort(([a], [b]) => a.localeCompare(b)))
    )
  )
  .digest("hex")

const mocks = vi.hoisted(() => ({
  gateVerdictFindFirst: vi.fn(),
  policyFindFirst: vi.fn(),
  scanFindFirst: vi.fn(),
  findingFindFirst: vi.fn(),
  findingFindMany: vi.fn(),
  findingVerificationFindFirst: vi.fn(),
  reportCreate: vi.fn(),
  reportFindFirst: vi.fn(),
  getReportByShareToken: vi.fn(),
  rlsOptions: [] as unknown[],
}))

vi.mock("./client", () => ({
  prisma: {
    $queryRaw: mocks.findingFindMany,
    gateVerdict: { findFirst: mocks.gateVerdictFindFirst },
    policy: { findFirst: mocks.policyFindFirst },
    scan: { findFirst: mocks.scanFindFirst },
    finding: { findFirst: mocks.findingFindFirst, findMany: mocks.findingFindMany },
    findingVerification: { findFirst: mocks.findingVerificationFindFirst },
    report: { create: mocks.reportCreate, findFirst: mocks.reportFindFirst },
  },
}))
vi.mock("./rls", () => ({
  withWorkspaceRLS: vi.fn(
    async (_workspaceId: string, fn: (tx: unknown) => Promise<unknown>, options?: unknown) => {
      mocks.rlsOptions.push(options)
      const { prisma } = await import("./client")
      return fn(prisma)
    }
  ),
}))
vi.mock("./gate-assessed-scan-evidence", () => ({
  loadVerifiedAssessedScans: async (
    _tx: unknown,
    _workspaceId: string,
    rows: { targetId: string }[]
  ) => ({
    unverified: new Set<string>(),
    verified: new Map(rows.map((row) => [row.targetId, {}])),
  }),
}))
vi.mock("./gate-verdict-read", () => ({
  loadBoundedGateVerdicts: async () => {
    const row = await mocks.gateVerdictFindFirst()
    return row ? [row] : []
  },
}))
vi.mock("./gate-reader-evidence", async (original) => {
  const actual = await original<typeof import("./gate-reader-evidence")>()
  return {
    ...actual,
    findMismatchedGateEvidence: async (
      _tx: unknown,
      _workspaceId: string,
      rows: { targetId: string }[]
    ) => {
      const findings = await mocks.findingFindMany()
      return findings?.length ? new Set(rows.map((row) => row.targetId)) : new Set<string>()
    },
  }
})
vi.mock("./report-service", () => ({
  getReportByShareToken: mocks.getReportByShareToken,
  readActiveSharedReport: (..._args: unknown[]) => mocks.reportFindFirst(),
  sharedReportSnapshotBinding: (report: Record<string, unknown>) =>
    JSON.stringify([report.type, report.scanId, report.contentJson, report.provenanceJson]),
  sharedReportStillActive: async (
    _workspaceId: string,
    _id: string,
    _token: string,
    binding: string
  ) => {
    const report = await mocks.reportFindFirst()
    return (
      report !== null &&
      JSON.stringify([report.type, report.scanId, report.contentJson, report.provenanceJson]) ===
        binding
    )
  },
}))
vi.mock("@lyrashield/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))
vi.mock("@lyrashield/config", () => ({
  env: { LAUNCH_REPORT_SIGNING_PRIVATE_KEY: undefined },
}))

import {
  confirmSharedLaunchReportIdentity,
  generateLaunchReport,
  getLaunchReportDetail,
  getSharedLaunchReport,
} from "./launch-report-service"

const EVALUATED_AT = new Date("2026-09-10T00:00:00.000Z")
const COMPLETED_AT_MS = EVALUATED_AT.getTime() - 60_000
const COMMIT = "b".repeat(40)
const DAY_MS = 24 * 60 * 60 * 1000

function validLaunchPayload(overrides: Record<string, unknown> = {}) {
  const base = buildLaunchReportPayload(
    {
      standardVersion: "lyrashield-gate/1.0.0",
      state: "READY",
      coverageStatement: ["engine"],
      nonCoverage: [],
      blockingReasons: [],
      evidenceSummary: {
        verified: 1,
        retestConfirmed: 1,
        unresolvedCritical: 0,
        unresolvedHigh: 0,
        unresolvedMedium: 0,
        unresolvedLow: 0,
      },
      staleness: { current: true },
      verdictChecksum: "vc-1",
      evaluatedAt: EVALUATED_AT,
    },
    { issuedAt: new Date(EVALUATED_AT.getTime() + 60_000) }
  )
  const candidate = { ...base, ...overrides }
  const {
    reportChecksum: _checksum,
    signature: _signature,
    signingKeyId: _keyId,
    ...unsigned
  } = candidate
  void _checksum
  void _signature
  void _keyId
  return { ...candidate, reportChecksum: computeLaunchReportChecksum(unsigned) }
}

function assessmentSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    version: 2,
    scanId: "scan-1",
    completedAtMs: COMPLETED_AT_MS,
    manifestChecksum: "a".repeat(64),
    manifestVersion: 7,
    policyId: "policy-1",
    policyFingerprint,
    identity: { kind: "COMMIT", value: COMMIT },
    ...overrides,
  }
}

function verdictRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "verdict-1",
    workspaceId: "workspace-1",
    targetId: "target-1",
    scanId: "scan-1",
    standardVersion: "lyrashield-gate/1.0.0",
    state: "READY",
    coverageStatement: ["engine", "sca"],
    nonCoverage: [],
    blockingReasons: [],
    evidenceSummary: {
      detected: 0,
      validated: 0,
      verified: 0,
      retestConfirmed: 0,
      inconclusive: 0,
      insufficientPositiveEvidence: 0,
      blockingUnverified: 0,
      unresolvedCritical: 0,
      unresolvedHigh: 0,
      unresolvedMedium: 0,
      unresolvedLow: 0,
      acceptedRisk: 0,
      falsePositive: 0,
    },
    staleness: { current: true },
    inputChecksum: "in-1",
    verdictChecksum: "vc-1",
    assessmentVersion: 2,
    assessmentSnapshot: assessmentSnapshot(),
    evaluatedAt: EVALUATED_AT,
    ...overrides,
  }
}

async function issue(now = new Date(EVALUATED_AT.getTime() + 60_000)) {
  mocks.reportCreate.mockResolvedValue({ id: "report-1" })
  const result = await generateLaunchReport("workspace-1", "target-1", "user-1", { now })
  const createArgs = mocks.reportCreate.mock.calls[0]?.[0] as {
    data: { contentJson: Record<string, unknown>; provenanceJson: Record<string, unknown> }
  }
  return {
    result,
    payload: createArgs?.data.contentJson,
    provenance: createArgs?.data.provenanceJson,
  }
}

describe("generateLaunchReport — issue-time applicability and private binding", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.rlsOptions.length = 0
    mocks.gateVerdictFindFirst.mockResolvedValue(verdictRow())
    mocks.policyFindFirst.mockResolvedValue(policy)
    mocks.scanFindFirst.mockResolvedValue(null)
    mocks.findingFindFirst.mockResolvedValue(null)
    mocks.findingFindMany.mockResolvedValue([])
    mocks.findingVerificationFindFirst.mockResolvedValue(null)
  })

  it("refuses to issue a report from a legacy untrusted retest verdict", async () => {
    mocks.findingFindMany.mockResolvedValue([
      {
        id: "finding-1",
        targetId: "target-1",
        scanId: "baseline",
        dedupeKey: "f",
        severity: "HIGH",
        status: "FIXED",
        verificationStatus: "DETECTED",
        lastSeenAt: EVALUATED_AT,
        disposition: null,
        dispositionActorUserId: null,
        dispositionReason: null,
        dispositionAssessmentId: null,
        dispositionAt: null,
        canonicalFindingId: null,
        verificationReceipts: [
          {
            status: "VALIDATED",
            method: "RETEST",
            scanId: "scan-1",
            verifierVersion: "result-integrity-v2",
            evidence: {},
          },
        ],
      },
    ])
    await expect(issue()).rejects.toMatchObject({ code: "UNTRUSTED_GATE_EVIDENCE" })
    expect(mocks.reportCreate).not.toHaveBeenCalled()
  })

  it("refuses to issue when the selected verdict exceeds the transport bound", async () => {
    mocks.gateVerdictFindFirst.mockResolvedValue(verdictRow({ evidenceTooLarge: true }))
    mocks.reportCreate.mockResolvedValue({ id: "report-1" })
    await expect(
      generateLaunchReport("workspace-1", "target-1", "user-1", { now: EVALUATED_AT })
    ).rejects.toMatchObject({ code: "UNTRUSTED_GATE_EVIDENCE" })
    expect(mocks.reportCreate).not.toHaveBeenCalled()
  })

  it("returns null and writes nothing when the target has no verdict", async () => {
    mocks.gateVerdictFindFirst.mockResolvedValue(null)
    const result = await generateLaunchReport("workspace-1", "target-1", "user-1")
    expect(result).toBeNull()
    expect(mocks.reportCreate).not.toHaveBeenCalled()
  })

  it("evaluates applicability at issue inside one RepeatableRead snapshot", async () => {
    const { result, payload, provenance } = await issue()

    expect(result?.reportId).toBe("report-1")
    expect(mocks.rlsOptions[0]).toEqual({ isolationLevel: "RepeatableRead" })
    expect(payload?.stale).toBe(false)
    expect(provenance).toMatchObject({
      schemaVersion: "lyrashield-report-provenance/1.0.0",
      gateVerdictId: "verdict-1",
      verdictChecksum: "vc-1",
      assessmentVersion: 2,
      assessedIdentity: { kind: "COMMIT", value: COMMIT },
      assessedAt: EVALUATED_AT.toISOString(),
      applicability: "applicable",
      reasonCodes: [],
      historicalState: "READY",
      effectiveState: "READY",
    })
    // Only the opaque commitment joins the public allowlist; the key remains private.
    expect(Object.keys(payload!).sort()).toEqual([
      "appDisplayName",
      "assessmentDate",
      "counts",
      "coverageStatement",
      "dispositionCounts",
      "evaluatedAt",
      "expiresAt",
      "identityCommitment",
      "issuedAt",
      "nonCoverage",
      "notEvaluatedSeverities",
      "payloadVersion",
      "reportChecksum",
      "scopeCommitment",
      "stale",
      "standardVersion",
      "verdictLabel",
    ])
    expect(JSON.stringify(payload)).not.toContain("provenance")
  })

  it("marks the report stale when a newer assessment attempt exists", async () => {
    mocks.scanFindFirst.mockResolvedValue({ id: "scan-2" })
    const { payload, provenance } = await issue()
    expect(payload?.stale).toBe(true)
    expect(provenance?.applicability).toBe("not_applicable")
    expect(provenance?.reasonCodes).toContain("NEWER_ASSESSMENT_ATTEMPT")
  })

  it("marks the report stale when findings changed after evaluation", async () => {
    mocks.findingFindFirst.mockResolvedValue({ id: "finding-1" })
    const { payload, provenance } = await issue()
    expect(payload?.stale).toBe(true)
    expect(provenance?.reasonCodes).toContain("EVIDENCE_CHANGED")
  })

  it("marks the report stale when verification evidence changed", async () => {
    mocks.findingVerificationFindFirst.mockResolvedValue({ id: "fv-1" })
    const { payload, provenance } = await issue()
    expect(payload?.stale).toBe(true)
    expect(provenance?.reasonCodes).toContain("EVIDENCE_CHANGED")
  })

  it("marks the report stale when the bound policy changed", async () => {
    mocks.policyFindFirst.mockResolvedValue({ ...policy, name: "Renamed" })
    const { payload, provenance } = await issue()
    expect(payload?.stale).toBe(true)
    expect(provenance?.reasonCodes).toContain("POLICY_CHANGED")
  })

  it("marks the report stale when the bound policy was deleted", async () => {
    mocks.policyFindFirst.mockResolvedValue(null)
    const { payload, provenance } = await issue()
    expect(payload?.stale).toBe(true)
    expect(provenance?.reasonCodes).toContain("POLICY_CHANGED")
  })

  it("applies the authoritative 24h boundary: fresh before, expired at and after", async () => {
    const boundary = COMPLETED_AT_MS + DAY_MS
    const before = await issue(new Date(boundary - 1))
    expect(before.payload?.stale).toBe(false)

    vi.clearAllMocks()
    mocks.reportCreate.mockResolvedValue({ id: "report-2" })
    const at = await issue(new Date(boundary))
    expect(at.payload?.stale).toBe(true)
    expect(at.provenance?.reasonCodes).toContain("ASSESSMENT_EXPIRED")

    vi.clearAllMocks()
    mocks.reportCreate.mockResolvedValue({ id: "report-3" })
    const after = await issue(new Date(boundary + 60_000))
    expect(after.payload?.stale).toBe(true)
    expect(after.provenance?.reasonCodes).toContain("ASSESSMENT_EXPIRED")
  })

  it("fails closed on a legacy verdict with no assessment snapshot", async () => {
    mocks.gateVerdictFindFirst.mockResolvedValue(
      verdictRow({ assessmentSnapshot: null, assessmentVersion: null })
    )
    const { payload, provenance } = await issue()
    expect(payload?.stale).toBe(true)
    expect(provenance?.applicability).toBe("not_applicable")
    expect(provenance?.reasonCodes).toContain("ASSESSMENT_UNAVAILABLE")
    expect(provenance?.assessedIdentity).toBeNull()
    // The historical verdict still renders; the report just cannot read as current.
    expect(payload?.verdictLabel).toBe("Ready to launch")
  })

  it("still issues — explicitly non-current — when the evaluation read fails mid-transaction", async () => {
    mocks.policyFindFirst.mockRejectedValue(new Error("pg: connection terminated mid-tx"))
    const { result, payload, provenance } = await issue()
    expect(result?.reportId).toBe("report-1")
    expect(payload?.stale).toBe(true)
    expect(provenance?.applicability).toBe("unknown")
    expect(provenance?.reasonCodes).toEqual(["APPLICABILITY_EVALUATION_FAILED"])
    // The binding to the originally selected verdict is preserved…
    expect(provenance?.gateVerdictId).toBe("verdict-1")
    expect(provenance?.verdictChecksum).toBe("vc-1")
    // …and no raw exception text leaks into the stored record.
    expect(JSON.stringify(provenance)).not.toContain("pg:")
    expect(provenance?.effectiveState).toBeNull()
  })

  it("fails issuance when the verdict selection itself fails", async () => {
    mocks.gateVerdictFindFirst.mockRejectedValue(new Error("db down"))
    await expect(generateLaunchReport("workspace-1", "target-1", "user-1")).rejects.toThrow(
      "db down"
    )
    expect(mocks.reportCreate).not.toHaveBeenCalled()
  })

  it("preserves the artifact digest identity verbatim", async () => {
    const digest = `sha256:${"c".repeat(64)}`
    mocks.gateVerdictFindFirst.mockResolvedValue(
      verdictRow({
        assessmentSnapshot: assessmentSnapshot({
          identity: { kind: "ARTIFACT_DIGEST", value: digest },
        }),
      })
    )
    const { provenance } = await issue()
    expect(provenance?.assessedIdentity).toEqual({ kind: "ARTIFACT_DIGEST", value: digest })
  })

  it("keeps the report bound to the selected verdict, not the latest", async () => {
    // The ordering contract: latest-first selection is mocked by whatever the
    // findFirst returns; the binding must mirror exactly that row.
    const older = verdictRow({ id: "verdict-old", verdictChecksum: "vc-old" })
    mocks.gateVerdictFindFirst.mockResolvedValue(older)
    const { provenance } = await issue()
    expect(provenance?.gateVerdictId).toBe("verdict-old")
    expect(provenance?.verdictChecksum).toBe("vc-old")
  })
})

describe("getLaunchReportDetail — authenticated private reader", () => {
  beforeEach(() => vi.clearAllMocks())

  it("returns parsed provenance plus the public verdict label", async () => {
    const { payload, provenance } = await issue()
    mocks.reportFindFirst.mockResolvedValue({
      type: "launch_readiness",
      contentJson: payload,
      provenanceJson: provenance,
    })
    const detail = await getLaunchReportDetail("report-1", "workspace-1")
    expect(detail?.verdictLabel).toBe("Ready to launch")
    expect(detail?.provenance?.assessedIdentity).toEqual({ kind: "COMMIT", value: COMMIT })
  })

  it("returns null provenance for a legacy report so callers can state it explicitly", async () => {
    const payload = validLaunchPayload({ verdictLabel: "Not ready", stale: true })
    mocks.reportFindFirst.mockResolvedValue({
      type: "launch_readiness",
      contentJson: payload,
      provenanceJson: null,
    })
    const detail = await getLaunchReportDetail("report-1", "workspace-1")
    expect(detail?.provenance).toBeNull()
    expect(detail?.verdictLabel).toBe("Not ready")
    expect(detail?.stale).toBe(true)
  })

  it("returns null for non-launch reports and missing rows", async () => {
    mocks.reportFindFirst.mockResolvedValue({
      type: "developer",
      contentJson: {},
      provenanceJson: null,
    })
    await expect(getLaunchReportDetail("report-1", "workspace-1")).resolves.toBeNull()
    mocks.reportFindFirst.mockResolvedValue(null)
    await expect(getLaunchReportDetail("report-1", "workspace-1")).resolves.toBeNull()
  })

  it("fails closed when the stored launch payload is malformed or checksum-mismatched", async () => {
    mocks.reportFindFirst.mockResolvedValue({
      type: "launch_readiness",
      contentJson: { verdictLabel: "Ready to launch", reportChecksum: "bad" },
      provenanceJson: { assessedIdentity: { kind: "COMMIT", value: COMMIT } },
    })
    await expect(getLaunchReportDetail("report-1", "workspace-1")).resolves.toEqual({
      verdictLabel: null,
      stale: true,
      currentApplicability: "UNKNOWN",
      provenance: null,
    })
  })
})

describe("getSharedLaunchReport — public frozen payload", () => {
  const provenance = {
    schemaVersion: "lyrashield-report-provenance/1.0.0",
    gateVerdictId: "verdict-1",
    verdictChecksum: "vc-1",
    assessmentVersion: 2,
    assessedIdentity: { kind: "COMMIT", value: COMMIT },
    assessedAt: EVALUATED_AT.toISOString(),
    issuedAt: EVALUATED_AT.toISOString(),
    applicabilityCheckedAt: EVALUATED_AT.toISOString(),
    applicability: "applicable",
    reasonCodes: [],
    historicalState: "READY",
    effectiveState: "READY",
  }
  beforeEach(() => vi.clearAllMocks())

  it("marks an expired payload stale at read time without rewriting stored bytes", async () => {
    mocks.getReportByShareToken.mockResolvedValue({ id: "report-1", workspaceId: "workspace-1" })
    const storedPayload = validLaunchPayload({
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    })
    storedPayload.signature = signLaunchReportChecksum(storedPayload.reportChecksum, privateKey)
    mocks.reportFindFirst.mockResolvedValue({
      type: "launch_readiness",
      contentJson: storedPayload,
    })
    const payload = await getSharedLaunchReport("report-1", "a".repeat(64))
    expect(payload?.stale).toBe(true)
    expect(payload?.payload).toEqual(storedPayload)
    expect(isLaunchReportShareablePayload(payload?.payload)).toBe(true)
    expect(
      verifyLaunchReportSignature(
        payload!.payload.reportChecksum,
        payload!.payload.signature!,
        publicKey
      )
    ).toBe(true)
    expect(storedPayload.stale).toBe(false)
    // Stored row untouched — the flag lives only on the returned copy.
    expect(mocks.reportCreate).not.toHaveBeenCalled()
  })

  it("shows a signed report as historical when its bound retest evidence is untrusted", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(EVALUATED_AT.getTime() + 60_000))
    try {
      mocks.gateVerdictFindFirst.mockResolvedValue(verdictRow())
      mocks.policyFindFirst.mockResolvedValue(policy)
      mocks.scanFindFirst.mockResolvedValue(null)
      mocks.findingFindFirst.mockResolvedValue(null)
      mocks.findingVerificationFindFirst.mockResolvedValue(null)
      mocks.findingFindMany.mockResolvedValue([])
      mocks.reportCreate.mockResolvedValue({ id: "report-1" })
      const issued = await generateLaunchReport("workspace-1", "target-1", "user-1", {
        now: new Date(),
        signingPrivateKey: privateKey,
      })
      const provenance = mocks.reportCreate.mock.calls[0]![0].data.provenanceJson
      const storedPayload = issued!.payload
      mocks.getReportByShareToken.mockResolvedValue({ id: "report-1", workspaceId: "workspace-1" })
      mocks.reportFindFirst.mockResolvedValue({
        type: "launch_readiness",
        contentJson: storedPayload,
        provenanceJson: provenance,
      })
      mocks.findingFindMany.mockResolvedValue([
        {
          id: "finding-1",
          targetId: "target-1",
          scanId: "baseline",
          dedupeKey: "f",
          severity: "HIGH",
          status: "FIXED",
          verificationStatus: "DETECTED",
          lastSeenAt: EVALUATED_AT,
          disposition: null,
          dispositionActorUserId: null,
          dispositionReason: null,
          dispositionAssessmentId: null,
          dispositionAt: null,
          canonicalFindingId: null,
          verificationReceipts: [
            {
              status: "VALIDATED",
              method: "RETEST",
              scanId: "scan-1",
              verifierVersion: "result-integrity-v2",
              evidence: {},
            },
          ],
        },
      ])
      const result = await getSharedLaunchReport("report-1", "a".repeat(64))
      expect(result?.stale).toBe(true)
      expect(result?.payload).toEqual(storedPayload)
      expect(storedPayload.stale).toBe(false)
      expect(isLaunchReportShareablePayload(result?.payload)).toBe(true)
      expect(
        verifyLaunchReportSignature(
          result!.payload.reportChecksum,
          result!.payload.signature!,
          publicKey
        )
      ).toBe(true)
      expect(mocks.reportCreate).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("keeps a bound report current and marks it historical after a new assessment", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(EVALUATED_AT.getTime() + 60_000))
    try {
      mocks.gateVerdictFindFirst.mockResolvedValue(verdictRow())
      mocks.policyFindFirst.mockResolvedValue(policy)
      mocks.scanFindFirst.mockResolvedValue(null)
      mocks.findingFindFirst.mockResolvedValue(null)
      mocks.findingVerificationFindFirst.mockResolvedValue(null)
      mocks.findingFindMany.mockResolvedValue([])
      const issued = await issue(new Date())
      mocks.getReportByShareToken.mockResolvedValue({ id: "report-1", workspaceId: "workspace-1" })
      mocks.reportFindFirst.mockResolvedValue({
        type: "launch_readiness",
        contentJson: issued.payload,
        provenanceJson: issued.provenance,
      })
      const result = await getSharedLaunchReport("report-1", "a".repeat(64))
      expect(result?.stale).toBe(false)
      expect(isLaunchReportShareablePayload(result?.payload)).toBe(true)
      mocks.scanFindFirst.mockResolvedValue({ id: "newer-scan" })
      const stale = await getSharedLaunchReport("report-1", "a".repeat(64))
      expect(stale?.stale).toBe(true)
      expect(stale?.payload).toEqual(result?.payload)
      expect(isLaunchReportShareablePayload(stale?.payload)).toBe(true)
      mocks.scanFindFirst.mockResolvedValue(null)
      mocks.policyFindFirst.mockResolvedValue({ ...policy, name: "Changed policy" })
      expect((await getSharedLaunchReport("report-1", "a".repeat(64)))?.stale).toBe(true)
      mocks.policyFindFirst.mockResolvedValue(policy)
      const tampered = structuredClone(result!.payload)
      tampered.counts.unresolvedHigh = 99
      const {
        reportChecksum: _old,
        signature: _signature,
        signingKeyId: _keyId,
        ...unsigned
      } = tampered
      void _old
      void _signature
      void _keyId
      tampered.reportChecksum = computeLaunchReportChecksum(unsigned)
      expect(isLaunchReportShareablePayload(tampered)).toBe(true)
      mocks.reportFindFirst.mockResolvedValue({
        type: "launch_readiness",
        contentJson: tampered,
        provenanceJson: issued.provenance,
      })
      expect((await getSharedLaunchReport("report-1", "a".repeat(64)))?.stale).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("treats a checksum-valid payload that does not match its bound verdict as historical", async () => {
    const storedPayload = validLaunchPayload({
      expiresAt: new Date(Date.now() + DAY_MS).toISOString(),
      verdictLabel: "Ready to launch",
    })
    mocks.getReportByShareToken.mockResolvedValue({ id: "report-1", workspaceId: "workspace-1" })
    mocks.reportFindFirst.mockResolvedValue({
      type: "launch_readiness",
      contentJson: storedPayload,
      provenanceJson: provenance,
    })
    mocks.gateVerdictFindFirst.mockResolvedValue(verdictRow({ state: "NOT_READY" }))
    expect((await getSharedLaunchReport("report-1", "a".repeat(64)))?.stale).toBe(true)
  })

  it("denies a share revoked after token lookup", async () => {
    mocks.getReportByShareToken.mockResolvedValue({ id: "report-1", workspaceId: "workspace-1" })
    mocks.reportFindFirst.mockResolvedValue(null)
    expect(await getSharedLaunchReport("report-1", "a".repeat(64))).toBeNull()
  })

  it("denies a share revoked after qualification and before public release", async () => {
    mocks.getReportByShareToken.mockResolvedValue({ id: "report-1", workspaceId: "workspace-1" })
    mocks.reportFindFirst
      .mockResolvedValueOnce({
        type: "launch_readiness",
        contentJson: validLaunchPayload(),
        provenanceJson: null,
      })
      .mockResolvedValueOnce(null)
    expect(await getSharedLaunchReport("report-1", "a".repeat(64))).toBeNull()
  })

  it("presents an unbound legacy report as historical", async () => {
    const storedPayload = validLaunchPayload({
      expiresAt: new Date(Date.now() + DAY_MS).toISOString(),
    })
    mocks.getReportByShareToken.mockResolvedValue({ id: "report-1", workspaceId: "workspace-1" })
    mocks.reportFindFirst.mockResolvedValue({
      type: "launch_readiness",
      contentJson: storedPayload,
      provenanceJson: null,
    })
    expect((await getSharedLaunchReport("report-1", "a".repeat(64)))?.stale).toBe(true)
  })

  it("rejects malformed and checksum-mismatched shared payloads", async () => {
    mocks.getReportByShareToken.mockResolvedValue({ id: "report-1", workspaceId: "workspace-1" })
    mocks.reportFindFirst.mockResolvedValue({
      type: "launch_readiness",
      contentJson: { ...validLaunchPayload(), verdictLabel: "attacker-controlled" },
    })
    await expect(getSharedLaunchReport("report-1", "a".repeat(64))).resolves.toBeNull()
  })

  it("rejects a token resolved for a different report", async () => {
    mocks.getReportByShareToken.mockResolvedValue({
      id: "report-other",
      workspaceId: "workspace-1",
    })
    await expect(getSharedLaunchReport("report-1", "a".repeat(64))).resolves.toBeNull()
    expect(mocks.reportFindFirst).not.toHaveBeenCalled()
  })
})

describe("confirmSharedLaunchReportIdentity — confirmation without disclosure", () => {
  const identityBindingKey = "d".repeat(64)
  const provenance = {
    schemaVersion: "lyrashield-report-provenance/1.0.0",
    gateVerdictId: "verdict-1",
    verdictChecksum: "vc-1",
    assessmentVersion: 2,
    assessedIdentity: { kind: "COMMIT", value: COMMIT },
    assessedAt: EVALUATED_AT.toISOString(),
    issuedAt: EVALUATED_AT.toISOString(),
    applicabilityCheckedAt: EVALUATED_AT.toISOString(),
    applicability: "applicable",
    reasonCodes: [],
    historicalState: "READY",
    effectiveState: "READY",
    identityBindingKey,
  }
  const payload = buildLaunchReportPayload(
    {
      standardVersion: "lyrashield-gate/1.0.0",
      state: "READY",
      coverageStatement: ["engine", "sca"],
      nonCoverage: [],
      blockingReasons: [],
      evidenceSummary: {
        verified: 0,
        retestConfirmed: 0,
        unresolvedCritical: 0,
        unresolvedHigh: 0,
        unresolvedMedium: 0,
        unresolvedLow: 0,
        acceptedRisk: 0,
        falsePositive: 0,
      },
      staleness: { current: true },
      verdictChecksum: "vc-1",
      evaluatedAt: EVALUATED_AT,
    },
    {
      issuedAt: EVALUATED_AT,
      identityCommitment: launchReportIdentityCommitment(identityBindingKey, {
        workspaceId: "workspace-1",
        targetId: "target-1",
        verdictId: "verdict-1",
        verdictChecksum: "vc-1",
        assessmentVersion: 2,
        identity: { kind: "COMMIT", value: COMMIT },
      }),
    }
  )

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getReportByShareToken.mockResolvedValue({
      id: "report-1",
      workspaceId: "workspace-1",
      shareExpiresAt: new Date(Date.now() + DAY_MS),
    })
    mocks.gateVerdictFindFirst.mockResolvedValue(verdictRow())
    mocks.reportFindFirst.mockResolvedValue({
      type: "launch_readiness",
      shareExpiresAt: new Date(Date.now() + DAY_MS),
      contentJson: payload,
      provenanceJson: provenance,
    })
  })

  it("binds the signed public report to its exact private verdict and release identity", async () => {
    mocks.policyFindFirst.mockResolvedValue(policy)
    mocks.scanFindFirst.mockResolvedValue(null)
    mocks.findingFindFirst.mockResolvedValue(null)
    mocks.findingVerificationFindFirst.mockResolvedValue(null)
    mocks.findingFindMany.mockResolvedValue([])
    mocks.reportCreate.mockResolvedValue({ id: "report-1" })
    const result = await generateLaunchReport("workspace-1", "target-1", "user-1", {
      now: EVALUATED_AT,
      signingPrivateKey: privateKey,
    })
    const issuedProvenance = mocks.reportCreate.mock.calls[0]![0].data.provenanceJson
    const signed = result!.payload
    expect(signed.payloadVersion).toBe("lyrashield-launch-report/3.0.0")
    expect(signed.identityCommitment).toMatch(/^[a-f0-9]{64}$/)
    expect(verifyLaunchReportSignature(signed.reportChecksum, signed.signature!, publicKey)).toBe(
      true
    )
    expect(JSON.stringify(signed)).not.toContain(COMMIT)
    expect(JSON.stringify(signed)).not.toContain("target-1")
    const replacement = {
      ...verdictRow(),
      id: "verdict-2",
      targetId: "target-2",
      assessmentSnapshot: assessmentSnapshot({
        identity: { kind: "COMMIT", value: "c".repeat(40) },
      }),
    }
    const swapped = {
      ...issuedProvenance,
      gateVerdictId: replacement.id,
      assessedIdentity: { kind: "COMMIT", value: "c".repeat(40) },
    }
    mocks.gateVerdictFindFirst.mockResolvedValue(replacement)
    mocks.reportFindFirst.mockResolvedValue({
      type: "launch_readiness",
      shareExpiresAt: new Date(Date.now() + DAY_MS),
      contentJson: signed,
      provenanceJson: swapped,
    })
    expect(
      await confirmSharedLaunchReportIdentity({
        reportId: "report-1",
        token: "a".repeat(64),
        reportChecksum: signed.reportChecksum,
        identity: { kind: "COMMIT", value: "c".repeat(40) },
      })
    ).toBe("UNAVAILABLE")
  })

  it("never strongly confirms identity from a pre-commitment report", async () => {
    const legacy = validLaunchPayload()
    mocks.reportFindFirst.mockResolvedValue({
      type: "launch_readiness",
      shareExpiresAt: new Date(Date.now() + DAY_MS),
      contentJson: legacy,
      provenanceJson: provenance,
    })
    expect(
      await confirmSharedLaunchReportIdentity({
        reportId: "report-1",
        token: "a".repeat(64),
        reportChecksum: legacy.reportChecksum,
        identity: { kind: "COMMIT", value: COMMIT },
      })
    ).toBe("UNAVAILABLE")
  })

  it("confirms the exact token-bound identity without returning its value", async () => {
    await expect(
      confirmSharedLaunchReportIdentity({
        reportId: "report-1",
        token: "a".repeat(64),
        reportChecksum: payload.reportChecksum,
        identity: { kind: "COMMIT", value: COMMIT.toUpperCase() },
      })
    ).resolves.toBe("MATCH")
  })

  it("returns MISMATCH for a different identity of the same kind", async () => {
    await expect(
      confirmSharedLaunchReportIdentity({
        reportId: "report-1",
        token: "a".repeat(64),
        reportChecksum: payload.reportChecksum,
        identity: { kind: "COMMIT", value: "c".repeat(40) },
      })
    ).resolves.toBe("MISMATCH")
  })

  it("does not disclose a matching identity when the share is revoked after qualification", async () => {
    mocks.reportFindFirst
      .mockResolvedValueOnce({
        type: "launch_readiness",
        shareExpiresAt: new Date(Date.now() + DAY_MS),
        contentJson: payload,
        provenanceJson: provenance,
      })
      .mockResolvedValueOnce(null)
    expect(
      await confirmSharedLaunchReportIdentity({
        reportId: "report-1",
        token: "a".repeat(64),
        reportChecksum: payload.reportChecksum,
        identity: { kind: "COMMIT", value: COMMIT },
      })
    ).toBe("UNAVAILABLE")
  })

  it("cannot confirm identity when its stored verdict exceeds the transport bound", async () => {
    mocks.gateVerdictFindFirst.mockResolvedValue(verdictRow({ evidenceTooLarge: true }))
    expect(
      await confirmSharedLaunchReportIdentity({
        reportId: "report-1",
        token: "a".repeat(64),
        reportChecksum: payload.reportChecksum,
        identity: { kind: "COMMIT", value: COMMIT },
      })
    ).toBe("UNAVAILABLE")
  })

  it("rejects swapped provenance identity even when the requested identity matches it", async () => {
    const swapped = { ...provenance, assessedIdentity: { kind: "COMMIT", value: "c".repeat(40) } }
    mocks.reportFindFirst.mockResolvedValueOnce({
      type: "launch_readiness",
      shareExpiresAt: new Date(Date.now() + DAY_MS),
      contentJson: payload,
      provenanceJson: swapped,
    })
    expect(
      await confirmSharedLaunchReportIdentity({
        reportId: "report-1",
        token: "a".repeat(64),
        reportChecksum: payload.reportChecksum,
        identity: { kind: "COMMIT", value: "c".repeat(40) },
      })
    ).toBe("UNAVAILABLE")
  })

  it("keeps issue-time identity confirmation independent of current policy", async () => {
    mocks.policyFindFirst.mockRejectedValueOnce(new Error("policy unavailable"))
    expect(
      await confirmSharedLaunchReportIdentity({
        reportId: "report-1",
        token: "a".repeat(64),
        reportChecksum: payload.reportChecksum,
        identity: { kind: "COMMIT", value: COMMIT },
      })
    ).toBe("MATCH")
    expect(mocks.policyFindFirst).not.toHaveBeenCalled()
  })

  it("does not confirm identity from a checksum-mismatched stored payload", async () => {
    const malformed = { ...payload, reportChecksum: "f".repeat(64) }
    mocks.reportFindFirst.mockResolvedValueOnce({
      contentJson: malformed,
      provenanceJson: provenance,
    })
    await expect(
      confirmSharedLaunchReportIdentity({
        reportId: "report-1",
        token: "a".repeat(64),
        reportChecksum: malformed.reportChecksum,
        identity: { kind: "COMMIT", value: COMMIT },
      })
    ).resolves.toBe("UNAVAILABLE")
  })

  it.each([
    ["unknown token", null, "report-1", payload.reportChecksum],
    [
      "cross-report token",
      {
        id: "report-other",
        workspaceId: "workspace-1",
        shareExpiresAt: new Date(Date.now() + DAY_MS),
      },
      "report-1",
      payload.reportChecksum,
    ],
    [
      "wrong signed checksum",
      {
        id: "report-1",
        workspaceId: "workspace-1",
        shareExpiresAt: new Date(Date.now() + DAY_MS),
      },
      "report-1",
      "e".repeat(64),
    ],
  ])("collapses %s to UNAVAILABLE", async (_label, tokenResult, reportId, reportChecksum) => {
    mocks.getReportByShareToken.mockResolvedValue(tokenResult)
    await expect(
      confirmSharedLaunchReportIdentity({
        reportId,
        token: "a".repeat(64),
        reportChecksum,
        identity: { kind: "COMMIT", value: COMMIT },
      })
    ).resolves.toBe("UNAVAILABLE")
  })

  it("collapses legacy provenance and identity-kind probing to UNAVAILABLE", async () => {
    mocks.reportFindFirst.mockResolvedValueOnce({
      contentJson: payload,
      provenanceJson: null,
    })
    await expect(
      confirmSharedLaunchReportIdentity({
        reportId: "report-1",
        token: "a".repeat(64),
        reportChecksum: payload.reportChecksum,
        identity: { kind: "COMMIT", value: COMMIT },
      })
    ).resolves.toBe("UNAVAILABLE")

    await expect(
      confirmSharedLaunchReportIdentity({
        reportId: "report-1",
        token: "a".repeat(64),
        reportChecksum: payload.reportChecksum,
        identity: { kind: "ARTIFACT_DIGEST", value: `sha256:${"d".repeat(64)}` },
      })
    ).resolves.toBe("UNAVAILABLE")
  })
})
