import { beforeEach, describe, expect, it, vi } from "vitest"

const env = vi.hoisted(() => ({
  MYRA_PUBLIC_ENABLED: "1",
  MYRA_DASHBOARD_ENABLED: "1",
  NEXT_PUBLIC_APP_URL: "https://app.lyrashieldai.com",
}))
const mocks = vi.hoisted(() => ({
  issuePublicSession: vi.fn(),
  resolveMyraRequest: vi.fn(),
  verifyTurnstile: vi.fn(),
  checkMyraRateLimit: vi.fn(),
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))

vi.mock("@lyrashield/config", () => ({
  env,
  myraDashboardAllowed: (input: { emailVerified: boolean }) => input.emailVerified,
}))
vi.mock("@lyrashield/myra/server", () => ({
  issuePublicSession: mocks.issuePublicSession,
  resolveMyraRequest: mocks.resolveMyraRequest,
}))
vi.mock("@lyrashield/logger", () => ({
  logger: mocks.logger,
  setRequestId: vi.fn(),
  setRequestIdResolver: vi.fn(),
}))
vi.mock("@/lib/turnstile", () => ({ verifyTurnstile: mocks.verifyTurnstile }))
vi.mock("@/lib/rate-limit", () => ({
  checkMyraRateLimit: mocks.checkMyraRateLimit,
  clientIpFromRequest: () => "203.0.113.1",
}))

const { POST } = await import("./route")

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://app.lyrashieldai.com/api/myra/session", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
}

describe("POST /api/myra/session", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    env.MYRA_PUBLIC_ENABLED = "1"
    env.MYRA_DASHBOARD_ENABLED = "1"
    mocks.resolveMyraRequest.mockResolvedValue(null)
    mocks.checkMyraRateLimit.mockResolvedValue({ limited: false })
    mocks.verifyTurnstile.mockResolvedValue(true)
    mocks.issuePublicSession.mockResolvedValue({
      token: "opaque-public-token",
      publicSessionId: "public-session-1",
      expiresAt: new Date("2026-10-03T12:00:00.000Z"),
    })
  })

  it("issues a public bearer only after rate limiting and Turnstile verification", async () => {
    const response = await POST(
      request({ surface: "MARKETING", turnstileToken: "turnstile-proof" }) as never
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        principal: "anonymous",
        publicToken: "opaque-public-token",
        sessionId: "public-session-1",
      },
    })
    expect(mocks.checkMyraRateLimit).toHaveBeenCalledWith("verify", "203.0.113.1")
    expect(mocks.verifyTurnstile).toHaveBeenCalledWith("turnstile-proof")
    expect(mocks.issuePublicSession).toHaveBeenCalledWith("MARKETING")
  })

  it("does not issue a public bearer to an enabled signed-in browser principal", async () => {
    mocks.resolveMyraRequest.mockResolvedValue({
      principal: {
        kind: "user",
        accountId: "account-1",
        sessionId: "session-1",
        email: "owner@example.com",
        emailVerified: true,
        workspaceId: null,
        role: null,
      },
    })

    const response = await POST(request({}) as never)

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({
      success: true,
      data: { principal: "user" },
    })
    expect(body.data).not.toHaveProperty("publicToken")
    expect(mocks.checkMyraRateLimit).not.toHaveBeenCalled()
    expect(mocks.verifyTurnstile).not.toHaveBeenCalled()
    expect(mocks.issuePublicSession).not.toHaveBeenCalled()
  })

  it("does not fall back to anonymous token minting when a signed-in principal is disabled", async () => {
    env.MYRA_DASHBOARD_ENABLED = "0"
    mocks.resolveMyraRequest.mockResolvedValue({
      principal: {
        kind: "user",
        accountId: "account-1",
        sessionId: "session-1",
        email: "owner@example.com",
        emailVerified: true,
        workspaceId: null,
        role: null,
      },
    })

    const response = await POST(
      request({ surface: "MARKETING", turnstileToken: "turnstile-proof" }) as never
    )

    expect(response.status).toBe(404)
    expect(mocks.checkMyraRateLimit).not.toHaveBeenCalled()
    expect(mocks.verifyTurnstile).not.toHaveBeenCalled()
    expect(mocks.issuePublicSession).not.toHaveBeenCalled()
  })

  it("keeps an already-resolved anonymous bearer without minting another token", async () => {
    mocks.resolveMyraRequest.mockResolvedValue({
      principal: { kind: "anonymous", publicSessionId: "existing-session" },
    })

    const response = await POST(request({}) as never)

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({
      success: true,
      data: { principal: "anonymous" },
    })
    expect(body.data).not.toHaveProperty("publicToken")
    expect(mocks.checkMyraRateLimit).not.toHaveBeenCalled()
    expect(mocks.issuePublicSession).not.toHaveBeenCalled()
  })

  it("stops before Turnstile or token issuance when minting is rate limited", async () => {
    mocks.checkMyraRateLimit.mockResolvedValue({ limited: true, retryAfter: 45 })

    const response = await POST(
      request({ surface: "MARKETING", turnstileToken: "turnstile-proof" }) as never
    )

    expect(response.status).toBe(429)
    expect(response.headers.get("Retry-After")).toBe("45")
    expect(mocks.verifyTurnstile).not.toHaveBeenCalled()
    expect(mocks.issuePublicSession).not.toHaveBeenCalled()
  })

  it("does not issue a public session when Turnstile verification fails", async () => {
    mocks.verifyTurnstile.mockResolvedValue(false)

    const response = await POST(
      request({ surface: "MARKETING", turnstileToken: "invalid-proof" }) as never
    )

    expect(response.status).toBe(403)
    expect(mocks.issuePublicSession).not.toHaveBeenCalled()
  })

  it("hides public minting when the public surface is disabled", async () => {
    env.MYRA_PUBLIC_ENABLED = "0"

    const response = await POST(request({ surface: "MARKETING" }) as never)

    expect(response.status).toBe(404)
    expect(mocks.checkMyraRateLimit).not.toHaveBeenCalled()
    expect(mocks.issuePublicSession).not.toHaveBeenCalled()
  })
})
