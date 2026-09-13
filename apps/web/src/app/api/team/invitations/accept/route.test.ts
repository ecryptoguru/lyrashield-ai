import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@lyrashield/auth/server", () => ({
  getSession: vi.fn(),
  assertBrowserSession: (session: { apiKey?: unknown; oauth?: unknown }) => {
    if (session.apiKey || session.oauth) throw new Error("FORBIDDEN")
  },
}))

vi.mock("@lyrashield/logger", () => ({
  setRequestId: vi.fn(),
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))

const systemPrismaMocks = {
  $transaction: vi.fn(),
  $executeRaw: vi.fn(),
  invitation: {
    findUnique: vi.fn(),
    updateMany: vi.fn(),
  },
  workspaceMember: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    count: vi.fn(),
    upsert: vi.fn(),
  },
  workspace: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
  user: { findUnique: vi.fn() },
}

vi.mock("@lyrashield/billing", () => ({
  resolveAccountBilling: vi.fn().mockResolvedValue({ effectivePlan: "LAUNCH_ASSURANCE" }),
}))

vi.mock("@lyrashield/db", () => ({
  lockWorkspaceMembership: vi.fn(),
  getSystemPrisma: () => systemPrismaMocks,
  prisma: {
    auditLog: { create: vi.fn() },
  },
}))

import { GET, POST } from "./route"
import { getSession } from "@lyrashield/auth/server"
import { resolveAccountBilling } from "@lyrashield/billing"

const mockGetSession = vi.mocked(getSession)

function invitationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "invite-1",
    workspaceId: "ws-1",
    invitedById: "owner-1",
    email: "member@example.com",
    role: "MEMBER",
    status: "pending",
    expiresAt: new Date(Date.now() + 86_400_000),
    workspace: { name: "Acme Workspace" },
    ...overrides,
  }
}

const SESSION = {
  userId: "user-1",
  userEmail: "member@example.com",
  userName: "Member One",
}

function jsonResponse(body: unknown, status = 200) {
  return { status, body }
}

