import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@lyrashield/db", () => ({
  prisma: {
    finding: { findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    evidence: { createMany: vi.fn(), findUnique: vi.fn() },
    findingCandidate: { upsert: vi.fn() },
    findingVerification: { upsert: vi.fn() },
  },
  assertEvidenceEncrypted: vi.fn(),
}))
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
    vi.mocked(prisma.evidence.findUnique).mockResolvedValue(null)
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
      data: expect.objectContaining({ findingId: "finding-1", checksum: "sha256-checksum" }),
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
    vi.mocked(prisma.evidence.findUnique).mockResolvedValue({ id: "evidence-1" } as never)

    await persistFindings({
      scanId: "scan-2",
      workspaceId: "ws-1",
      targetId: "target-1",
      vulnerabilities: [vulnerability],
    })

    expect(uploadEvidence).not.toHaveBeenCalled()
    expect(prisma.evidence.createMany).not.toHaveBeenCalled()
  })
})
