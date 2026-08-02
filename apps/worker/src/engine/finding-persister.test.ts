import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@lyrashield/db", () => {
  const mockPrisma = {
    finding: { findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    evidence: { createMany: vi.fn(), findMany: vi.fn() },
    findingCandidate: { upsert: vi.fn() },
    findingVerification: { upsert: vi.fn() },
  }
  return {
    prisma: mockPrisma,
    assertEvidenceEncrypted: vi.fn(),
    getWorkspaceContext: vi.fn().mockReturnValue("ws-1"),
    withWorkspaceRLS: vi.fn(async (_workspaceId: string, fn: (tx: unknown) => Promise<unknown>) =>
      fn(mockPrisma)
    ),
  }
})
vi.mock("@lyrashield/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock("./evidence-storage", () => ({
  uploadEvidence: vi.fn(),
  EVIDENCE_KEY_REF: "vault://test",
}))

import { prisma } from "@lyrashield/db"
import { persistFindings } from "./finding-persister"
import type { NormalizedFinding } from "./normalizer"
import { uploadEvidence } from "./evidence-storage"
import { generateDedupeKey } from "./output-parser"

describe("persistFindings", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prisma.evidence.findMany).mockResolvedValue([])
  })

  it("records secret-scanner output as a detection, not verified proof", async () => {
    vi.mocked(prisma.finding.findMany).mockResolvedValue([])
    vi.mocked(prisma.finding.create).mockResolvedValue({ id: "finding-1" } as never)
    vi.mocked(prisma.findingCandidate.upsert).mockResolvedValue({ id: "candidate-1" } as never)
    const secret: NormalizedFinding = {
      id: "secret-1",
      title: "Exposed token",
      severity: "critical",
      timestamp: "2026-07-13T00:00:00Z",
      scannerSource: "secrets",
      normalizedSeverity: "CRITICAL",
      normalizedCwe: "CWE-798",
      normalizedCvss: 9.8,
      confidenceScore: 95,
      falsePositiveRisk: "low",
      dedupeKey: "secret-key",
      enrichment: { cweCategory: "Authentication" },
    }

    await persistFindings({
      scanId: "scan-1",
      workspaceId: "ws-1",
      targetId: "target-1",
      vulnerabilities: [secret],
    })

    expect(prisma.finding.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        category: "Secrets",
        severity: "CRITICAL",
        verified: false,
        verificationStatus: "DETECTED",
        verificationMethod: "SCANNER_DETECTION",
      }),
    })
    expect(prisma.findingVerification.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ status: "DETECTED", method: "SCANNER_DETECTION" }),
      })
    )
  })

  it("backfills evidence on retry/reopen and uses the checksum uniqueness guard", async () => {
    const vulnerability = {
      id: "vuln-1",
      title: "Reflected XSS",
      severity: "high",
      timestamp: "2026-07-14T00:00:00Z",
      cwe: "CWE-79",
      poc_description: "safe proof",
    }
    vi.mocked(prisma.finding.findMany).mockResolvedValue([
      { id: "finding-1", dedupeKey: generateDedupeKey(vulnerability, "target-1"), status: "FIXED" },
    ] as never)
    vi.mocked(prisma.finding.update).mockResolvedValue({ id: "finding-1" } as never)
    vi.mocked(prisma.findingCandidate.upsert).mockResolvedValue({ id: "candidate-1" } as never)
    vi.mocked(uploadEvidence).mockResolvedValue({
      storageUri: "s3://bucket/evidence",
      checksum: "sha256-checksum",
      encryptionKeyRef: "vault://test",
    })

    await persistFindings({
      scanId: "scan-2",
      workspaceId: "ws-1",
      targetId: "target-1",
      vulnerabilities: [vulnerability],
    })

    expect(prisma.finding.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "OPEN", fixedAt: null }) })
    )
    expect(prisma.evidence.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ findingId: "finding-1", checksum: "sha256-checksum" })],
      skipDuplicates: true,
    })
  })

  it("does not re-upload evidence that already exists", async () => {
    const vulnerability = {
      id: "vuln-1",
      title: "Reflected XSS",
      severity: "high",
      timestamp: "2026-07-14T00:00:00Z",
      poc_description: "safe proof",
    }
    vi.mocked(prisma.finding.findMany).mockResolvedValue([
      { id: "finding-1", dedupeKey: generateDedupeKey(vulnerability, "target-1"), status: "OPEN" },
    ] as never)
    vi.mocked(prisma.finding.update).mockResolvedValue({ id: "finding-1" } as never)
    vi.mocked(prisma.findingCandidate.upsert).mockResolvedValue({ id: "candidate-1" } as never)
    // Existence is now resolved with ONE batched findMany per finding: echo back
    // every checksum it asks about, i.e. all artifacts already stored.
    vi.mocked(prisma.evidence.findMany).mockImplementation((async (args: {
      where: { checksum: { in: string[] } }
    }) => args.where.checksum.in.map((checksum) => ({ checksum }))) as never)

    await persistFindings({
      scanId: "scan-2",
      workspaceId: "ws-1",
      targetId: "target-1",
      vulnerabilities: [vulnerability],
    })

    expect(uploadEvidence).not.toHaveBeenCalled()
    expect(prisma.evidence.createMany).not.toHaveBeenCalled()
  })

  it("clears stale optional fields when a finding is re-detected", async () => {
    const vulnerability = {
      id: "vuln-1",
      title: "Updated finding",
      severity: "medium",
      timestamp: "2026-07-14T00:00:00Z",
    }
    vi.mocked(prisma.finding.findMany).mockResolvedValue([
      { id: "finding-1", dedupeKey: generateDedupeKey(vulnerability, "target-1"), status: "OPEN" },
    ] as never)
    vi.mocked(prisma.finding.update).mockResolvedValue({ id: "finding-1" } as never)
    vi.mocked(prisma.findingCandidate.upsert).mockResolvedValue({ id: "candidate-1" } as never)

    await persistFindings({
      scanId: "scan-2",
      workspaceId: "ws-1",
      targetId: "target-1",
      vulnerabilities: [vulnerability],
    })

    expect(prisma.finding.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          cwe: null,
          category: null,
          owaspCategory: null,
          sarifRuleId: null,
          cvssScore: null,
          technicalDetail: null,
          recommendedFix: null,
          businessImpact: null,
          exploitability: null,
        }),
      })
    )
  })

  it("uploads structured claim context through encrypted evidence storage", async () => {
    const vulnerability = {
      id: "vuln-1",
      title: "Dependency finding",
      severity: "high",
      timestamp: "2026-07-14T00:00:00Z",
      evidence: "lockfile proof",
      assumptions: "deployed dependency",
      fix_effort: "low" as const,
      finding_class: "dependency_cve",
      dependency_metadata: { package_name: "example", package_ecosystem: "npm" },
      control_ids: [37],
    }
    vi.mocked(prisma.finding.findMany).mockResolvedValue([])
    vi.mocked(prisma.finding.create).mockResolvedValue({ id: "finding-1" } as never)
    vi.mocked(prisma.findingCandidate.upsert).mockResolvedValue({ id: "candidate-1" } as never)
    vi.mocked(uploadEvidence).mockResolvedValue({
      storageUri: "s3://bucket/evidence",
      checksum: "sha256-checksum",
      encryptionKeyRef: "vault://test",
    })

    await persistFindings({
      scanId: "scan-2",
      workspaceId: "ws-1",
      targetId: "target-1",
      vulnerabilities: [vulnerability],
    })

    expect(uploadEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "claim_context",
        contentType: "application/json; charset=utf-8",
        content: expect.stringContaining("lockfile proof"),
      })
    )
  })

  it("marks engine-only claims without deterministic corroboration as inconclusive", async () => {
    vi.mocked(prisma.finding.findMany).mockResolvedValue([])
    vi.mocked(prisma.finding.create).mockResolvedValue({ id: "finding-1" } as never)
    vi.mocked(prisma.findingCandidate.upsert).mockResolvedValue({ id: "candidate-1" } as never)
    const engineOnly: NormalizedFinding = {
      id: "vuln-1",
      title: "Missing authorization",
      severity: "high",
      timestamp: "2026-07-14T00:00:00Z",
      scannerSource: "engine",
      normalizedSeverity: "HIGH",
      normalizedCwe: "CWE-862",
      normalizedCvss: 7.5,
      confidenceScore: 70,
      falsePositiveRisk: "low",
      dedupeKey: "engine-key",
      enrichment: { cweCategory: "Access Control" },
    }

    await persistFindings({
      scanId: "scan-1",
      workspaceId: "ws-1",
      targetId: "target-1",
      vulnerabilities: [engineOnly],
    })

    expect(prisma.finding.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        verificationStatus: "INCONCLUSIVE",
        verificationMethod: "ENGINE_CLAIM",
        verified: false,
      }),
    })
  })

  it("marks corroborated engine findings as detected", async () => {
    vi.mocked(prisma.finding.findMany).mockResolvedValue([])
    vi.mocked(prisma.finding.create).mockResolvedValue({ id: "finding-1" } as never)
    vi.mocked(prisma.findingCandidate.upsert).mockResolvedValue({ id: "candidate-1" } as never)
    const corroborated: NormalizedFinding = {
      id: "vuln-1",
      title: "Exposed token",
      severity: "critical",
      timestamp: "2026-07-14T00:00:00Z",
      scannerSource: "engine",
      normalizedSeverity: "CRITICAL",
      normalizedCwe: "CWE-798",
      normalizedCvss: 9.8,
      confidenceScore: 95,
      falsePositiveRisk: "low",
      dedupeKey: "secret-key",
      corroboratingSources: ["engine", "secrets"],
      enrichment: { cweCategory: "Authentication" },
    }

    await persistFindings({
      scanId: "scan-1",
      workspaceId: "ws-1",
      targetId: "target-1",
      vulnerabilities: [corroborated],
    })

    expect(prisma.finding.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        verificationStatus: "DETECTED",
        verificationMethod: "SCANNER_DETECTION",
        verified: false,
      }),
    })
  })

  it("persists many findings with bounded concurrency, preserving input order and completeness", async () => {
    vi.mocked(prisma.finding.findMany).mockResolvedValue([])
    // Each create resolves after a jittered delay so out-of-order completion is
    // possible — the ordered-result guarantee must still hold.
    vi.mocked(prisma.finding.create).mockImplementation((async (args: {
      data: { dedupeKey: string }
    }) => {
      await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 15)))
      return { id: `finding-${args.data.dedupeKey}` }
    }) as never)
    vi.mocked(prisma.findingCandidate.upsert).mockResolvedValue({ id: "c" } as never)

    const vulns: NormalizedFinding[] = Array.from({ length: 25 }, (_, i) => ({
      id: `v-${i}`,
      title: `Finding ${i}`,
      severity: "high",
      timestamp: "2026-07-24T00:00:00Z",
      scannerSource: "secrets",
      normalizedSeverity: "HIGH",
      normalizedCwe: "CWE-79",
      normalizedCvss: 7.5,
      confidenceScore: 90,
      falsePositiveRisk: "low",
      dedupeKey: `key-${String(i).padStart(2, "0")}`,
      enrichment: { cweCategory: "XSS" },
    }))

    const results = await persistFindings({
      scanId: "scan-1",
      workspaceId: "ws-1",
      targetId: "target-1",
      vulnerabilities: vulns,
    })

    expect(results).toHaveLength(25)
    // Order preserved despite concurrent, jittered completion.
    expect(results.map((r) => r.dedupeKey)).toEqual(vulns.map((v) => v.dedupeKey))
    expect(results.every((r) => r.isNew)).toBe(true)
    expect(prisma.finding.create).toHaveBeenCalledTimes(25)
  })

  it("waits for all workers and cleanly rethrows the first mid-batch failure", async () => {
    vi.mocked(prisma.finding.findMany).mockResolvedValue([])
    vi.mocked(prisma.finding.create).mockImplementation((async (args: {
      data: { dedupeKey: string }
    }) => {
      await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 10)))
      if (args.data.dedupeKey === "key-01") throw new Error("mid-batch failure")
      return { id: `finding-${args.data.dedupeKey}` }
    }) as never)
    vi.mocked(prisma.findingCandidate.upsert).mockResolvedValue({ id: "candidate-1" } as never)
    vi.mocked(uploadEvidence).mockResolvedValue({
      storageUri: "s3://bucket/evidence",
      checksum: "sha256-checksum",
      encryptionKeyRef: "vault://test",
    })

    const vulns: NormalizedFinding[] = Array.from({ length: 5 }, (_, i) => ({
      id: `v-${i}`,
      title: `Finding ${i}`,
      severity: "high",
      timestamp: "2026-07-24T00:00:00Z",
      scannerSource: "secrets",
      normalizedSeverity: "HIGH",
      normalizedCwe: "CWE-79",
      normalizedCvss: 7.5,
      confidenceScore: 90,
      falsePositiveRisk: "low",
      dedupeKey: `key-${String(i).padStart(2, "0")}`,
      enrichment: { cweCategory: "XSS" },
    }))

    await expect(
      persistFindings({
        scanId: "scan-1",
        workspaceId: "ws-1",
        targetId: "target-1",
        vulnerabilities: vulns,
      })
    ).rejects.toThrow("mid-batch failure")

    // All workers drain; the returned promise never resolves with partial/undefined entries.
    expect(prisma.finding.create).toHaveBeenCalledTimes(5)
  })
})
