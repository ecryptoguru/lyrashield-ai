import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@lyrashield/db", () => ({
  prisma: {
    finding: { findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    evidence: { create: vi.fn() },
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

describe("persistFindings", () => {
  beforeEach(() => vi.clearAllMocks())

  it("persists secret-scanner provenance for score hard caps", async () => {
    vi.mocked(prisma.finding.findMany).mockResolvedValue([])
    vi.mocked(prisma.finding.create).mockResolvedValue({ id: "finding-1" } as never)
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
      data: expect.objectContaining({ category: "Secrets", severity: "CRITICAL", verified: true }),
    })
  })
})
