import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  addControlEvidenceArtifacts: vi.fn(),
  uploadEncryptedArtifact: vi.fn(),
  deleteEncryptedArtifact: vi.fn(),
}))

vi.mock("@lyrashield/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@lyrashield/db")>()
  return {
    ...actual,
    addControlEvidenceArtifacts: mocks.addControlEvidenceArtifacts,
    prisma: { ...actual.prisma, controlEvidence: { findFirst: vi.fn() } },
  }
})
vi.mock("@lyrashield/evidence-storage", () => ({
  uploadEncryptedArtifact: mocks.uploadEncryptedArtifact,
  deleteEncryptedArtifact: mocks.deleteEncryptedArtifact,
}))
vi.mock("@lyrashield/auth/server", () => ({
  requirePermission: vi.fn().mockResolvedValue({ session: { userId: "user-1" } }),
}))
vi.mock("@lyrashield/auth", () => ({ PERMISSIONS: { aiAssurance: { manage: "aiAssurance:manage" } } }))
vi.mock("@lyrashield/logger", () => ({ logger: { error: vi.fn() } }))

import { prisma } from "@lyrashield/db"
import { POST } from "./route"

const { addControlEvidenceArtifacts, uploadEncryptedArtifact, deleteEncryptedArtifact } = mocks

const mockPrisma = prisma as unknown as { controlEvidence: { findFirst: ReturnType<typeof vi.fn> } }

function uploadRequest(
  content: BodyInit,
  {
    filename = "proof.txt",
    mediaType = "text/plain",
    contentLength,
  }: { filename?: string; mediaType?: string; contentLength?: string } = {}
): Request {
  return new Request("http://localhost/api/ai-assurance/evidence/evidence-1/artifacts?workspaceId=ws-1", {
    method: "POST",
    headers: {
      "content-type": mediaType,
      "x-lyrashield-artifact-filename": encodeURIComponent(filename),
      ...(contentLength ? { "content-length": contentLength } : {}),
    },
    body: content,
    ...(content instanceof ReadableStream ? { duplex: "half" as never } : {}),
  })
}

describe("evidence artifact upload", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.controlEvidence.findFirst.mockResolvedValue({
      id: "evidence-1",
      workspaceId: "ws-1",
      targetId: "target-1",
      controlId: "vibe-34",
    })
  })

  it("rejects a MIME/extension mismatch before any evidence upload", async () => {
    const response = await POST(uploadRequest("not a pdf", { filename: "proof.pdf" }), {
      params: Promise.resolve({ id: "evidence-1" }),
    })
    expect(response.status).toBe(400)
    expect(uploadEncryptedArtifact).not.toHaveBeenCalled()
  })

  it("stores allowed artifacts through encrypted storage and never returns storage metadata", async () => {
    uploadEncryptedArtifact.mockResolvedValue({
      storageUri: "s3://private/proof.pdf",
      checksum: "checksum-1",
      encryptionKeyRef: "vault/key/v1",
      byteLength: 8,
    })
    addControlEvidenceArtifacts.mockResolvedValue({
      id: "version-1",
      controlEvidenceId: "evidence-1",
      version: 2,
      status: "SUBMITTED",
      attestation: "proof",
      artifactManifest: [],
      checksum: "version-checksum",
      createdById: "user-1",
      createdAt: new Date(),
      reviewedById: null,
      reviewedAt: null,
      expiresAt: null,
    })
    const response = await POST(uploadRequest("evidence"), {
      params: Promise.resolve({ id: "evidence-1" }),
    })
    expect(response.status).toBe(201)
    expect(uploadEncryptedArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ content: Buffer.from("evidence"), contentType: "text/plain" })
    )
    const body = JSON.stringify(await response.json())
    expect(body).not.toContain("storageUri")
    expect(body).not.toContain("s3://")
  })

  it("rejects an oversized stream before encrypted storage", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(20 * 1024 * 1024))
        controller.enqueue(new Uint8Array(1))
        controller.close()
      },
    })
    const response = await POST(uploadRequest(stream, { contentLength: "1" }), {
      params: Promise.resolve({ id: "evidence-1" }),
    })

    expect(response.status).toBe(400)
    expect(uploadEncryptedArtifact).not.toHaveBeenCalled()
  })

  it("deletes the stored object if immutable evidence persistence fails", async () => {
    uploadEncryptedArtifact.mockResolvedValue({
      storageUri: "s3://private/proof.txt",
      checksum: "checksum-1",
      encryptionKeyRef: "vault/key/v1",
      byteLength: 8,
    })
    addControlEvidenceArtifacts.mockRejectedValue(new Error("EVIDENCE_ARTIFACT_COUNT_EXCEEDED"))

    const response = await POST(uploadRequest("evidence"), {
      params: Promise.resolve({ id: "evidence-1" }),
    })

    expect(await response.json()).toMatchObject({ error: { code: "EVIDENCE_ARTIFACT_COUNT_EXCEEDED" } })
    expect(response.status).toBe(400)
    expect(deleteEncryptedArtifact).toHaveBeenCalledWith("s3://private/proof.txt", "ws-1")
  })
})