describe("POST /api/team/invitations/accept", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetSession.mockResolvedValue(SESSION as never)
    systemPrismaMocks.$transaction.mockImplementation((callback) => callback(systemPrismaMocks))
    systemPrismaMocks.invitation.updateMany.mockResolvedValue({ count: 1 } as never)
    systemPrismaMocks.workspaceMember.findUnique.mockResolvedValue(null as never)
    systemPrismaMocks.workspaceMember.findFirst.mockResolvedValue({ id: "owner-1" } as never)
    systemPrismaMocks.workspaceMember.count.mockResolvedValue(1 as never)
    systemPrismaMocks.workspace.findUnique.mockResolvedValue({
      agencySponsorAccountId: null,
    } as never)
    systemPrismaMocks.workspace.findFirst.mockResolvedValue(null as never)
    systemPrismaMocks.workspaceMember.upsert.mockResolvedValue({ id: "member-1" } as never)
    systemPrismaMocks.user.findUnique.mockResolvedValue({
      email: "member@example.com",
      emailVerified: true,
    } as never)
  })

  it("accepts a pending invitation for the matching account", async () => {
    systemPrismaMocks.invitation.findUnique.mockResolvedValue(invitationRow() as never)

    const response = await POST(
      new Request("http://localhost/api/team/invitations/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "tok-1" }),
      })
    )
    const parsed = jsonResponse(await response.json(), response.status)

    expect(parsed.status).toBe(200)
    expect(systemPrismaMocks.invitation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "invite-1", status: "pending" }),
        data: expect.objectContaining({ status: "ACCEPTED" }),
      })
    )
    expect(systemPrismaMocks.workspaceMember.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          workspaceId: "ws-1",
          userId: "user-1",
          status: "active",
          invitedEmail: "member@example.com",
        }),
      })
    )
  })

  it("requires authentication", async () => {
    mockGetSession.mockResolvedValue(null as never)

    const response = await POST(
      new Request("http://localhost/api/team/invitations/accept", {
        method: "POST",
        body: JSON.stringify({ token: "tok-1" }),
      })
    )

    expect(response.status).toBe(401)
  })

  it.each([
    { apiKey: { keyId: "k-1", workspaceId: "ws-1", scopes: ["read", "write"], prefix: "lsk_x" } },
    { oauth: { userId: "user-1", workspaceId: "ws-1", scopes: ["lyrashield.write"] } },
  ])(
    "rejects workspace-bound credentials — invitation acceptance is browser-owned",
    async (credential) => {
      mockGetSession.mockResolvedValue({ ...SESSION, ...credential } as never)

      const response = await POST(
        new Request("http://localhost/api/team/invitations/accept", {
          method: "POST",
          body: JSON.stringify({ token: "tok-1" }),
        })
      )

      expect(response.status).toBe(403)
      expect(systemPrismaMocks.invitation.findUnique).not.toHaveBeenCalled()
      expect(systemPrismaMocks.workspaceMember.upsert).not.toHaveBeenCalled()
    }
  )

  it("consumes an old invitation without overwriting an active member role", async () => {
    systemPrismaMocks.invitation.findUnique.mockResolvedValue(invitationRow() as never)
    systemPrismaMocks.workspaceMember.findUnique.mockResolvedValue({ status: "active" } as never)
    const response = await POST(
      new Request("http://localhost/api/team/invitations/accept", {
        method: "POST",
        body: JSON.stringify({ token: "tok-1" }),
      })
    )
    expect(response.status).toBe(200)
    expect(systemPrismaMocks.workspaceMember.upsert).not.toHaveBeenCalled()
    expect((await response.json()).data.alreadyMember).toBe(true)
  })

  it("404s for an unknown or already-consumed invitation", async () => {
    systemPrismaMocks.invitation.findUnique.mockResolvedValue(
      invitationRow({ status: "ACCEPTED" }) as never
    )

    const response = await POST(
      new Request("http://localhost/api/team/invitations/accept", {
        method: "POST",
        body: JSON.stringify({ token: "tok-1" }),
      })
    )

    expect(response.status).toBe(404)
    expect(systemPrismaMocks.workspaceMember.upsert).not.toHaveBeenCalled()
  })

  it("410s for an expired invitation", async () => {
    systemPrismaMocks.invitation.findUnique.mockResolvedValue(
      invitationRow({ expiresAt: new Date(Date.now() - 1000) }) as never
    )

    const response = await POST(
      new Request("http://localhost/api/team/invitations/accept", {
        method: "POST",
        body: JSON.stringify({ token: "tok-1" }),
      })
    )

    expect(response.status).toBe(410)
  })

  it("403s when the signed-in email does not match the invitation", async () => {
    systemPrismaMocks.invitation.findUnique.mockResolvedValue(
      invitationRow({ email: "other@example.com" }) as never
    )

    const response = await POST(
      new Request("http://localhost/api/team/invitations/accept", {
        method: "POST",
        body: JSON.stringify({ token: "tok-1" }),
      })
    )
    const parsed = jsonResponse(await response.json(), response.status)

    expect(parsed.status).toBe(403)
    expect(systemPrismaMocks.invitation.updateMany).not.toHaveBeenCalled()
  })

  it("rejects unverified email even when a copied invite link matches", async () => {
    systemPrismaMocks.invitation.findUnique.mockResolvedValue(invitationRow() as never)
    systemPrismaMocks.user.findUnique.mockResolvedValue({
      email: "member@example.com",
      emailVerified: false,
    } as never)

    const response = await POST(
      new Request("http://localhost/api/team/invitations/accept", {
        method: "POST",
        body: JSON.stringify({ token: "tok-1" }),
      })
    )

    expect(response.status).toBe(403)
    expect((await response.json()).error.code).toBe("INVITATION_EMAIL_UNVERIFIED")
    expect(systemPrismaMocks.invitation.updateMany).not.toHaveBeenCalled()
    expect(systemPrismaMocks.workspaceMember.upsert).not.toHaveBeenCalled()
  })

  it("uses the current database email instead of a stale session email", async () => {
    systemPrismaMocks.invitation.findUnique.mockResolvedValue(invitationRow() as never)
    systemPrismaMocks.user.findUnique.mockResolvedValue({
      email: "changed@example.com",
      emailVerified: true,
    } as never)

    const response = await POST(
      new Request("http://localhost/api/team/invitations/accept", {
        method: "POST",
        body: JSON.stringify({ token: "tok-1" }),
      })
    )

    expect(response.status).toBe(403)
    expect((await response.json()).error.code).toBe("INVITATION_EMAIL_MISMATCH")
    expect(systemPrismaMocks.workspaceMember.upsert).not.toHaveBeenCalled()
  })

  it("re-activates an existing membership instead of duplicating it", async () => {
    systemPrismaMocks.invitation.findUnique.mockResolvedValue(invitationRow() as never)
    systemPrismaMocks.workspaceMember.findUnique.mockResolvedValue({
      id: "member-existing",
      status: "removed",
    } as never)

    const response = await POST(
      new Request("http://localhost/api/team/invitations/accept", {
        method: "POST",
        body: JSON.stringify({ token: "tok-1" }),
      })
    )

    expect(response.status).toBe(200)
    expect(systemPrismaMocks.workspaceMember.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          workspaceId_userId: { workspaceId: "ws-1", userId: "user-1" },
        },
        update: expect.objectContaining({ status: "active", role: "MEMBER" }),
      })
    )
  })

  it("does not grant membership when the invitation consume loses a race", async () => {
    systemPrismaMocks.invitation.findUnique.mockResolvedValue(invitationRow() as never)
    systemPrismaMocks.invitation.updateMany.mockResolvedValue({ count: 0 } as never)
    systemPrismaMocks.workspaceMember.findUnique.mockResolvedValue(null as never)

    const response = await POST(
      new Request("http://localhost/api/team/invitations/accept", {
        method: "POST",
        body: JSON.stringify({ token: "tok-1" }),
      })
    )

    expect(response.status).toBe(409)
    expect(systemPrismaMocks.workspaceMember.upsert).not.toHaveBeenCalled()
  })

  it("rejects an old invitation after the Agency buyer downgrades", async () => {
    systemPrismaMocks.invitation.findUnique.mockResolvedValue(invitationRow() as never)
    vi.mocked(resolveAccountBilling).mockResolvedValueOnce({ effectivePlan: "PRO" } as never)
    const response = await POST(
      new Request("http://localhost/api/team/invitations/accept", {
        method: "POST",
        body: JSON.stringify({ token: "tok-1" }),
      })
    )
    expect(response.status).toBe(403)
    expect(systemPrismaMocks.invitation.updateMany).not.toHaveBeenCalled()
    expect(systemPrismaMocks.workspaceMember.upsert).not.toHaveBeenCalled()
  })

  it("rejects an old invitation when all five seats have become occupied", async () => {
    systemPrismaMocks.invitation.findUnique.mockResolvedValue(invitationRow() as never)
    systemPrismaMocks.workspaceMember.count.mockResolvedValue(5 as never)
    const response = await POST(
      new Request("http://localhost/api/team/invitations/accept", {
        method: "POST",
        body: JSON.stringify({ token: "tok-1" }),
      })
    )
    expect(response.status).toBe(409)
    expect(systemPrismaMocks.invitation.updateMany).not.toHaveBeenCalled()
    expect(systemPrismaMocks.workspaceMember.upsert).not.toHaveBeenCalled()
  })

  it("rejects an old invitation if the buyer already sponsors another Agency workspace", async () => {
    systemPrismaMocks.invitation.findUnique.mockResolvedValue(invitationRow() as never)
    systemPrismaMocks.workspace.findFirst.mockResolvedValue({ id: "other-ws" } as never)
    const response = await POST(
      new Request("http://localhost/api/team/invitations/accept", {
        method: "POST",
        body: JSON.stringify({ token: "tok-1" }),
      })
    )
    expect(response.status).toBe(409)
    expect((await response.json()).error.code).toBe("AGENCY_TEAM_EXISTS")
    expect(systemPrismaMocks.workspaceMember.upsert).not.toHaveBeenCalled()
  })
})

describe("GET /api/team/invitations/accept", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns invitation metadata for the pre-auth banner", async () => {
    systemPrismaMocks.invitation.findUnique.mockResolvedValue(invitationRow() as never)

    const response = await GET(
      new Request("http://localhost/api/team/invitations/accept?token=tok-1")
    )
    const parsed = jsonResponse(await response.json(), response.status)

    expect(parsed.status).toBe(200)
    expect(parsed.body.data.workspaceName).toBe("Acme Workspace")
  })

  it("404s for an unknown token without leaking existence details", async () => {
    systemPrismaMocks.invitation.findUnique.mockResolvedValue(null as never)

    const response = await GET(
      new Request("http://localhost/api/team/invitations/accept?token=nope")
    )

    expect(response.status).toBe(404)
  })

  it("400s without a token", async () => {
    const response = await GET(new Request("http://localhost/api/team/invitations/accept"))

    expect(response.status).toBe(400)
  })
})
