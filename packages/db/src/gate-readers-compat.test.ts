import { createHash } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import { fingerprintPolicy } from "./gate-assessment"

const mocks = vi.hoisted(() => {
  const state: { tx: Record<string, unknown> } = { tx: {} }
  return state
})
vi.mock("./rls", () => ({
  withWorkspaceRLS: async (_workspaceId: string, fn: (tx: unknown) => Promise<unknown>) =>
    fn(mocks.tx),
}))
import { getCurrentGateVerdict, getCurrentGateVerdicts } from "./gate-service"

const now = new Date("2026-11-12T12:00:00Z")
const policy = { id: "policy", workspaceId: "workspace", name: "Default" }
const summary = {
  detected: 1,
  validated: 0,
  verified: 0,
  retestConfirmed: 1,
  inconclusive: 0,
  insufficientPositiveEvidence: 0,
  blockingUnverified: 0,
  unresolvedCritical: 0,
  unresolvedHigh: 0,
  unresolvedMedium: 0,
  unresolvedLow: 0,
  acceptedRisk: 0,
  falsePositive: 0,
}

function fixture(targetId: string, version: string) {
  const scan = (id: string, revision: string) => {
    const manifest = {
      target: { id: targetId, type: "REPO", urlChecksum: null },
      sourceExecution: { sourceRevision: revision },
      terminalOutcome: { status: "COMPLETED" },
      coverage: [{ scanner: "sca", controlId: "sca", status: "COMPLETED" }],
    }
    const checksumInput = JSON.stringify(manifest)
    const checksum = createHash("sha256").update(checksumInput).digest("hex")
    return {
      id,
      workspaceId: "workspace",
      targetId,
      status: "COMPLETED",
      resultManifest: { checksum, checksumInput, manifest },
      coverageReceipts: [
        {
          id: `coverage-${id}`,
          scanId: id,
          scanner: "sca",
          controlId: "sca",
          status: "COMPLETED",
          reason: null,
          subject: null,
          metadata: null,
        },
      ],
    }
  }
  const baseline = scan(`baseline-${targetId}`, "b".repeat(40))
  const current = scan(`current-${targetId}`, "c".repeat(40))
  const identity = (s: typeof baseline) => ({
    scanId: s.id,
    manifestChecksum: s.resultManifest.checksum,
    sourceRevision: s.resultManifest.manifest.sourceExecution.sourceRevision,
    targetUrlChecksum: null,
  })
  const finding = {
    id: `finding-${targetId}`,
    targetId,
    severity: "HIGH",
    status: "FIXED",
    verificationStatus: "DETECTED",
    lastSeenAt: now,
    scanId: baseline.id,
    dedupeKey: `key-${targetId}`,
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
        scanId: current.id,
        verifierVersion: version,
        evidence: {
          retestId: `retest-${targetId}`,
          scannerSource: "sca",
          baseline: identity(baseline),
          retest: identity(current),
          coverageReceiptIds: [`coverage-${baseline.id}`, `coverage-${current.id}`],
        },
      },
    ],
  }
  const verdict = {
    id: `verdict-${targetId}`,
    workspaceId: "workspace",
    targetId,
    scanId: current.id,
    standardVersion: "lyrashield-gate/2.4.0",
    state: "READY",
    coverageStatement: [],
    nonCoverage: [],
    blockingReasons: [],
    evidenceSummary: summary,
    staleness: {},
    inputChecksum: "fixture",
    verdictChecksum: "fixture",
    assessmentVersion: 2,
    evaluatedAt: now,
    assessmentSnapshot: {
      version: 2,
      scanId: current.id,
      completedAtMs: now.getTime() - 60_000,
      manifestChecksum: current.resultManifest.checksum,
      manifestVersion: 7,
      policyId: "policy",
      policyFingerprint: fingerprintPolicy(policy),
      identity: { kind: "COMMIT", value: "c".repeat(40) },
    },
  }
  return {
    baseline,
    current,
    finding,
    verdict,
    retest: {
      id: `retest-${targetId}`,
      workspaceId: "workspace",
      findingId: finding.id,
      scanId: current.id,
      status: "passed",
    },
    candidate: {
      targetId,
      findingId: finding.id,
      scanId: baseline.id,
      dedupeKey: finding.dedupeKey,
      scannerSource: "sca",
      payload: {},
    },
  }
}

describe("gate readers with retained worker receipts", () => {
  it("agrees across single and batched reads and preserves a verified verdict", async () => {
    const weak = fixture("weak", "result-integrity-v2")
    const strong = fixture("strong", "result-integrity-v3")
    const data = [weak, strong]
    let rawCalls = 0
    const findMany = vi.fn((targetIds: string[]) =>
      data.filter((f) => targetIds.includes(f.finding.targetId)).map((f) => f.finding)
    )
    mocks.tx = {
      gateVerdict: {
        findFirst: vi.fn(
          async ({ where }) => data.find((f) => f.verdict.targetId === where.targetId)?.verdict
        ),
      },
      policy: {
        findFirst: vi.fn().mockResolvedValue(policy),
        findMany: vi.fn().mockResolvedValue([policy]),
      },
      scan: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue(data.flatMap((f) => [f.baseline, f.current])),
      },
      finding: { findFirst: vi.fn().mockResolvedValue(null) },
      findingVerification: { findFirst: vi.fn().mockResolvedValue(null) },
      retest: { findMany: vi.fn().mockResolvedValue(data.map((f) => f.retest)) },
      findingCandidate: { findMany: vi.fn().mockResolvedValue(data.map((f) => f.candidate)) },
      $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join("?")
        if (sql.includes('"verificationReceipts"') && sql.includes('"Finding"'))
          return findMany(values[0] as string[])
        if (sql.includes('FROM "Scan" s'))
          return data
            .flatMap((f) => [f.baseline, f.current])
            .filter(
              (scan) =>
                (values[1] as string[]).includes(scan.id) &&
                (values[2] as string[]).includes(scan.targetId)
            )
        if (sql.includes('FROM "Retest"'))
          return data
            .map((f) => f.retest)
            .filter(
              (r) =>
                (values[1] as string[]).includes(r.id) &&
                (values[2] as string[]).includes(r.findingId)
            )
        if (sql.includes("jsonb_to_recordset")) {
          const requests = JSON.parse(values[0] as string) as { targetId: string }[]
          return data
            .filter((f) => requests.some((r) => r.targetId === f.finding.targetId))
            .map((f) => f.candidate)
        }
        return rawCalls++ === 0 ? data.map((f) => f.verdict) : []
      }),
    }
    const batch = await getCurrentGateVerdicts("workspace", ["weak", "strong"], { now })
    expect(batch.get("weak")).toMatchObject({
      state: "INSUFFICIENT_EVIDENCE",
      applicability: { applicable: false, reasons: [{ code: "UNTRUSTED_GATE_EVIDENCE" }] },
      historical: { state: "READY" },
    })
    expect(batch.get("strong")).toMatchObject({
      state: "READY",
      applicability: { applicable: true },
    })
    expect(findMany).toHaveBeenCalledTimes(1)
    for (const target of ["weak", "strong"]) {
      expect(await getCurrentGateVerdict("workspace", target, { now })).toEqual(batch.get(target))
    }
  })
})
