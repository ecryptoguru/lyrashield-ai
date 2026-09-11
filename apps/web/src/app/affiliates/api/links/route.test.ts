import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@lyrashield/db", () => ({
  prisma: {
    affiliate: { findUnique: vi.fn() },
    affiliateLink: { findUnique: vi.fn(), create: vi.fn() },
  },
}))
vi.mock("@/lib/rate-limit", () => ({
  checkAffiliateLinkRateLimit: vi.fn(async () => ({ limited: false })),
}))

const getCachedSessionMock = vi.fn()
vi.mock("@/lib/cache", () => ({ getCachedSession: () => getCachedSessionMock() }))

import { prisma } from "@lyrashield/db"
import { POST } from "./route"

const affiliate = prisma.affiliate as unknown as { findUnique: ReturnType<typeof vi.fn> }
const affiliateLink = prisma.affiliateLink as unknown as {
  findUnique: ReturnType<typeof vi.fn>
  create: ReturnType<typeof vi.fn>
}

function request(body: unknown) {
  return new Request("http://localhost/affiliates/api/links", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

describe("affiliate link creation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getCachedSessionMock.mockResolvedValue({ userId: "user-1" })
    affiliate.findUnique.mockResolvedValue({ userId: "user-1", status: "APPROVED" })
    affiliateLink.findUnique.mockResolvedValue(null)
    affiliateLink.create.mockResolvedValue({ id: "link-1" })
  })

  it.each([
    { apiKey: { keyId: "k-1", workspaceId: "ws-1", scopes: ["read", "write"], prefix: "lsk_x" } },
    { oauth: { userId: "user-1", workspaceId: "ws-1", scopes: ["lyrashield.write"] } },
  ])("rejects workspace-bound credentials — link management is browser-only", async (credential) => {
    getCachedSessionMock.mockResolvedValue({ userId: "user-1", ...credential })

    const response = await POST(request({ affiliateId: "aff-1", campaign: "launch" }))

    expect(response.status).toBe(403)
    expect(affiliate.findUnique).not.toHaveBeenCalled()
    expect(affiliateLink.create).not.toHaveBeenCalled()
  })

  it("creates a link for the owning browser session", async () => {
    const response = await POST(request({ affiliateId: "aff-1", campaign: "launch" }))

    expect(response.status).toBe(200)
    expect(affiliateLink.create).toHaveBeenCalled()
  })
})
