import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ markControlEvidenceNotApplicable: vi.fn() }))

vi.mock("@lyrashield/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@lyrashield/db")>()
  return {
    ...actual,
    markControlEvidenceNotApplicable: mocks.markControlEvidenceNotApplicable,
    prisma: {
      ...actual.prisma,
      target: { findFirst: vi.fn() },
      controlEvidence: { findFirst: vi.fn() },
    },
  }
})
vi.mock("@lyrashield/auth/server", () => ({
  requirePermission: vi.fn().mockResolvedValue({ session: { userId: "user-1" } }),
}))
vi.mock("@lyrashield/auth", () => ({
  PERMISSIONS: { aiAssurance: { manage: "aiAssurance:manage" } },
}))
vi.mock("@lyrashield/logger", () => ({ logger: { error: vi.fn() } }))

import { markControlEvidenceNotApplicable, prisma } from "@lyrashield/db"
import { POST } from "./route"

const mockPrisma = prisma as unknown as {
  target: { findFirst: ReturnType<typeof vi.fn> }
  controlEvidence: { findFirst: ReturnType<typeof vi.fn> }
}

describe("POST /api/ai-assurance/evidence/not-applicable", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.target.findFirst.mockResolvedValue({ id: "target-1" })
    mockPrisma.controlEvidence.findFirst.mockResolvedValue({
      id: "evidence-1",
      workspaceId: "ws-1",
      targetId: "target-1",
      controlId: "vibe-34",
    })
  })

  it("requires a reason before authorizing a private not-applicable transition", async () => {
    const response = await POST(
      new Request("http://localhost/api/ai-assurance/evidence/not-applicable", {
        method: "POST",
        body: JSON.stringify({
          workspaceId: "ws-1",
          targetId: "target-1",
          controlId: "vibe-34",
          reason: "",
        }),
      })
    )
    expect(response.status).toBe(400)
    expect(markControlEvidenceNotApplicable).not.toHaveBeenCalled()
  })

  it("creates an immutable private not-applicable version", async () => {
    vi.mocked(markControlEvidenceNotApplicable).mockResolvedValue({
      id: "v-1",
      controlEvidenceId: "evidence-1",
      version: 1,
      status: "NOT_APPLICABLE",
      attestation: "No external model endpoint",
      artifactManifest: [],
      createdById: "user-1",
      createdAt: new Date(),
    } as never)
    const response = await POST(
      new Request("http://localhost/api/ai-assurance/evidence/not-applicable", {
        method: "POST",
        body: JSON.stringify({
          workspaceId: "ws-1",
          targetId: "target-1",
          controlId: "vibe-34",
          reason: "No external model endpoint",
        }),
      })
    )
    expect(response.status).toBe(200)
    expect(response.headers.get("Cache-Control")).toBe("private, no-store")
    expect(markControlEvidenceNotApplicable).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "No external model endpoint", createdById: "user-1" })
    )
    expect((await response.json()).data.state).toBe("NOT_APPLICABLE")
  })
})
