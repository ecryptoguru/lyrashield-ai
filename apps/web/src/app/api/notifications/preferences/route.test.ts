import { beforeEach, describe, expect, it, vi } from "vitest"

const getSession = vi.hoisted(() => vi.fn())
const upsert = vi.hoisted(() => vi.fn())

vi.mock("@lyrashield/auth/server", () => ({ getSession }))
vi.mock("@lyrashield/db", () => ({
  prisma: { notificationPreference: { upsert: (...args: unknown[]) => upsert(...args) } },
}))
vi.mock("@lyrashield/logger", () => ({
  setRequestId: vi.fn(),
  logger: { error: vi.fn() },
}))

import { GET, PATCH } from "./route"

function patchRequest(body: unknown) {
  return new Request("http://localhost/api/notifications/preferences", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("PATCH /api/notifications/preferences", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getSession.mockResolvedValue({ userId: "user-1" })
    upsert.mockResolvedValue({ userId: "user-1", emailDigest: true })
  })

  it.each([
    { apiKey: { keyId: "k-1", workspaceId: "ws-1", scopes: ["read", "write"], prefix: "lsk_x" } },
    { oauth: { userId: "user-1", workspaceId: "ws-1", scopes: ["lyrashield.write"] } },
  ])(
    "rejects workspace-bound credentials — notification preferences are browser-owned",
    async (credential) => {
      getSession.mockResolvedValue({ userId: "user-1", ...credential })

      const response = await PATCH(patchRequest({ emailDigest: false }))

      expect(response.status).toBe(403)
      expect(upsert).not.toHaveBeenCalled()
    }
  )

  it("updates preferences for a browser session", async () => {
    const response = await PATCH(patchRequest({ emailDigest: false }))

    expect(response.status).toBe(200)
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { emailDigest: false } })
    )
  })
})

describe("GET /api/notifications/preferences", () => {
  it("returns preferences for a browser session", async () => {
    getSession.mockResolvedValue({ userId: "user-1" })
    upsert.mockResolvedValue({ userId: "user-1", emailDigest: true })

    const response = await GET()

    expect(response.status).toBe(200)
  })
})
