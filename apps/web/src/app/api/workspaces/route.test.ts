import { beforeEach, describe, expect, it, vi } from "vitest"

const tx = {
  workspace: { create: vi.fn() },
  workspaceMember: { create: vi.fn() },
  policy: { create: vi.fn() },
  user: { findUnique: vi.fn() },
}

vi.mock("@lyrashield/db", () => ({
  prisma: {
    workspace: { findUnique: vi.fn() },
    workspaceMember: { findMany: vi.fn().mockResolvedValue([]) },
    auditLog: { create: vi.fn() },
  },
  withWorkspaceRLS: vi.fn((_workspaceId: string, run: (client: typeof tx) => unknown) => run(tx)),
}))
vi.mock("@lyrashield/auth/server", () => ({
  getSession: vi.fn().mockResolvedValue({ userId: "user-1" }),
}))
vi.mock("@lyrashield/logger", () => ({
  setRequestId: vi.fn(),
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
import { POST, GET } from "./route"
import { getSession } from "@lyrashield/auth/server"

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
  it("creates a workspace for a paid account without granting a trial", async () => {
    vi.mocked(startTrial).mockRejectedValueOnce(new Error("TRIAL_PAID_PLAN"))
    tx.user.findUnique.mockResolvedValueOnce({ trialStartedAt: null })

    const response = await POST(
      new Request("http://localhost/api/workspaces", {
        method: "POST",
        body: JSON.stringify({ name: "Paid account workspace", mode: "VIBE" }),
      })
    )

    expect(response.status).toBe(200)
    expect((await response.json()).data).toMatchObject({
      trialStarted: false,
      trialAlreadyUsed: false,
      trialEndsAt: null,
    })
    expect(tx.user.findUnique).toHaveBeenCalledWith({
      where: { id: "user-1" },
      select: { trialStartedAt: true },
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

  it("retries a workspace slug conflict from the PostgreSQL adapter", async () => {
    tx.workspace.create.mockRejectedValueOnce({
      code: "P2002",
      meta: {
        modelName: "Workspace",
        driverAdapterError: {
          cause: {
            kind: "UniqueConstraintViolation",
            constraint: { fields: ["slug"] },
          },
        },
      },
    })

    const response = await POST(
      new Request("http://localhost/api/workspaces", {
        method: "POST",
        body: JSON.stringify({ name: "First workspace", mode: "VIBE" }),
      })
    )

    expect(response.status).toBe(200)
    expect(tx.workspace.create).toHaveBeenCalledTimes(2)
    const first = tx.workspace.create.mock.calls[0]?.[0].data
    const second = tx.workspace.create.mock.calls[1]?.[0].data
    expect(first?.slug).toBe("first-workspace")
    expect(second?.slug).toMatch(/^first-workspace-[a-f0-9]{6}$/)
    expect(second?.id).not.toBe(first?.id)
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1)
  })

  it("retries a legacy Prisma slug target", async () => {
    tx.workspace.create.mockRejectedValueOnce({
      code: "P2002",
      meta: { modelName: "Workspace", target: ["slug"] },
    })

    const response = await POST(
      new Request("http://localhost/api/workspaces", {
        method: "POST",
        body: JSON.stringify({ name: "First workspace", mode: "VIBE" }),
      })
    )

    expect(response.status).toBe(200)
    expect(tx.workspace.create).toHaveBeenCalledTimes(2)
  })

  it("stops after five slug conflicts and returns a readable conflict", async () => {
    tx.workspace.create.mockRejectedValue({
      code: "P2002",
      meta: { modelName: "Workspace", target: "Workspace_slug_key" },
    })

    const response = await POST(
      new Request("http://localhost/api/workspaces", {
        method: "POST",
        body: JSON.stringify({ name: "First workspace", mode: "VIBE" }),
      })
    )

    expect(response.status).toBe(409)
    expect((await response.json()).error).toMatchObject({
      code: "SLUG_TAKEN",
      message: "Workspace slug already exists",
    })
    expect(tx.workspace.create).toHaveBeenCalledTimes(5)
    expect(prisma.auditLog.create).not.toHaveBeenCalled()
  })

  it("returns an internal error for an unrelated workspace unique conflict", async () => {
    tx.workspace.create.mockRejectedValueOnce({
      code: "P2002",
      meta: { modelName: "Workspace", target: ["name"] },
    })

    const response = await POST(
      new Request("http://localhost/api/workspaces", {
        method: "POST",
        body: JSON.stringify({ name: "First workspace", mode: "VIBE" }),
      })
    )

    expect(response.status).toBe(500)
    expect((await response.json()).error.code).toBe("INTERNAL_ERROR")
    expect(tx.workspace.create).toHaveBeenCalledTimes(1)
    expect(prisma.auditLog.create).not.toHaveBeenCalled()
  })

  it("creates a safe slug for names without ASCII letters or digits", async () => {
    const response = await POST(
      new Request("http://localhost/api/workspaces", {
        method: "POST",
        body: JSON.stringify({ name: "東京", mode: "VIBE" }),
      })
    )

    expect(response.status).toBe(200)
    expect((await response.json()).data.slug).toBe("workspace")
  })
})

describe("workspace-bound bearer discovery", () => {
  it.each(["apiKey", "oauth"])("limits %s discovery to its authorized workspace", async (kind) => {
    vi.mocked(getSession).mockResolvedValueOnce({
      userId: "user-1",
      [kind]: { workspaceId: "ws-bound" },
    } as never)
    expect((await GET()).status).toBe(200)
    expect(prisma.workspaceMember.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: {
          userId: "user-1",
          status: "active",
          workspaceId: "ws-bound",
          workspace: { deletedAt: null },
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      })
    )
  })
  it.each(["apiKey", "oauth"])(
    "does not let %s create a workspace outside its grant",
    async (kind) => {
      vi.mocked(getSession).mockResolvedValueOnce({
        userId: "user-1",
        [kind]: { workspaceId: "ws-bound" },
      } as never)
      const response = await POST(
        new Request("http://localhost/api/workspaces", {
          method: "POST",
          body: JSON.stringify({ name: "New workspace", mode: "VIBE" }),
        })
      )
      expect(response.status).toBe(403)
    }
  )
})
