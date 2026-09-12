import { beforeEach, describe, expect, it, vi } from "vitest"

const sendNotification = vi.fn()
const checkInvitationCreateRateLimit = vi.fn()
const { otherAgencyWorkspace } = vi.hoisted(() => ({ otherAgencyWorkspace: vi.fn() }))

vi.mock("@lyrashield/db", () => {
  const prisma = {
    workspaceMember: { findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn() },
    invitation: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), count: vi.fn() },
    auditLog: { create: vi.fn() },
    user: { findMany: vi.fn() },
    workspace: { findUnique: vi.fn(), update: vi.fn() },
    $executeRaw: vi.fn(),
  }
  return {
    prisma,
    withWorkspaceRLS: vi.fn(async (_workspaceId: string, fn: (tx: typeof prisma) => unknown) =>
      fn(prisma)
    ),
    lockWorkspaceMembership: vi.fn(),
    getSystemPrisma: () => ({
      workspace: { findFirst: otherAgencyWorkspace },
    }),
  }
})

vi.mock("@lyrashield/billing", () => ({
  resolveAccountBilling: vi.fn().mockResolvedValue({ effectivePlan: "LAUNCH_ASSURANCE" }),
}))
const requireWorkspaceAccess = vi.fn()
vi.mock("@lyrashield/auth/server", () => ({
  getSession: vi.fn().mockResolvedValue(null),
  requireWorkspaceAccess: (...args: unknown[]) => requireWorkspaceAccess(...args),
  requirePermission: vi.fn().mockResolvedValue({
    session: { userId: "inviter-1" },
    workspace: { role: "OWNER", member: { workspaceId: "ws-1", role: "OWNER" } },
  }),
}))
vi.mock("@lyrashield/logger", () => ({
  setRequestId: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock("@lyrashield/config", () => ({
  env: { NEXT_PUBLIC_APP_URL: "https://app.example.com" },
}))
vi.mock("@lyrashield/integrations", () => ({
  sendNotification: (...args: unknown[]) => sendNotification(...args),
}))
vi.mock("../../../lib/rate-limit", () => ({
  checkInvitationCreateRateLimit: (...args: unknown[]) => checkInvitationCreateRateLimit(...args),
}))

import { prisma } from "@lyrashield/db"
import { resolveAccountBilling } from "@lyrashield/billing"
import { GET, POST } from "./route"

const mockPrisma = prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>

function inviteRequest() {
  return new Request("http://localhost/api/team", {
    method: "POST",
    body: JSON.stringify({ workspaceId: "ws-1", email: "teammate@example.com", role: "MEMBER" }),
  })
}

describe("POST /api/team", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.workspaceMember.findFirst.mockImplementation(async ({ where }) =>
      where.role === "OWNER" ? { id: "owner-1" } : null
    )
    mockPrisma.workspaceMember.count.mockResolvedValue(1)
    mockPrisma.invitation.findFirst.mockResolvedValue(null)
    mockPrisma.invitation.count.mockResolvedValue(0)
    mockPrisma.invitation.create.mockImplementation(async ({ data }) => ({
      id: "invitation-1",
      ...data,
    }))
    mockPrisma.workspace.findUnique.mockResolvedValue({
      name: "Acme Security",
      agencySponsorAccountId: null,
    })
    otherAgencyWorkspace.mockResolvedValue(null)
    checkInvitationCreateRateLimit.mockResolvedValue({
      limited: false,
      remaining: 9,
      retryAfter: 0,
    })
  })

  it("sends the invitation email with an accept URL built from the invitation token", async () => {
    sendNotification.mockResolvedValue(true)

    const response = await POST(inviteRequest())

    expect(response.status).toBe(200)
    const body = await response.json()
    const createdToken = mockPrisma.invitation.create.mock.calls[0]![0].data.token
    const expectedUrl = `https://app.example.com/sign-up?invite=${createdToken}`

    expect(sendNotification).toHaveBeenCalledTimes(1)
    expect(sendNotification).toHaveBeenCalledWith(
      "email",
      expect.objectContaining({
        type: "team.invitation",
        workspaceName: "Acme Security",
        body: expect.stringContaining(expectedUrl),
      }),
      ["teammate@example.com"]
    )
    expect(body.data.inviteUrl).toBe(expectedUrl)
    expect(body.data.emailSent).toBe(true)
  })

  it("still creates the invitation and returns the accept URL when the email send fails", async () => {
    sendNotification.mockRejectedValue(new Error("Brevo down"))

    const response = await POST(inviteRequest())

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(mockPrisma.invitation.create).toHaveBeenCalledTimes(1)
    expect(body.data.emailSent).toBe(false)
    expect(body.data.inviteUrl).toMatch(/^https:\/\/app\.example\.com\/sign-up\?invite=/)
  })

  it("reports an unconfigured email channel without failing the invitation", async () => {
    sendNotification.mockResolvedValue(false)

    const response = await POST(inviteRequest())

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.data.emailSent).toBe(false)
    expect(body.data.inviteUrl).toBeDefined()
  })

  it("returns 429 with Retry-After when the invitation rate limit is exceeded", async () => {
    checkInvitationCreateRateLimit.mockResolvedValue({
      limited: true,
      remaining: 0,
      retryAfter: 42,
    })

    const response = await POST(inviteRequest())

    expect(response.status).toBe(429)
    expect(response.headers.get("Retry-After")).toBe("42")
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: { code: "INVITE_RATE_LIMITED" },
    })
    expect(checkInvitationCreateRateLimit).toHaveBeenCalledWith("ws-1")
    expect(mockPrisma.invitation.create).not.toHaveBeenCalled()
    expect(sendNotification).not.toHaveBeenCalled()
  })

  it("keeps Starter and Pro workspaces single-member", async () => {
    for (const plan of ["STARTER", "PRO"]) {
      vi.mocked(resolveAccountBilling).mockResolvedValueOnce({ effectivePlan: plan } as never)
      const response = await POST(inviteRequest())
      expect(response.status).toBe(403)
      expect((await response.json()).error.code).toBe("AGENCY_PLAN_REQUIRED")
    }
    expect(mockPrisma.invitation.create).not.toHaveBeenCalled()
    expect(sendNotification).not.toHaveBeenCalled()
  })

  it("reserves all five Agency seats across active members and pending invites", async () => {
    mockPrisma.workspaceMember.count.mockResolvedValue(4)
    mockPrisma.invitation.count.mockResolvedValue(1)
    const response = await POST(inviteRequest())
    expect(response.status).toBe(409)
    expect((await response.json()).error.code).toBe("TEAM_SEAT_LIMIT")
    expect(mockPrisma.invitation.create).not.toHaveBeenCalled()
  })

  it("allows the buyer to sponsor only one Agency workspace", async () => {
    otherAgencyWorkspace.mockResolvedValue({ id: "other-ws" })
    const response = await POST(inviteRequest())
    expect(response.status).toBe(409)
    expect((await response.json()).error.code).toBe("AGENCY_TEAM_EXISTS")
    expect(mockPrisma.invitation.create).not.toHaveBeenCalled()
  })
})

