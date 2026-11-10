import { createHash, generateKeyPairSync } from "node:crypto"
import {
  computeReleasePacketChecksum,
  LEGACY_RELEASE_PACKET_VERSION,
  RELEASE_PACKET_VERSION,
  ReleasePacketPayloadSchema,
  type ReleasePacketPayload,
} from "@lyrashield/types"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  withWorkspaceRLS: vi.fn(),
  evaluateVerdictApplicability: vi.fn(),
  parseAssessmentSnapshot: vi.fn(),
  isLaunchReportShareablePayload: vi.fn(),
  parseLaunchReportProvenance: vi.fn(),
  verifyLaunchReportSignature: vi.fn(),
  resolveReportDelegationTarget: vi.fn(),
}))

vi.mock("./rls", () => ({ withWorkspaceRLS: mocks.withWorkspaceRLS }))
vi.mock("./report-service", () => ({
  resolveReportDelegationTarget: mocks.resolveReportDelegationTarget,
}))
vi.mock("./gate-service", () => ({
  evaluateVerdictApplicability: mocks.evaluateVerdictApplicability,
  parseAssessmentSnapshot: mocks.parseAssessmentSnapshot,
}))
vi.mock("./launch-report-html", () => ({
  isLaunchReportShareablePayload: mocks.isLaunchReportShareablePayload,
}))
vi.mock("./launch-report-provenance", () => ({
  parseLaunchReportProvenance: mocks.parseLaunchReportProvenance,
}))
vi.mock("./launch-report-signing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./launch-report-signing")>()
  return {
    ...actual,
    verifyLaunchReportSignature: (message: string, signature: string, key: string) =>
      message.startsWith("lyrashield-release-packet/")
        ? actual.verifyLaunchReportSignature(message, signature, key)
        : mocks.verifyLaunchReportSignature(message, signature, key),
  }
})

import {
  classifyReleaseFindings,
  getReleasePacket,
  getReleasePacketForDelegatedRead,
  issueReleasePacket,
} from "./release-packet-service"
import {
  releasePacketSigningKeyId,
  signReleasePacketChecksum,
  verifyReleasePacketChecksum,
} from "./release-packet-signing"

const scanStartedAt = new Date("2026-11-05T00:00:00.000Z")
const commit = "b".repeat(40)
const packetKeyPair = generateKeyPairSync("ed25519")
const packetPrivateKey = packetKeyPair.privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString()
const packetPublicKey = packetKeyPair.publicKey.export({ type: "spki", format: "pem" }).toString()
const packetKeys = [
  { id: releasePacketSigningKeyId(packetPublicKey), publicKey: packetPublicKey, revoked: false },
]

function finding(overrides: Record<string, unknown> = {}) {
  return {
    id: "finding-1",
    dedupeKey: "dedupe-1",
    title: "Tenant scope missing",
    severity: "HIGH",
    status: "OPEN",
    verificationStatus: "DETECTED",
    sourceRevision: commit,
    baseCommit: commit,
    firstSeenAt: new Date("2026-11-04T00:00:00.000Z"),
    lastSeenAt: new Date("2026-11-05T00:01:00.000Z"),
    trustedRetest: false,
    retestState: "none" as const,
    fixProposal: null as null | { status: string; baseCommit: string | null },
    ...overrides,
  }
}

