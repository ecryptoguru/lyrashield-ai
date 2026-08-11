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

import { prisma } from "@lyrashield/db"
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
  })
})
