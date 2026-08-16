import { beforeEach, describe, expect, it, vi } from "vitest"

const sendNotification = vi.fn()
const checkInvitationCreateRateLimit = vi.fn()

vi.mock("@lyrashield/db", () => ({
  prisma: {
    workspaceMember: { findFirst: vi.fn() },
    invitation: { findFirst: vi.fn(), create: vi.fn() },
    auditLog: { create: vi.fn() },
    workspace: { findUnique: vi.fn() },
  },
}))
vi.mock("@lyrashield/auth/server", () => ({
  getSession: vi.fn().mockResolvedValue(null),
  requirePermission: vi.fn().mockResolvedValue({
    session: { userId: "inviter-1" },
    workspace: { role: "OWNER", member: { workspaceId: "ws-1", role: "OWNER" } },
  }),
}))
vi.mock("@lyrashield/logger", () => ({
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
import { POST } from "./route"

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
    mockPrisma.workspaceMember.findFirst.mockResolvedValue(null)
    mockPrisma.invitation.findFirst.mockResolvedValue(null)
    mockPrisma.invitation.create.mockImplementation(async ({ data }) => ({
      id: "invitation-1",
      ...data,
    }))
    mockPrisma.workspace.findUnique.mockResolvedValue({ name: "Acme Security" })
    checkInvitationCreateRateLimit.mockResolvedValue({ limited: false, remaining: 9, retryAfter: 0 })
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
})