describe("classifyReleaseFindings", () => {
  it("uses dedupe identity to separate new and recurring findings", () => {
    const result = classifyReleaseFindings({
      findings: [finding(), finding({ id: "finding-2", dedupeKey: "dedupe-2" })],
      currentObservedKeys: new Set(["dedupe-1", "dedupe-2"]),
      baselineObservedKeys: new Set(["dedupe-1"]),
      currentScanStartedAt: scanStartedAt,
      assessedIdentity: { kind: "COMMIT", value: commit },
      uncertainCandidateCount: 0,
    })

    expect(result.counts).toMatchObject({ newFindings: 1, recurringFindings: 1 })
    expect(result.findings.map((item) => item.category).sort()).toEqual(["new", "recurring"])
  })

  it("marks base-revision drift as a stale proposal", () => {
    const result = classifyReleaseFindings({
      findings: [
        finding({
          fixProposal: { status: "ready", baseCommit: "c".repeat(40) },
        }),
      ],
      currentObservedKeys: new Set(["dedupe-1"]),
      baselineObservedKeys: new Set(),
      currentScanStartedAt: scanStartedAt,
      assessedIdentity: { kind: "COMMIT", value: commit },
      uncertainCandidateCount: 0,
    })

    expect(result.findings[0]?.proposalState).toBe("stale")
  })

  it("counts resolution only with a trusted retest and preserves unsupported fixes as uncertain", () => {
    const result = classifyReleaseFindings({
      findings: [
        finding({
          id: "resolved",
          status: "FIXED",
          trustedRetest: true,
          retestState: "trusted",
        }),
        finding({ id: "unsupported", status: "FIXED", trustedRetest: false }),
      ],
      currentObservedKeys: new Set(),
      baselineObservedKeys: new Set(["dedupe-1"]),
      currentScanStartedAt: scanStartedAt,
      assessedIdentity: { kind: "COMMIT", value: commit },
      uncertainCandidateCount: 0,
    })

    expect(result.counts.resolvedFindings).toBe(1)
    expect(result.counts.uncertainMatches).toBe(1)
    expect(result.findings.find((item) => item.findingId === "unsupported")?.category).toBe(
      "uncertain"
    )
  })

  it("bounds detail rows while retaining exact counts", () => {
    const findings = Array.from({ length: 105 }, (_, index) =>
      finding({ id: `finding-${index}`, dedupeKey: `dedupe-${index}` })
    )
    const result = classifyReleaseFindings({
      findings,
      currentObservedKeys: new Set(findings.map((item) => item.dedupeKey)),
      baselineObservedKeys: new Set(),
      currentScanStartedAt: scanStartedAt,
      assessedIdentity: { kind: "COMMIT", value: commit },
      uncertainCandidateCount: 2,
      detailLimit: 100,
    })
    expect(result.counts.newFindings).toBe(105)
    expect(result.counts.uncertainMatches).toBe(2)
    expect(result.findings).toHaveLength(100)
    expect(result.truncated).toBe(true)
  })
})

