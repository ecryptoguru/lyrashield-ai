import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@lyrashield/db", () => ({
  prisma: {
    affiliate: { findUnique: vi.fn(), update: vi.fn() },
  },
}))

const getCachedSessionMock = vi.fn()
vi.mock("@/lib/cache", () => ({ getCachedSession: () => getCachedSessionMock() }))

import { prisma } from "@lyrashield/db"
import { POST } from "./route"

const affiliate = prisma.affiliate as unknown as {
  findUnique: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
}

function request(body: unknown) {
  return new Request("http://localhost/affiliates/api/payouts/method", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

describe("affiliate payout method", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getCachedSessionMock.mockResolvedValue({ userId: "user-1" })
    affiliate.findUnique.mockResolvedValue({ userId: "user-1" })
    affiliate.update.mockResolvedValue({})
  })

  it("stores only provider IDs and masked display values", async () => {
    const response = await POST(
      request({
        affiliateId: "aff-1",
        payoutMethod: {
          type: "razorpayx",
          fundAccountId: "fa_123",
          maskedDisplay: "Bank •••• 4242",
        },
        taxFormType: "gstin",
      })
    )

    expect(response.status).toBe(200)
    expect(affiliate.update).toHaveBeenCalledWith({
      where: { id: "aff-1" },
      data: expect.objectContaining({
        payoutMethod: {
          type: "razorpayx",
          fundAccountId: "fa_123",
          maskedDisplay: "Bank •••• 4242",
          valid: false,
        },
        taxFormStatus: "PENDING_REVIEW",
      }),
    })
  })

  it.each([
    { apiKey: { keyId: "k-1", workspaceId: "ws-1", scopes: ["read", "write"], prefix: "lsk_x" } },
    { oauth: { userId: "user-1", workspaceId: "ws-1", scopes: ["lyrashield.write"] } },
  ])("rejects workspace-bound credentials — payout method is browser-only", async (credential) => {
    getCachedSessionMock.mockResolvedValue({ userId: "user-1", ...credential })

    const response = await POST(
      request({
        affiliateId: "aff-1",
        payoutMethod: {
          type: "razorpayx",
          fundAccountId: "fa_123",
          maskedDisplay: "Bank •••• 4242",
        },
      })
    )

    expect(response.status).toBe(403)
    expect(affiliate.findUnique).not.toHaveBeenCalled()
    expect(affiliate.update).not.toHaveBeenCalled()
  })

  it("rejects raw banking fields instead of persisting generic JSON", async () => {
    const response = await POST(
      request({
        affiliateId: "aff-1",
        payoutMethod: {
          type: "razorpayx",
          fundAccountId: "fa_123",
          maskedDisplay: "Bank •••• 4242",
          accountNumber: "1234567890",
        },
      })
    )

    expect(response.status).toBe(400)
    expect(affiliate.update).not.toHaveBeenCalled()
  })
})
