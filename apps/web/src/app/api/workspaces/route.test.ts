import { beforeEach, describe, expect, it, vi } from "vitest"

const tx = {
  workspace: { create: vi.fn() },
  workspaceMember: { create: vi.fn() },
  policy: { create: vi.fn() },
}

vi.mock("@lyrashield/db", () => ({
  prisma: {
    workspace: { findUnique: vi.fn() },
    auditLog: { create: vi.fn() },
  },
  withWorkspaceRLS: vi.fn((_workspaceId: string, run: (client: typeof tx) => unknown) => run(tx)),
}))
vi.mock("@lyrashield/auth/server", () => ({
  getSession: vi.fn().mockResolvedValue({ userId: "user-1" }),
}))
vi.mock("@lyrashield/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn() },
}))
vi.mock("@lyrashield/billing", () => ({
  startTrial: vi.fn().mockResolvedValue({
    started: true,
    alreadyUsed: false,
    trialEndsAt: new Date("2026-09-17T00:00:00.000Z"),
  }),
}))

import { prisma } from "@lyrashield/db"
import { startTrial } from "@lyrashield/billing"
import { POST } from "./route"

describe("POST /api/workspaces", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prisma.workspace.findUnique).mockResolvedValue(null)
    tx.workspace.create.mockImplementation(async ({ data }) => ({
      ...data,
      mode: data.mode,
      plan: data.plan,
    }))
  })

  it("creates the workspace, owner, and default policy as one nested write", async () => {
    const response = await POST(
      new Request("http://localhost/api/workspaces", {
        method: "POST",
        body: JSON.stringify({ name: "First workspace", mode: "VIBE" }),
      })
    )

    expect(response.status).toBe(200)
    expect(tx.workspace.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: "First workspace",
        members: { create: { userId: "user-1", role: "OWNER", status: "active" } },
        policies: {
          create: expect.objectContaining({ name: "Default Policy" }),
        },
      }),
    })
    expect(tx.workspaceMember.create).not.toHaveBeenCalled()
    expect(tx.policy.create).not.toHaveBeenCalled()
    expect(startTrial).toHaveBeenCalledWith(expect.any(String), "user-1", tx)
  })
  it("creates the workspace without a second trial when already used", async () => {
    vi.mocked(startTrial).mockResolvedValueOnce({
      started: false,
      alreadyUsed: true,
      trialEndsAt: null,
    })
    const response = await POST(
      new Request("http://localhost/api/workspaces", {
        method: "POST",
        body: JSON.stringify({ name: "Another workspace", mode: "VIBE" }),
      })
    )
    expect(response.status).toBe(200)
    expect((await response.json()).data).toMatchObject({
      trialStarted: false,
      trialAlreadyUsed: true,
      trialEndsAt: null,
    })
  })
  it("fails the creation transaction when trial provisioning fails", async () => {
    vi.mocked(startTrial).mockRejectedValueOnce(new Error("grant failed"))
    const response = await POST(
      new Request("http://localhost/api/workspaces", {
        method: "POST",
        body: JSON.stringify({ name: "Retry workspace", mode: "VIBE" }),
      })
    )
    expect(response.status).toBe(500)
    expect(prisma.auditLog.create).not.toHaveBeenCalled()
  })
})