function makeTx() {
  return {
    $queryRaw: vi.fn(),
    target: { findFirst: vi.fn() },
    gateVerdict: { findFirst: vi.fn() },
    scan: { findFirst: vi.fn() },
    finding: { findMany: vi.fn() },
    findingCandidate: { findMany: vi.fn(), count: vi.fn() },
    scanCoverageReceipt: { findMany: vi.fn() },
    report: { findMany: vi.fn(), create: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
  }
}

function setupIssuance(tx: ReturnType<typeof makeTx>) {
  tx.target.findFirst.mockResolvedValue({
    id: "target-1",
    name: "Release App",
    type: "REPO",
    environment: "PRODUCTION",
  })
  tx.gateVerdict.findFirst.mockResolvedValue({
    id: "verdict-1",
    state: "NOT_READY",
    standardVersion: "lyrashield-gate/2.4.0",
    evaluatedAt: new Date("2026-11-05T00:00:00.000Z"),
    coverageStatement: ["sast"],
    nonCoverage: [],
    assessmentSnapshot: "snapshot",
  })
  mocks.parseAssessmentSnapshot.mockReturnValue({
    identity: { kind: "COMMIT", value: commit },
    scanId: "scan-1",
    policyId: "policy-1",
    completedAtMs: Date.parse("2026-11-05T00:00:00.000Z"),
  })
  mocks.evaluateVerdictApplicability.mockResolvedValue({
    applicable: false,
    reasons: [{ code: "EVIDENCE_CHANGED", message: "Evidence changed after assessment" }],
    effectiveState: "INSUFFICIENT_EVIDENCE",
    evaluatedIdentity: { kind: "COMMIT", value: commit },
  })
  tx.scan.findFirst.mockImplementation(async ({ where }: { where: { id?: object } }) =>
    where.id === "scan-1"
      ? {
          id: "scan-1",
          endedAt: new Date("2026-11-05T00:00:00.000Z"),
          createdAt: new Date("2026-11-05T00:00:00.000Z"),
          startedAt: new Date("2026-11-05T00:00:00.000Z"),
          resultManifest: { checksum: "c".repeat(64) },
        }
      : null
  )
  tx.finding.findMany.mockResolvedValue([])
  tx.findingCandidate.findMany.mockResolvedValue([])
  tx.findingCandidate.count.mockResolvedValue(0)
  tx.scanCoverageReceipt.findMany.mockResolvedValue([])
  tx.report.create.mockResolvedValue({ id: "report-1" })
}

describe("issueReleasePacket", () => {
  let issueTx: ReturnType<typeof makeTx>

  beforeEach(() => {
    issueTx = makeTx()
    vi.clearAllMocks()
    setupIssuance(issueTx)
    mocks.withWorkspaceRLS.mockImplementation(
      async (_workspaceId: string, fn: (tx: unknown) => unknown) => fn(issueTx)
    )
    mocks.isLaunchReportShareablePayload.mockReturnValue(true)
    mocks.parseLaunchReportProvenance.mockImplementation((value: unknown) => {
      const provenance = value as { gateVerdictId?: string; assessedIdentity?: unknown }
      return provenance?.gateVerdictId === "verdict-1"
        ? {
            gateVerdictId: "verdict-1",
            assessedIdentity: { kind: "COMMIT", value: commit },
          }
        : null
    })
    mocks.verifyLaunchReportSignature.mockReturnValue(true)
    issueTx.report.findMany.mockResolvedValue([
      {
        id: "launch-report-1",
        contentJson: {
          reportChecksum: "d".repeat(64),
          signature: "signature",
          signingKeyId: "lyrashield-launch-report-ed25519-1",
          expiresAt: "2026-11-07T00:00:00.000Z",
        },
        provenanceJson: { gateVerdictId: "verdict-1" },
      },
    ])
  })

  it("rejects an exact release revision mismatch before creating a packet", async () => {
    await expect(
      issueReleasePacket({
        workspaceId: "ws-1",
        targetId: "target-1",
        actorUserId: "user-1",
        expectedIdentity: { kind: "COMMIT", value: "c".repeat(40) },
      })
    ).rejects.toMatchObject({ code: "RELEASE_IDENTITY_MISMATCH" })
  })

  it("uses effective applicability state, retains the raw verdict, and signs the bound lineage", async () => {
    const result = await issueReleasePacket({
      workspaceId: "ws-1",
      targetId: "target-1",
      actorUserId: "user-1",
      expectedIdentity: { kind: "COMMIT", value: commit },
      signingPublicKey: packetPublicKey,
      signingPrivateKey: packetPrivateKey,
      verificationKeys: packetKeys,
      now: new Date("2026-11-06T00:00:00.000Z"),
    })

    expect(result.payload.assessment.state).toBe("INSUFFICIENT_EVIDENCE")
    expect(result.payload.assessment.historicalState).toBe("NOT_READY")
    expect(result.payload.signedAssessment).toMatchObject({
      state: "SIGNED",
      reportId: "launch-report-1",
      reportChecksum: "d".repeat(64),
    })
    expect(result.payload.signingKeyId).toBe(packetKeys[0]!.id)
    expect(result.payload.expiresAt).toBe("2026-11-07T00:00:00.000Z")
    expect(
      verifyReleasePacketChecksum(
        result.payload.packetChecksum,
        result.payload.packetSignature!,
        result.payload.signingKeyId!,
        packetKeys
      )
    ).toBe("VERIFIED")
    const { packetChecksum, ...base } = result.payload
    expect(await computeReleasePacketChecksum(base)).toBe(packetChecksum)
  })

  it("resolves the signed report by exact verdict lineage without a latest-50 cap", async () => {
    const tx = issueTx
    const olderReports = Array.from({ length: 51 }, (_, index) => ({
      id: `unrelated-${index}`,
      contentJson: null,
      provenanceJson: { gateVerdictId: `unrelated-${index}` },
    }))
    tx.report.findMany.mockResolvedValue([
      ...olderReports,
      {
        id: "launch-report-1",
        contentJson: {
          reportChecksum: "d".repeat(64),
          signature: "signature",
          signingKeyId: "lyrashield-launch-report-ed25519-1",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        provenanceJson: { gateVerdictId: "verdict-1" },
      },
    ])

    const result = await issueReleasePacket({
      workspaceId: "ws-1",
      targetId: "target-1",
      actorUserId: "user-1",
      expectedIdentity: { kind: "COMMIT", value: commit },
      signingPublicKey: packetPublicKey,
      signingPrivateKey: packetPrivateKey,
      verificationKeys: packetKeys,
    })

    expect(result.payload.signedAssessment.state).toBe("SIGNED")
    const query = tx.report.findMany.mock.calls[0]?.[0] as {
      where: { provenanceJson: unknown }
      take?: number
    }
    expect(query.where.provenanceJson).toEqual({
      path: ["gateVerdictId"],
      equals: "verdict-1",
    })
    expect(query.take).toBeUndefined()
  })

  it("refuses issuance without an allowed signing key and caps packet validity by assessment expiry", async () => {
    const input = {
      workspaceId: "ws-1",
      targetId: "target-1",
      actorUserId: "user-1",
      expectedIdentity: { kind: "COMMIT" as const, value: commit },
      signingPublicKey: packetPublicKey,
      now: new Date("2026-11-06T00:00:00.000Z"),
    }
    await expect(issueReleasePacket(input)).rejects.toMatchObject({ code: "SIGNING_UNAVAILABLE" })
    await expect(
      issueReleasePacket({
        ...input,
        signingPrivateKey: packetPrivateKey,
        verificationKeys: [{ ...packetKeys[0]!, revoked: true }],
      })
    ).rejects.toMatchObject({ code: "SIGNING_UNAVAILABLE" })
    expect(issueTx.report.create).not.toHaveBeenCalled()
    issueTx.report.findMany.mockResolvedValue([
      {
        id: "launch-report-1",
        contentJson: {
          reportChecksum: "d".repeat(64),
          signature: "signature",
          signingKeyId: "lyrashield-launch-report-ed25519-1",
          expiresAt: "2026-11-06T06:00:00.000Z",
        },
        provenanceJson: { gateVerdictId: "verdict-1" },
      },
    ])
    const result = await issueReleasePacket({
      ...input,
      signingPrivateKey: packetPrivateKey,
      verificationKeys: packetKeys,
    })
    expect(result.payload.expiresAt).toBe("2026-11-06T06:00:00.000Z")
  })

  it("does not record a revoked assessment key as trusted when a new packet key is allowed", async () => {
    const newPair = generateKeyPairSync("ed25519")
    const newPrivate = newPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString()
    const newPublic = newPair.publicKey.export({ type: "spki", format: "pem" }).toString()
    const result = await issueReleasePacket({
      workspaceId: "ws-1",
      targetId: "target-1",
      actorUserId: "user-1",
      expectedIdentity: { kind: "COMMIT", value: commit },
      signingPublicKey: packetPublicKey,
      signingPrivateKey: newPrivate,
      verificationKeys: [
        { ...packetKeys[0]!, revoked: true },
        { id: releasePacketSigningKeyId(newPublic), publicKey: newPublic, revoked: false },
      ],
      now: new Date("2026-11-06T00:00:00.000Z"),
    })
    expect(result.payload.signedAssessment.state).toBe("UNAVAILABLE")
  })
})

async function storedPayload(): Promise<ReleasePacketPayload> {
  const base: Omit<ReleasePacketPayload, "packetChecksum"> = {
    version: LEGACY_RELEASE_PACKET_VERSION,
    generatedAt: "2026-11-05T00:00:00.000Z",
    target: { id: "target-1", name: "Release App", type: "REPO", environment: "PRODUCTION" },
    assessment: {
      verdictId: "verdict-1",
      standardVersion: "lyrashield-gate/2.4.0",
      state: "INSUFFICIENT_EVIDENCE",
      historicalState: "NOT_READY",
      applicable: false,
      reasons: [{ code: "EVIDENCE_CHANGED", message: "Evidence changed after assessment" }],
      evaluatedAt: "2026-11-05T00:00:00.000Z",
      assessedIdentity: { kind: "COMMIT", value: commit },
      coverageStatement: ["sast"],
      nonCoverage: [],
    },
    signedAssessment: {
      state: "UNSIGNED",
      reportId: "launch-report-1",
      reportChecksum: "d".repeat(64),
      reason: "The assessment was issued without a signature.",
    },
    remediation: {
      baselineScanId: null,
      currentScanId: "scan-1",
      counts: { newFindings: 0, recurringFindings: 0, resolvedFindings: 0, uncertainMatches: 0 },
      findings: [],
      truncated: false,
    },
    coverage: {
      completed: ["sast"],
      notApplicable: [],
      incomplete: [],
      manifestChecksum: "c".repeat(64),
    },
  }
  const payload = ReleasePacketPayloadSchema.parse({
    ...base,
    packetChecksum: await computeReleasePacketChecksum(base),
  }) as ReleasePacketPayload
  return payload
}

function readReport(contentJson: unknown, extra: Record<string, unknown> = {}) {
  return {
    contentJson,
    scanId: "scan-1",
    scan: { workspaceId: "ws-1", targetId: "target-1" },
    ...extra,
  }
}

describe("getReleasePacket", () => {
  let readTx: ReturnType<typeof makeTx>

  beforeEach(() => {
    readTx = makeTx()
    vi.clearAllMocks()
    mocks.withWorkspaceRLS.mockImplementation(
      async (_workspaceId: string, fn: (tx: unknown) => unknown) => fn(readTx)
    )
    readTx.report.findFirst.mockResolvedValue({ contentJson: null })
    readTx.report.update.mockResolvedValue({})
  })

  it("parses and recomputes the immutable packet checksum before returning it", async () => {
    const payload = await storedPayload()
    const tx = readTx
    tx.report.findFirst.mockResolvedValue(readReport(payload))

    await expect(getReleasePacket("report-1", "ws-1")).resolves.toMatchObject({
      payload,
      authenticity: { signatureState: "HISTORICAL_UNSIGNED" },
      currentApplicability: { state: "UNAVAILABLE" },
    })

    const tampered = { ...payload, target: { ...payload.target, name: "Tampered" } }
    tx.report.findFirst.mockResolvedValue(readReport(tampered))
    await expect(getReleasePacket("report-1", "ws-1")).rejects.toMatchObject({
      code: "SNAPSHOT_INVALID",
    })
    expect(tx.report.update).not.toHaveBeenCalled()
  })

  it("rejects a snapshot whose content belongs to a different scan than the report", async () => {
    const payload = await storedPayload()
    readTx.report.findFirst.mockResolvedValue(readReport(payload, { scanId: "scan-other" }))

    await expect(getReleasePacket("report-1", "ws-1")).rejects.toMatchObject({
      code: "SNAPSHOT_INVALID",
    })
  })

  it("re-proves the private share token inside the same transaction", async () => {
    const payload = await storedPayload()
    const shareToken = "b".repeat(64)
    const shareTokenHash = createHash("sha256").update(shareToken).digest("hex")
    readTx.report.findFirst.mockResolvedValue(
      readReport(payload, {
        shareTokenHash,
        shareExpiresAt: new Date(Date.now() + 60_000),
        revokedAt: null,
      })
    )

    await expect(getReleasePacket("report-1", "ws-1", { shareToken })).resolves.toMatchObject({
      payload,
    })

    readTx.report.findFirst.mockResolvedValue(
      readReport(payload, {
        shareTokenHash,
        shareExpiresAt: new Date(Date.now() + 60_000),
        revokedAt: new Date(),
      })
    )
    await expect(getReleasePacket("report-1", "ws-1", { shareToken })).resolves.toBeNull()

    readTx.report.findFirst.mockResolvedValue(
      readReport(payload, {
        shareTokenHash,
        shareExpiresAt: new Date(Date.now() + 60_000),
        revokedAt: null,
      })
    )
    await expect(
      getReleasePacket("report-1", "ws-1", { shareToken: "c".repeat(64) })
    ).resolves.toBeNull()
  })

  it("scopes reads to the workspace and never mutates the stored snapshot", async () => {
    const payload = await storedPayload()
    const tx = readTx
    tx.report.findFirst.mockResolvedValue(readReport(payload))

    await getReleasePacket("report-1", "ws-1")

    expect(mocks.withWorkspaceRLS).toHaveBeenCalledWith(
      "ws-1",
      expect.any(Function),
      expect.objectContaining({ isolationLevel: "RepeatableRead" })
    )
    expect(tx.report.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "report-1",
          workspaceId: "ws-1",
          type: "release_packet",
          deletedAt: null,
        },
        select: {
          contentJson: true,
          scanId: true,
          scan: { select: { workspaceId: true, targetId: true } },
          shareTokenHash: true,
          shareExpiresAt: true,
          revokedAt: true,
        },
      })
    )
    expect(tx.report.update).not.toHaveBeenCalled()
  })

  it("rechecks the full packet signature, revocation, expiry, and current applicability on read", async () => {
    const legacy = await storedPayload()
    const base = {
      ...legacy,
      version: RELEASE_PACKET_VERSION,
      generatedAt: "2026-11-06T00:00:00.000Z",
      expiresAt: "2026-11-07T00:00:00.000Z",
      signingKeyId: packetKeys[0]!.id,
    }
    const packetChecksum = await computeReleasePacketChecksum(base)
    const packet = {
      ...base,
      packetChecksum,
      packetSignature: signReleasePacketChecksum(packetChecksum, packetPrivateKey),
    }
    readTx.report.findFirst.mockResolvedValue(readReport(packet))
    readTx.gateVerdict.findFirst.mockResolvedValue({
      id: "verdict-1",
      targetId: "target-1",
      state: "NOT_READY",
      evaluatedAt: new Date("2026-11-05T00:00:00.000Z"),
      assessmentSnapshot: "snapshot",
    })
    mocks.evaluateVerdictApplicability.mockResolvedValue({ applicable: true, reasons: [] })
    const now = new Date("2026-11-06T01:00:00.000Z")
    const result = await getReleasePacket("report-1", "ws-1", { verificationKeys: packetKeys, now })
    expect(result).toMatchObject({
      payload: packet,
      authenticity: { signatureState: "VERIFIED", expired: false },
      assessmentValidity: { signatureState: "UNSIGNED" },
      currentApplicability: { state: "CURRENT" },
    })
    readTx.report.findFirst.mockResolvedValue(readReport({ ...packet, extra: "unbound" }))
    await expect(
      getReleasePacket("report-1", "ws-1", { verificationKeys: packetKeys, now })
    ).rejects.toMatchObject({ code: "SNAPSHOT_INVALID" })
    readTx.report.findFirst.mockResolvedValue(readReport(packet))
    expect(
      (
        await getReleasePacket("report-1", "ws-1", {
          verificationKeys: [{ ...packetKeys[0]!, revoked: true }],
          now,
        })
      )?.authenticity.signatureState
    ).toBe("REVOKED")
    expect(
      (await getReleasePacket("report-1", "ws-1", { verificationKeys: [], now }))?.authenticity
        .signatureState
    ).toBe("UNAVAILABLE")
    expect(
      (
        await getReleasePacket("report-1", "ws-1", {
          verificationKeys: packetKeys,
          now: new Date("2026-11-07T00:00:00.000Z"),
        })
      )?.authenticity.expired
    ).toBe(true)
    mocks.evaluateVerdictApplicability.mockResolvedValue({
      applicable: false,
      reasons: [{ code: "EVIDENCE_CHANGED", message: "Evidence changed" }],
    })
    expect(
      (await getReleasePacket("report-1", "ws-1", { verificationKeys: packetKeys, now }))
        ?.currentApplicability.state
    ).toBe("NOT_CURRENT")
    const changed = { ...packet, target: { ...packet.target, name: "Tampered" } }
    changed.packetChecksum = await computeReleasePacketChecksum(changed)
    readTx.report.findFirst.mockResolvedValue(readReport(changed))
    expect(
      (await getReleasePacket("report-1", "ws-1", { verificationKeys: packetKeys, now }))
        ?.authenticity.signatureState
    ).toBe("INVALID")
  })
})

