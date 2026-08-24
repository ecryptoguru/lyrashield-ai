import { beforeEach, describe, expect, it, vi } from "vitest"

const verifyTOTP = vi.fn()
const requirePlatformAdminCandidateIdentity = vi.fn()
const requirePlatformAdmin = vi.fn()
const issuePlatformAdminElevation = vi.fn()

vi.mock("@lyrashield/auth/server", () => ({
  auth: { api: { verifyTOTP: (...args: unknown[]) => verifyTOTP(...args) } },
  requirePlatformAdminCandidateIdentity: (...args: unknown[]) =>
    requirePlatformAdminCandidateIdentity(...args),
  requirePlatformAdmin: (...args: unknown[]) => requirePlatformAdmin(...args),
}))
vi.mock("@lyrashield/db", () => ({
  issuePlatformAdminElevation: (...args: unknown[]) => issuePlatformAdminElevation(...args),
}))
vi.mock("@lyrashield/logger", () => ({ logger: { warn: vi.fn() } }))
vi.mock("@lyrashield/config", () => ({
  env: { NEXT_PUBLIC_APP_URL: "https://app.lyrashieldai.com" },
}))

import { POST } from "./route"

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://app.lyrashieldai.com/api/admin/elevations", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://app.lyrashieldai.com",
      "sec-fetch-site": "same-origin",
      cookie: "better-auth.session_token=signed",
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

describe("POST /api/admin/elevations", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requirePlatformAdminCandidateIdentity.mockResolvedValue({
      userId: "admin-1",
      sessionId: "session-1",
    })
    requirePlatformAdmin.mockResolvedValue({ userId: "admin-1", sessionId: "session-1" })
    verifyTOTP.mockResolvedValue({ token: "token-1" })
    issuePlatformAdminElevation.mockResolvedValue({
      nonce: "A".repeat(43),
      expiresAt: new Date("2026-08-24T10:05:00.000Z"),
    })
  })

  it("verifies TOTP through the protected auth endpoint before issuing an action nonce", async () => {
    const response = await POST(request({ action: "affiliate.reject", code: "123456" }))

    expect(response.status).toBe(201)
    expect(verifyTOTP).toHaveBeenCalledWith(
      expect.objectContaining({ body: { code: "123456", trustDevice: false } })
    )
    expect(requirePlatformAdmin).toHaveBeenCalledWith({ maxElevationAgeMs: 60_000 })
    expect(issuePlatformAdminElevation).toHaveBeenCalledWith({
      userId: "admin-1",
      sessionId: "session-1",
      action: "affiliate.reject",
    })
  })

  it("rejects arbitrary actions before TOTP verification", async () => {
    const response = await POST(request({ action: "deploy.run-command", code: "123456" }))

    expect(response.status).toBe(400)
    expect(verifyTOTP).not.toHaveBeenCalled()
  })

  it("rejects cross-origin requests before identity or TOTP work", async () => {
    const response = await POST(
      request(
        { action: "affiliate.reject", code: "123456" },
        { origin: "https://evil.example", "sec-fetch-site": "cross-site" }
      )
    )

    expect(response.status).toBe(403)
    expect(requirePlatformAdminCandidateIdentity).not.toHaveBeenCalled()
    expect(verifyTOTP).not.toHaveBeenCalled()
  })

  it("does not issue a nonce when the stamped session differs", async () => {
    requirePlatformAdmin.mockResolvedValue({ userId: "admin-1", sessionId: "session-2" })

    const response = await POST(request({ action: "affiliate.reject", code: "123456" }))

    expect(response.status).toBe(409)
    expect(issuePlatformAdminElevation).not.toHaveBeenCalled()
  })
})
