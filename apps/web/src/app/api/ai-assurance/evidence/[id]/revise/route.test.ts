import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  reviseControlEvidence: vi.fn(),
  findEvidence: vi.fn(),
  toPublicItem: vi.fn(),
}))

vi.mock("@lyrashield/auth/server", () => ({ requirePermission: mocks.requirePermission }))
vi.mock("@lyrashield/auth", () => ({
  PERMISSIONS: { aiAssurance: { manage: "aiAssurance:manage" } },
}))
vi.mock("@lyrashield/db", () => ({
  reviseControlEvidence: mocks.reviseControlEvidence,
  prisma: { controlEvidence: { findFirst: mocks.findEvidence } },
}))
vi.mock("@/lib/ai-assurance", () => ({ toPublicControlEvidenceItem: mocks.toPublicItem }))
vi.mock("@lyrashield/logger", () => ({ setRequestId: vi.fn(), logger: { error: vi.fn() } }))

import { POST } from "./route"

function call() {
  return POST(
    new Request("http://localhost/api/ai-assurance/evidence/evidence-1/revise", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "workspace-1", attestation: "Reviewed evidence" }),
    }),
    { params: Promise.resolve({ id: "evidence-1" }) }
  )
}

describe("POST /api/ai-assurance/evidence/[id]/revise", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requirePermission.mockResolvedValue({ session: { userId: "user-1" } })
    mocks.reviseControlEvidence.mockResolvedValue({ controlEvidenceId: "evidence-1", version: 2 })
    mocks.findEvidence.mockResolvedValue({
      id: "evidence-1",
      workspaceId: "workspace-1",
      targetId: "target-1",
      controlId: "control-1",
    })
    mocks.toPublicItem.mockReturnValue({ id: "evidence-1", state: "CURRENT" })
  })

  it("revises evidence for a member with aiAssurance:manage", async () => {
    expect((await call()).status).toBe(200)
    expect(mocks.requirePermission).toHaveBeenCalledWith("workspace-1", "aiAssurance:manage")
    expect(mocks.reviseControlEvidence).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      evidenceId: "evidence-1",
      attestation: "Reviewed evidence",
      expiresAt: null,
      createdById: "user-1",
    })
    expect(mocks.findEvidence).toHaveBeenCalledWith({
      where: { id: "evidence-1", workspaceId: "workspace-1" },
    })
  })

  it("does not create a revision without aiAssurance:manage", async () => {
    mocks.requirePermission.mockRejectedValue(new Error("FORBIDDEN"))

    expect((await call()).status).toBe(403)
    expect(mocks.reviseControlEvidence).not.toHaveBeenCalled()
    expect(mocks.findEvidence).not.toHaveBeenCalled()
  })
})