describe("GET /api/team", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireWorkspaceAccess.mockResolvedValue({
      session: { userId: "user-1" },
      workspace: { role: "MEMBER", member: { workspaceId: "ws-1" } },
    })
    mockPrisma.workspaceMember.findMany.mockResolvedValue([])
    mockPrisma.invitation.findMany.mockResolvedValue([])
    mockPrisma.user.findMany.mockResolvedValue([])
  })

  it("routes authorization through requireWorkspaceAccess and lists members", async () => {
    const response = await GET(new Request("http://localhost/api/team?workspaceId=ws-1"))

    expect(requireWorkspaceAccess).toHaveBeenCalledWith("ws-1")
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: { members: [], invitations: [] },
    })
  })

  it("returns 403 for a credential bound to another workspace", async () => {
    requireWorkspaceAccess.mockRejectedValue(new Error("FORBIDDEN"))

    const response = await GET(new Request("http://localhost/api/team?workspaceId=ws-2"))

    expect(response.status).toBe(403)
    expect(mockPrisma.workspaceMember.findMany).not.toHaveBeenCalled()
  })

  it("returns 401 when unauthenticated", async () => {
    requireWorkspaceAccess.mockRejectedValue(new Error("UNAUTHORIZED"))

    const response = await GET(new Request("http://localhost/api/team?workspaceId=ws-1"))

    expect(response.status).toBe(401)
  })
})
