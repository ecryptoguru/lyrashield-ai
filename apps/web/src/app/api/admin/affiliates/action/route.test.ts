import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@lyrashield/db", () => ({
  prisma: {
    affiliate: { findUnique: vi.fn(), update: vi.fn(), findMany: vi.fn() },
    affiliateLink: { findFirst: vi.fn(), create: vi.fn() },
    payout: { findUnique: vi.fn() },
    payoutItem: { findMany: vi.fn() },
    commission: { findMany: vi.fn(), updateMany: vi.fn() },
    auditLog: { create: vi.fn() },
  },
}))
const isPlatformOperatorMock = vi.fn()
vi.mock("@lyrashield/auth/server", () => ({
  isPlatformOperator: (...args: unknown[]) => isPlatformOperatorMock(...args),
}))
const getCachedSessionMock = vi.fn()
const getCachedWorkspaceIdMock = vi.fn()
vi.mock("@/lib/cache", () => ({
  getCachedSession: () => getCachedSessionMock(),
  getCachedWorkspaceId: (...args: unknown[]) => getCachedWorkspaceIdMock(...args),
}))
vi.mock("@lyrashield/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock("@lyrashield/affiliate", () => ({
  setupReserve: vi.fn().mockResolvedValue(undefined),
}))

import { prisma } from "@lyrashield/db"
import { POST } from "./route"

const mockPrisma = prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>

const ALL_TENANT_ROLES = [
  "OWNER",
  "ADMIN",
  "SECURITY_ADMIN",
  "APPSEC_MANAGER",
  "BILLING_ADMIN",
  "DEVELOPER",
  "MEMBER",
  "EXTERNAL_PENTESTER",
  "AUDITOR",
  "VIEWER",
] as const

function actionRequest(action: Record<string, unknown>) {
  return new Request("http://localhost/api/admin/affiliates/action", {
    method: "POST",
    body: JSON.stringify(action),
  })
}

function stubSession(userId = "user-1") {
  getCachedSessionMock.mockResolvedValue({
    userId,
    userEmail: `${userId}@example.com`,
    userName: userId,
    userImage: null,
    sessionId: `sess-${userId}`,
  })
}

describe("POST /api/admin/affiliates/action (platform-operator gate)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    stubSession()
    getCachedWorkspaceIdMock.mockResolvedValue("ws-1")
    mockPrisma.affiliate.findUnique.mockResolvedValue({
      acceptedTermsAt: new Date(),
      termsVersion: "v1",
    })
    mockPrisma.affiliate.update.mockImplementation(async ({ data }) => ({
      id: "aff-1",
      promoCode: "LYRA-EXISTING",
      ...data,
    }))
    mockPrisma.affiliateLink.findFirst.mockResolvedValue({ id: "link-1" })
    mockPrisma.auditLog.create.mockResolvedValue({})
  })

  it("rejects every tenant role with 403 and writes a denial audit row", async () => {
    for (const role of ALL_TENANT_ROLES) {
      vi.clearAllMocks()
      stubSession()
      getCachedWorkspaceIdMock.mockResolvedValue(`ws-${role}`)
      isPlatformOperatorMock.mockResolvedValue(false)

      const response = await POST(actionRequest({ action: "approve", affiliateId: "aff-1" }))

      expect(response.status, `${role} must not administer affiliates`).toBe(403)
      expect(mockPrisma.affiliate.update).not.toHaveBeenCalled()
      expect(mockPrisma.auditLog.create).toHaveBeenCalledTimes(1)
      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          workspaceId: `ws-${role}`,
          action: "affiliate.admin_denied",
          resourceType: "affiliate_admin_action",
        }),
      })
    }
  })

  it("lets a platform operator approve and audits the success", async () => {
    isPlatformOperatorMock.mockResolvedValue(true)

    const response = await POST(actionRequest({ action: "approve", affiliateId: "aff-1" }))

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.success).toBe(true)
    expect(mockPrisma.affiliate.update).toHaveBeenCalled()
    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "ws-1",
        action: "affiliate.approved",
        resourceType: "affiliate",
        resourceId: "aff-1",
      }),
    })
  })

  it("outcome does not change with the operator's workspaceId (or lack of one)", async () => {
    for (const workspaceId of ["ws-a", "ws-other-tenant", null]) {
      vi.clearAllMocks()
      stubSession()
      getCachedWorkspaceIdMock.mockResolvedValue(workspaceId)
      isPlatformOperatorMock.mockResolvedValue(true)

      const response = await POST(actionRequest({ action: "reject", affiliateId: "aff-1" }))

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.success).toBe(true)
      expect(mockPrisma.affiliate.update).toHaveBeenCalledWith({
        where: { id: "aff-1" },
        data: { status: "REJECTED" },
      })
    }
  })

  it("skips audit rows when the actor has no workspace (FK has no target)", async () => {
    isPlatformOperatorMock.mockResolvedValue(false)
    getCachedWorkspaceIdMock.mockRejectedValue(new Error("no workspace"))

    const response = await POST(
      actionRequest({ action: "tierOverride", affiliateId: "aff-1", baseRateBps: 1000 })
    )

    expect(response.status).toBe(403)
    expect(mockPrisma.auditLog.create).not.toHaveBeenCalled()
    expect(mockPrisma.affiliate.update).not.toHaveBeenCalled()
  })

  it("returns 401 without a session before any authorization work", async () => {
    getCachedSessionMock.mockResolvedValue(null)

    const response = await POST(actionRequest({ action: "reject", affiliateId: "aff-1" }))

    expect(response.status).toBe(401)
    expect(isPlatformOperatorMock).not.toHaveBeenCalled()
    expect(mockPrisma.auditLog.create).not.toHaveBeenCalled()
  })
})
