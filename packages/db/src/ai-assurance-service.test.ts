import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("./client", () => {
  const mockPrisma = {
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(mockPrisma)),
    $executeRaw: vi.fn().mockResolvedValue(undefined),
    controlEvidence: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    controlEvidenceVersion: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
  }
  return { prisma: mockPrisma }
})

import { prisma } from "./client"
import {
  createControlEvidence,
  reviseControlEvidence,
  acceptControlEvidence,
  addControlEvidenceArtifacts,
  markControlEvidenceNotApplicable,
  validateControlEvidenceArtifacts,
  listControlEvidence,
  aiAssuranceStateForVersion,
  AI_ASSURANCE_CONTROL_IDS,
} from "./ai-assurance-service"

const mockPrisma = prisma as unknown as {
  $transaction: ReturnType<typeof vi.fn>
  $executeRaw: ReturnType<typeof vi.fn>
  controlEvidence: {
    findFirst: ReturnType<typeof vi.fn>
    findMany: ReturnType<typeof vi.fn>
    create: ReturnType<typeof vi.fn>
    update: ReturnType<typeof vi.fn>
    count: ReturnType<typeof vi.fn>
  }
  controlEvidenceVersion: {
    create: ReturnType<typeof vi.fn>
    findUnique: ReturnType<typeof vi.fn>
    findMany: ReturnType<typeof vi.fn>
    count: ReturnType<typeof vi.fn>
  }
  auditLog: {
    create: ReturnType<typeof vi.fn>
  }
}

