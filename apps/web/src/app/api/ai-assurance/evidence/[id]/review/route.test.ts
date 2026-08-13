import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@lyrashield/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@lyrashield/db")>()
  return {
    ...actual,
    prisma: {
      ...actual.prisma,
      controlEvidence: {
        findFirst: vi.fn(),
      },
    },
    reviewControlEvidence: vi.fn(),
  }
})

vi.mock("@lyrashield/auth/server", () => ({
  requirePermission: vi.fn().mockResolvedValue({ session: { userId: "user-1" } }),
}))

vi.mock("@lyrashield/auth", () => ({
  PERMISSIONS: { aiAssurance: { review: "aiAssurance:review" } },
}))

vi.mock("@lyrashield/logger", () => ({ logger: { error: vi.fn() } }))

import { POST } from "./route"
import { reviewControlEvidence, prisma } from "@lyrashield/db"

const mockPrisma = prisma as unknown as {
  controlEvidence: { findFirst: ReturnType<typeof vi.fn> }
}

describe("POST /api/ai-assurance/evidence/[id]/review", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.controlEvidence.findFirst.mockResolvedValue({
      id: "ev-1",
      workspaceId: "ws-1",
      targetId: "target-1",
      controlId: "vibe-34",
    })
  })

  it("accepts a submitted version and returns a public item", async () => {
    vi.mocked(reviewControlEvidence).mockResolvedValue({
      id: "v-2",
      controlEvidenceId: "ev-1",
      version: 2,
      status: "ACCEPTED",
      attestation: "audit log present",
      artifactManifest: [],
      createdById: "user-1",
      createdAt: new Date(),
    } as never)

    const response = await POST(
      new Request("http://localhost/api/ai-assurance/evidence/ev-1/review?workspaceId=ws-1", {
        method: "POST",
        body: JSON.stringify({ workspaceId: "ws-1", versionId: "v-1", status: "ACCEPTED" }),
      }),
      { params: Promise.resolve({ id: "ev-1" }) }
    )

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.data.state).toBe("EVIDENCE_ACCEPTED")
    expect(reviewControlEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ versionId: "v-1" })
    )
    expect(JSON.stringify(body)).not.toContain("s3://")
  })

  it("returns 409 when the evidence version is not reviewable", async () => {
    vi.mocked(reviewControlEvidence).mockRejectedValue(new Error("EVIDENCE_VERSION_NOT_REVIEWABLE"))

    const response = await POST(
      new Request("http://localhost/api/ai-assurance/evidence/ev-1/review?workspaceId=ws-1", {
        method: "POST",
        body: JSON.stringify({ workspaceId: "ws-1", versionId: "v-1", status: "ACCEPTED" }),
      }),
      { params: Promise.resolve({ id: "ev-1" }) }
    )

    expect(response.status).toBe(409)
  })

  it("returns 409 when the reviewed version has gone stale", async () => {
    vi.mocked(reviewControlEvidence).mockRejectedValue(new Error("EVIDENCE_VERSION_STALE"))

    const response = await POST(
      new Request("http://localhost/api/ai-assurance/evidence/ev-1/review", {
        method: "POST",
        body: JSON.stringify({ workspaceId: "ws-1", versionId: "v-1", status: "ACCEPTED" }),
      }),
      { params: Promise.resolve({ id: "ev-1" }) }
    )

    expect(response.status).toBe(409)
  })
})