describe("getReleasePacketForDelegatedRead", () => {
  let readTx: ReturnType<typeof makeTx>
  const authority = {
    allTargets: false,
    allowedTargetIds: ["target-1"],
    allowedProfiles: ["STANDARD"],
  }

  beforeEach(() => {
    readTx = makeTx()
    vi.clearAllMocks()
    mocks.withWorkspaceRLS.mockImplementation(
      async (_workspaceId: string, fn: (tx: unknown) => unknown) => fn(readTx)
    )
    mocks.resolveReportDelegationTarget.mockResolvedValue({
      targetId: "target-1",
      profile: "STANDARD",
    })
  })

  function delegatedInput() {
    return {
      reportId: "report-1",
      workspaceId: "ws-1",
      userId: "user-1",
      connectionId: "conn-1",
      authorizationVersion: 2,
    }
  }

  it("reads the binding, live grant and packet in one RepeatableRead transaction", async () => {
    const payload = await storedPayload()
    readTx.$queryRaw.mockResolvedValue([authority])
    readTx.report.findFirst.mockResolvedValue(readReport(payload))

    await expect(getReleasePacketForDelegatedRead(delegatedInput())).resolves.toMatchObject({
      payload,
    })

    expect(mocks.withWorkspaceRLS).toHaveBeenCalledWith(
      "ws-1",
      expect.any(Function),
      expect.objectContaining({ isolationLevel: "RepeatableRead" })
    )
    expect(mocks.resolveReportDelegationTarget).toHaveBeenCalledWith("report-1", "ws-1", {
      client: readTx,
      withProfile: true,
    })
    expect(readTx.$queryRaw).toHaveBeenCalledTimes(1)
  })

  it("denies an unattributable or profile-less binding before reading content", async () => {
    mocks.resolveReportDelegationTarget.mockResolvedValueOnce({ targetId: null, profile: null })
    await expect(getReleasePacketForDelegatedRead(delegatedInput())).resolves.toBeNull()

    mocks.resolveReportDelegationTarget.mockResolvedValueOnce({
      targetId: "target-1",
      profile: null,
    })
    await expect(getReleasePacketForDelegatedRead(delegatedInput())).resolves.toBeNull()

    expect(readTx.$queryRaw).not.toHaveBeenCalled()
    expect(readTx.report.findFirst).not.toHaveBeenCalled()
  })

  it("denies revoked, narrowed, re-versioned or profile-revoked grants", async () => {
    for (const row of [
      null,
      { ...authority, allTargets: false, allowedTargetIds: ["target-2"] },
      { ...authority, allowedProfiles: ["QUICK"] },
    ]) {
      readTx.$queryRaw.mockResolvedValueOnce(row ? [row] : [])
      await expect(getReleasePacketForDelegatedRead(delegatedInput())).resolves.toBeNull()
    }
    expect(readTx.report.findFirst).not.toHaveBeenCalled()
  })

  it("re-proves the private share token inside the delegated read", async () => {
    const payload = await storedPayload()
    const shareToken = "b".repeat(64)
    readTx.$queryRaw.mockResolvedValue([authority])
    readTx.report.findFirst.mockResolvedValue(
      readReport(payload, {
        shareTokenHash: createHash("sha256").update(shareToken).digest("hex"),
        shareExpiresAt: new Date(Date.now() + 60_000),
        revokedAt: null,
      })
    )

    await expect(
      getReleasePacketForDelegatedRead({ ...delegatedInput(), shareToken })
    ).resolves.toMatchObject({ payload })
  })
})