describe("ai-assurance-service", () => {
  describe("validateControlEvidenceArtifacts", () => {
    const artifact = {
      id: "artifact-1",
      filename: "proof.pdf",
      mediaType: "application/pdf",
      byteLength: 12,
      storageUri: "s3://private/proof",
      checksum: "sha-1",
      encryptionKeyRef: "key-1",
    }

    it("rejects unsafe names, extension/MIME mismatches, excess files, and oversize manifests", () => {
      expect(() =>
        validateControlEvidenceArtifacts([], [{ ...artifact, filename: "../proof.pdf" }])
      ).toThrow("EVIDENCE_ARTIFACT_FILENAME_INVALID")
      expect(() =>
        validateControlEvidenceArtifacts([], [{ ...artifact, mediaType: "image/png" }])
      ).toThrow("EVIDENCE_ARTIFACT_MEDIA_TYPE_INVALID")
      expect(() =>
        validateControlEvidenceArtifacts(
          [artifact, artifact, artifact, artifact, artifact],
          [artifact]
        )
      ).toThrow("EVIDENCE_ARTIFACT_COUNT_EXCEEDED")
      expect(() =>
        validateControlEvidenceArtifacts([], [{ ...artifact, byteLength: 20 * 1024 * 1024 + 1 }])
      ).toThrow("EVIDENCE_ARTIFACT_SIZE_EXCEEDED")
    })
  })
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe("createControlEvidence", () => {
    it("rejects an unknown control ID", async () => {
      await expect(
        createControlEvidence({
          workspaceId: "ws-1",
          targetId: "target-1",
          controlId: "vibe-99",
          attestation: "audit log present",
          expiresAt: null,
          createdById: "user-1",
        })
      ).rejects.toThrow("Invalid control evidence control ID")
    })

    it("creates a new evidence record and a SUBMITTED version as the first version", async () => {
      mockPrisma.controlEvidence.findFirst.mockResolvedValue(null)
      mockPrisma.controlEvidence.create.mockResolvedValue({
        id: "ce-1",
        workspaceId: "ws-1",
        targetId: "target-1",
        controlId: "vibe-34",
      })
      mockPrisma.controlEvidenceVersion.count.mockResolvedValue(0)
      mockPrisma.controlEvidenceVersion.create.mockResolvedValue({
        id: "v-1",
        controlEvidenceId: "ce-1",
        version: 1,
        status: "SUBMITTED",
        attestation: "audit log present",
        expiresAt: null,
        artifactManifest: [],
        checksum: "sha-1",
        createdById: "user-1",
      })

      const version = await createControlEvidence({
        workspaceId: "ws-1",
        targetId: "target-1",
        controlId: "vibe-34",
        attestation: "audit log present",
        expiresAt: null,
        createdById: "user-1",
      })

      expect(version.status).toBe("SUBMITTED")
      expect(version.version).toBe(1)
      expect(version.id).toBe("v-1")
      expect(mockPrisma.controlEvidence.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            workspaceId: "ws-1",
            targetId: "target-1",
            controlId: "vibe-34",
          }),
        })
      )
      expect(mockPrisma.controlEvidence.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "ce-1" },
          data: { currentVersionId: "v-1" },
        })
      )
    })
  })

  describe("not applicable evidence", () => {
    it("requires a reason and creates an immutable target/control version", async () => {
      await expect(
        markControlEvidenceNotApplicable({
          workspaceId: "ws-1",
          targetId: "target-1",
          controlId: "vibe-34",
          reason: " ",
          createdById: "user-1",
        })
      ).rejects.toThrow("EVIDENCE_NOT_APPLICABLE_REASON_REQUIRED")

      mockPrisma.controlEvidence.findFirst.mockResolvedValue(null)
      mockPrisma.controlEvidence.create.mockResolvedValue({ id: "ce-1" })
      mockPrisma.controlEvidenceVersion.count.mockResolvedValue(0)
      mockPrisma.controlEvidenceVersion.create.mockResolvedValue({
        id: "v-1",
        controlEvidenceId: "ce-1",
        version: 1,
        status: "NOT_APPLICABLE",
        attestation: "No automated deployments for this target",
      })

      const version = await markControlEvidenceNotApplicable({
        workspaceId: "ws-1",
        targetId: "target-1",
        controlId: "vibe-34",
        reason: "No automated deployments for this target",
        createdById: "user-1",
      })

      expect(version.status).toBe("NOT_APPLICABLE")
      expect(mockPrisma.controlEvidenceVersion.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: "NOT_APPLICABLE" }) })
      )
      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: "ai_assurance.evidence.not_applicable" }),
        })
      )
    })
  })

  describe("revision and review", () => {
    it("creates a new immutable version instead of overwriting accepted evidence", async () => {
      const evidenceId = "ce-1"
      const version1 = "v-1"
      const version2 = "v-2"
      const version3 = "v-3"

      mockPrisma.controlEvidence.findFirst
        .mockResolvedValueOnce({
          id: evidenceId,
          workspaceId: "ws-1",
          targetId: "target-1",
          currentVersionId: version1,
        })
        .mockResolvedValueOnce({
          id: evidenceId,
          workspaceId: "ws-1",
          targetId: "target-1",
          currentVersionId: version2,
        })

      mockPrisma.controlEvidenceVersion.findUnique
        .mockResolvedValueOnce({
          id: version1,
          version: 1,
          status: "SUBMITTED",
          attestation: "old",
          expiresAt: null,
          artifactManifest: [],
          createdById: "user-1",
        })
        .mockResolvedValueOnce({
          id: version2,
          version: 2,
          status: "ACCEPTED",
          attestation: "old",
          expiresAt: null,
          artifactManifest: [],
          createdById: "user-1",
        })

      mockPrisma.controlEvidenceVersion.count.mockResolvedValueOnce(1).mockResolvedValueOnce(2)

      mockPrisma.controlEvidenceVersion.create
        .mockResolvedValueOnce({
          id: version2,
          version: 2,
          status: "ACCEPTED",
          attestation: "old",
          createdById: "user-reviewer",
        })
        .mockResolvedValueOnce({
          id: version3,
          version: 3,
          status: "SUBMITTED",
          attestation: "new proof",
          createdById: "user-member",
        })

      const accepted = await acceptControlEvidence({
        workspaceId: "ws-1",
        evidenceId,
        versionId: version1,
        reviewerId: "user-reviewer",
      })

      expect(accepted.status).toBe("ACCEPTED")
      expect(accepted.id).not.toBe(version1)

      const revised = await reviseControlEvidence({
        workspaceId: "ws-1",
        evidenceId,
        attestation: "new proof",
        expiresAt: null,
        createdById: "user-member",
      })

      expect(revised.status).toBe("SUBMITTED")
      expect(revised.id).not.toBe(accepted.id)
      expect(revised.attestation).toBe("new proof")
    })

    it("rejects a review that targets a missing evidence record", async () => {
      mockPrisma.controlEvidence.findFirst.mockResolvedValue(null)

      await expect(
        acceptControlEvidence({
          workspaceId: "ws-1",
          evidenceId: "missing",
          versionId: "v-missing",
          reviewerId: "user-1",
        })
      ).rejects.toThrow("EVIDENCE_NOT_FOUND")
    })

    it("rejects a review when the visible version is no longer current", async () => {
      mockPrisma.controlEvidence.findFirst.mockResolvedValue({
        id: "ce-1",
        workspaceId: "ws-1",
        currentVersionId: "v-2",
      })

      await expect(
        acceptControlEvidence({
          workspaceId: "ws-1",
          evidenceId: "ce-1",
          versionId: "v-1",
          reviewerId: "user-1",
        })
      ).rejects.toThrow("EVIDENCE_VERSION_STALE")
      expect(mockPrisma.controlEvidenceVersion.create).not.toHaveBeenCalled()
    })

    it("clears prior review attribution when artifacts create a submitted version", async () => {
      mockPrisma.controlEvidence.findFirst.mockResolvedValue({
        id: "ce-1",
        workspaceId: "ws-1",
        currentVersionId: "v-1",
      })
      mockPrisma.controlEvidenceVersion.findUnique.mockResolvedValue({
        id: "v-1",
        status: "ACCEPTED",
        attestation: "reviewed proof",
        expiresAt: null,
        artifactManifest: [],
        reviewedById: "reviewer-1",
        reviewedAt: new Date("2026-08-13T00:00:00Z"),
      })
      mockPrisma.controlEvidenceVersion.count.mockResolvedValue(1)
      mockPrisma.controlEvidenceVersion.create.mockResolvedValue({
        id: "v-2",
        controlEvidenceId: "ce-1",
        status: "SUBMITTED",
      })

      await addControlEvidenceArtifacts({
        workspaceId: "ws-1",
        evidenceId: "ce-1",
        createdById: "user-1",
        manifestItems: [
          {
            id: "artifact-1",
            filename: "proof.pdf",
            mediaType: "application/pdf",
            byteLength: 12,
            storageUri: "s3://private/proof",
            checksum: "sha-1",
            encryptionKeyRef: "key-1",
          },
        ],
      })

      expect(mockPrisma.controlEvidenceVersion.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: "SUBMITTED",
            reviewedById: null,
            reviewedAt: null,
          }),
        })
      )
    })
  })

  describe("listControlEvidence", () => {
    it("does not reveal control evidence across workspaces", async () => {
      mockPrisma.controlEvidence.findMany.mockResolvedValue([])

      const result = await listControlEvidence({
        workspaceId: "ws-other",
        targetId: "target-1",
      })

      expect(result).toEqual([])
      expect(mockPrisma.controlEvidence.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            workspaceId: "ws-other",
            targetId: "target-1",
          }),
        })
      )
    })

    it("returns the current version for each evidence row", async () => {
      mockPrisma.controlEvidence.findMany.mockResolvedValue([
        {
          id: "ce-1",
          workspaceId: "ws-1",
          targetId: "target-1",
          controlId: "vibe-34",
          currentVersionId: "v-1",
        },
      ])
      mockPrisma.controlEvidenceVersion.findMany.mockResolvedValue([
        {
          id: "v-1",
          controlEvidenceId: "ce-1",
          version: 1,
          status: "SUBMITTED",
          attestation: "audit log present",
          artifactManifest: [],
        },
      ])

      const result = await listControlEvidence({
        workspaceId: "ws-1",
        targetId: "target-1",
      })

      expect(result).toHaveLength(1)
      expect(result[0]?.id).toBe("ce-1")
      expect(result[0]?.controlId).toBe("vibe-34")
      expect(result[0]?.currentVersion?.id).toBe("v-1")
      expect(mockPrisma.controlEvidenceVersion.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: ["v-1"] } },
        })
      )
    })
  })

  describe("aiAssuranceStateForVersion", () => {
    it("returns NOT_ASSESSED for a null version", () => {
      expect(aiAssuranceStateForVersion(null)).toBe("EVIDENCE_REQUIRED")
    })

    it("returns SUBMITTED for a SUBMITTED version", () => {
      expect(
        aiAssuranceStateForVersion({
          id: "v-1",
          status: "SUBMITTED",
          expiresAt: null,
        } as never)
      ).toBe("EVIDENCE_SUBMITTED")
    })

    it("returns EXPIRED for an ACCEPTED version whose expiresAt has passed", () => {
      expect(
        aiAssuranceStateForVersion({
          id: "v-1",
          status: "ACCEPTED",
          expiresAt: new Date("2020-01-01"),
        } as never)
      ).toBe("EVIDENCE_EXPIRED")
    })

    it("returns ACCEPTED for an ACCEPTED version with no expiry", () => {
      expect(
        aiAssuranceStateForVersion({
          id: "v-1",
          status: "ACCEPTED",
          expiresAt: null,
        } as never)
      ).toBe("EVIDENCE_ACCEPTED")
    })
  })

  it("exposes the seven evidence-required Vibe Security 50 control IDs", () => {
    expect(AI_ASSURANCE_CONTROL_IDS).toEqual([
      "vibe-34",
      "vibe-35",
      "vibe-36",
      "vibe-43",
      "vibe-46",
      "vibe-48",
      "vibe-50",
    ])
  })
})
