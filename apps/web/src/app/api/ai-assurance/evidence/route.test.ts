import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@lyrashield/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@lyrashield/db")>()
  return {
    ...actual,
    prisma: {
      ...actual.prisma,
      target: {
        findFirst: vi.fn(),
      },
    },
    createControlEvidence: vi.fn(),
    listControlEvidence: vi.fn(),
  }
})

vi.mock("@lyrashield/auth/server", () => ({
  requirePermission: vi.fn().mockResolvedValue({ session: { userId: "user-1" } }),
}))

vi.mock("@lyrashield/auth", () => ({
  PERMISSIONS: { aiAssurance: { view: "aiAssurance:view", manage: "aiAssurance:manage" } },
}))

vi.mock("@lyrashield/logger", () => ({ logger: { error: vi.fn() } }))

import { GET, POST } from "./route"
import { prisma, createControlEvidence, listControlEvidence } from "@lyrashield/db"

const mockPrisma = prisma as unknown as {
  target: { findFirst: ReturnType<typeof vi.fn> }
}

describe("/api/ai-assurance/evidence", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("lists all seven evidence-required controls with EVIDENCE_REQUIRED when none exist", async () => {
    mockPrisma.target.findFirst.mockResolvedValue({ id: "target-1" })
    vi.mocked(listControlEvidence).mockResolvedValue([])

    const response = await GET(
      new Request("http://localhost/api/ai-assurance/evidence?workspaceId=ws-1&targetId=target-1")
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    const body = await response.json()
    expect(body.data).toHaveLength(7)
    expect(body.data.every((item: { state: string }) => item.state === "EVIDENCE_REQUIRED")).toBe(
      true
    )
    expect(JSON.stringify(body)).not.toContain("s3://")
    expect(JSON.stringify(body)).not.toContain("storageUri")
  })

  it("does not expose control evidence across workspaces", async () => {
    mockPrisma.target.findFirst.mockResolvedValue(null)

    const response = await GET(
      new Request(
        "http://localhost/api/ai-assurance/evidence?workspaceId=ws-1&targetId=target-other"
      )
    )

    expect(response.status).toBe(404)
  })

  it("creates control evidence and returns a public version", async () => {
    mockPrisma.target.findFirst.mockResolvedValue({ id: "target-1" })
    vi.mocked(createControlEvidence).mockResolvedValue({
      id: "v-1",
      controlEvidenceId: "ce-1",
      version: 1,
      status: "SUBMITTED",
      attestation: "audit log present",
      expiresAt: null,
      artifactManifest: [],
      checksum: "sha-version",
      createdById: "user-1",
      createdAt: new Date(),
      reviewedById: null,
      reviewedAt: null,
    } as never)

    const response = await POST(
      new Request("http://localhost/api/ai-assurance/evidence", {
        method: "POST",
        body: JSON.stringify({
          workspaceId: "ws-1",
          targetId: "target-1",
          controlId: "vibe-34",
          attestation: "audit log present",
        }),
      })
    )

    expect(response.status).toBe(201)
    const body = await response.json()
    expect(body.data.controlId).toBe("vibe-34")
    expect(body.data.state).toBe("EVIDENCE_SUBMITTED")
    expect(body.data.versionId).toBe("v-1")
    expect(JSON.stringify(body)).not.toContain("s3://")
  })

  it("rejects an unsupported control ID", async () => {
    mockPrisma.target.findFirst.mockResolvedValue({ id: "target-1" })
    vi.mocked(createControlEvidence).mockRejectedValue(
      new Error("Invalid control evidence control ID: vibe-99")
    )

    const response = await POST(
      new Request("http://localhost/api/ai-assurance/evidence", {
        method: "POST",
        body: JSON.stringify({
          workspaceId: "ws-1",
          targetId: "target-1",
          controlId: "vibe-99",
          attestation: "audit log present",
        }),
      })
    )

    expect(response.status).toBe(400)
  })
})
