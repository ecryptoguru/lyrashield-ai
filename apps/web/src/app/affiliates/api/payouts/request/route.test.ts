import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@lyrashield/db", () => ({
  prisma: {
    affiliate: { findUnique: vi.fn() },
  },
}))
vi.mock("@lyrashield/affiliate", () => ({ requestPayout: vi.fn() }))

const getCachedSessionMock = vi.fn()
vi.mock("@/lib/cache", () => ({ getCachedSession: () => getCachedSessionMock() }))

import { prisma } from "@lyrashield/db"
import { requestPayout } from "@lyrashield/affiliate"
import { POST } from "./route"

const affiliate = prisma.affiliate as unknown as {
  findUnique: ReturnType<typeof vi.fn>
}

function request(body: unknown) {
  return new Request("http://localhost/affiliates/api/payouts/request", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

describe("affiliate payout request", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getCachedSessionMock.mockResolvedValue({ userId: "user-1" })
    affiliate.findUnique.mockResolvedValue({
      userId: "user-1",
      status: "APPROVED",
      payoutMethod: { type: "manual" },
    })
  })

  it.each([
    { apiKey: { keyId: "k-1", workspaceId: "ws-1", scopes: ["read", "write"], prefix: "lsk_x" } },
    { oauth: { userId: "user-1", workspaceId: "ws-1", scopes: ["lyrashield.write"] } },
  ])("rejects workspace-bound credentials — payouts are browser-only", async (credential) => {
    getCachedSessionMock.mockResolvedValue({ userId: "user-1", ...credential })

    const response = await POST(request({ affiliateId: "aff-1" }))

    expect(response.status).toBe(403)
    expect(affiliate.findUnique).not.toHaveBeenCalled()
    expect(vi.mocked(requestPayout)).not.toHaveBeenCalled()
  })

  it("lets the owning browser session request a payout", async () => {
    vi.mocked(requestPayout).mockResolvedValue({
      success: true,
      payoutId: "payout-1",
      amount: 120,
    } as never)

    const response = await POST(request({ affiliateId: "aff-1" }))

    expect(response.status).toBe(200)
    expect(requestPayout).toHaveBeenCalledWith({ affiliateId: "aff-1", provider: "manual" })
  })
})
