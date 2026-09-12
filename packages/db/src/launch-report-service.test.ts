import { createHash } from "node:crypto"
import { beforeEach, describe, expect, it, vi } from "vitest"

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
  findingVerificationFindFirst: vi.fn(),
  reportCreate: vi.fn(),
  reportFindFirst: vi.fn(),
  getReportByShareToken: vi.fn(),
  rlsOptions: [] as unknown[],
}))

vi.mock("./client", () => ({
  prisma: {
    gateVerdict: { findFirst: mocks.gateVerdictFindFirst },
    policy: { findFirst: mocks.policyFindFirst },
    scan: { findFirst: mocks.scanFindFirst },
    finding: { findFirst: mocks.findingFindFirst },
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
vi.mock("./report-service", () => ({
  getReportByShareToken: mocks.getReportByShareToken,
}))
vi.mock("@lyrashield/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))
vi.mock("@lyrashield/config", () => ({
  env: { LAUNCH_REPORT_SIGNING_PRIVATE_KEY: undefined },
}))

import {
  generateLaunchReport,
  getLaunchReportDetail,
  getSharedLaunchReport,
} from "./launch-report-service"

const EVALUATED_AT = new Date("2026-09-10T00:00:00.000Z")
const COMPLETED_AT_MS = EVALUATED_AT.getTime() - 60_000
const COMMIT = "b".repeat(40)
const DAY_MS = 24 * 60 * 60 * 1000

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
      verified: 3,
      retestConfirmed: 1,
      unresolvedCritical: 0,
      unresolvedHigh: 0,
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
    mocks.findingVerificationFindFirst.mockResolvedValue(null)
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
    // The private binding never widens the signed public payload.
    expect(Object.keys(payload!).sort()).toEqual([
      "appDisplayName",
      "assessmentDate",
      "counts",
      "coverageStatement",
      "dispositionCounts",
      "evaluatedAt",
      "expiresAt",
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
    mocks.reportFindFirst.mockResolvedValue({
      type: "launch_readiness",
      contentJson: { verdictLabel: "Ready to launch", stale: false },
      provenanceJson: {
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
      },
    })
    const detail = await getLaunchReportDetail("report-1", "workspace-1")
    expect(detail?.verdictLabel).toBe("Ready to launch")
    expect(detail?.provenance?.assessedIdentity).toEqual({ kind: "COMMIT", value: COMMIT })
  })

  it("returns null provenance for a legacy report so callers can state it explicitly", async () => {
    mocks.reportFindFirst.mockResolvedValue({
      type: "launch_readiness",
      contentJson: { verdictLabel: "Not ready", stale: true },
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
})

describe("getSharedLaunchReport — public frozen payload", () => {
  beforeEach(() => vi.clearAllMocks())

  it("marks an expired payload stale at read time without rewriting stored bytes", async () => {
    mocks.getReportByShareToken.mockResolvedValue({ id: "report-1", workspaceId: "workspace-1" })
    mocks.reportFindFirst.mockResolvedValue({
      type: "launch_readiness",
      contentJson: {
        payloadVersion: "lyrashield-launch-report/2.0.0",
        verdictLabel: "Ready to launch",
        stale: false,
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
      },
    })
    const payload = await getSharedLaunchReport("report-1", "a".repeat(64))
    expect(payload?.stale).toBe(true)
    // Stored row untouched — the flag lives only on the returned copy.
    expect(mocks.reportCreate).not.toHaveBeenCalled()
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
