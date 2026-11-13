import { beforeEach, describe, expect, it, vi } from "vitest"

const env = vi.hoisted(() => ({
  MYRA_PUBLIC_ENABLED: "1",
  NEXT_PUBLIC_APP_URL: "https://app.lyrashieldai.com",
}))
const {
  requestIdentityCode,
  resolveMyraRequest,
  verifyTurnstile,
  checkMyraRateLimit,
  getSession,
  logger,
} = vi.hoisted(() => ({
  requestIdentityCode: vi.fn(),
  resolveMyraRequest: vi.fn(),
  verifyTurnstile: vi.fn(),
  checkMyraRateLimit: vi.fn(),
  getSession: vi.fn(),
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))

vi.mock("@lyrashield/config", () => ({ env }))
vi.mock("@lyrashield/auth/server", () => ({ getSession }))
vi.mock("@lyrashield/logger", () => ({
  logger,
  setRequestId: vi.fn(),
  setRequestIdResolver: vi.fn(),
}))
vi.mock("@lyrashield/myra/server", () => ({ requestIdentityCode, resolveMyraRequest }))
vi.mock("@/lib/turnstile", () => ({ verifyTurnstile }))
vi.mock("@/lib/rate-limit", () => ({
  checkMyraRateLimit,
  clientIpFromRequest: () => "203.0.113.1",
}))

const { POST } = await import("./route")

function request(
  body: unknown,
  headers: Record<string, string> = { "content-type": "application/json" }
) {
  return new Request("https://app.lyrashieldai.com/api/myra/identity/request", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })
}

describe("POST /api/myra/identity/request", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    env.MYRA_PUBLIC_ENABLED = "1"
    getSession.mockResolvedValue(null)
    verifyTurnstile.mockResolvedValue(true)
    checkMyraRateLimit.mockResolvedValue({ limited: false })
    requestIdentityCode.mockResolvedValue({ sent: true, expiresAt: new Date() })
    resolveMyraRequest.mockResolvedValue({
      principal: { kind: "anonymous", publicSessionId: "ps_resolved" },
      workspaceId: null,
      role: null,
    })
  })

  it("binds the code to the resolved session, ignoring a client-asserted publicSessionId", async () => {
    const response = await POST(
      request({
        email: "a@b.com",
        purpose: "support_case",
        publicSessionId: "ps_forged",
      }) as never
    )

    expect(response.status).toBe(200)
    expect(requestIdentityCode).toHaveBeenCalledWith("a@b.com", "support_case", {
      publicSessionId: "ps_resolved",
    })
    expect(requestIdentityCode).not.toHaveBeenCalledWith("a@b.com", "support_case", {
      publicSessionId: "ps_forged",
    })
  })

  it("does not issue a reusable code when no principal resolves", async () => {
    resolveMyraRequest.mockResolvedValue(null)
    const response = await POST(request({ email: "a@b.com", purpose: "demo_booking" }) as never)

    expect(response.status).toBe(200)
    expect(requestIdentityCode).not.toHaveBeenCalled()
  })

  it("does not bind a session for a signed-in user principal", async () => {
    resolveMyraRequest.mockResolvedValue({
      principal: {
        kind: "user",
        accountId: "acct-1",
        sessionId: "sess-1",
        workspaceId: null,
        role: null,
      },
      workspaceId: null,
      role: null,
    })
    const response = await POST(request({ email: "a@b.com", purpose: "support_case" }) as never)

    expect(response.status).toBe(200)
    expect(requestIdentityCode).toHaveBeenCalledWith("a@b.com", "support_case", {
      accountId: "acct-1",
    })
  })

  it("rejects cross-origin cookie requests before sending a code", async () => {
    getSession.mockResolvedValue({ user: { id: "acct-1" } })

    const response = await POST(
      request(
        { email: "a@b.com", purpose: "support_case", turnstileToken: "valid" },
        {
          "content-type": "text/plain",
          cookie: "lyra.session=browser-session",
          origin: "https://attacker.lyrashieldai.com",
          "sec-fetch-site": "same-site",
          "x-myra-session": "forged-bearer-must-not-exempt-cookie-auth",
        }
      ) as never
    )

    expect(response.status).toBe(403)
    expect(requestIdentityCode).not.toHaveBeenCalled()
    expect(resolveMyraRequest).not.toHaveBeenCalled()
  })

  it("allows a same-origin cookie session", async () => {
    getSession.mockResolvedValue({ user: { id: "acct-1" } })
    resolveMyraRequest.mockResolvedValue({
      principal: { kind: "user", accountId: "acct-1" },
      workspaceId: null,
      role: null,
    })

    const response = await POST(
      request(
        { email: "a@b.com", purpose: "support_case", turnstileToken: "valid" },
        {
          "content-type": "application/json",
          cookie: "lyra.session=browser-session",
          origin: "https://app.lyrashieldai.com",
          "sec-fetch-site": "same-origin",
        }
      ) as never
    )

    expect(response.status).toBe(200)
    expect(requestIdentityCode).toHaveBeenCalledWith("a@b.com", "support_case", {
      accountId: "acct-1",
    })
  })

  it("preserves the public bearer-session flow without cookies", async () => {
    const response = await POST(
      request(
        { email: "a@b.com", purpose: "support_case", turnstileToken: "valid" },
        {
          "content-type": "application/json",
          origin: "https://lyrashieldai.com",
          "x-myra-session": "public-token",
        }
      ) as never
    )

    expect(response.status).toBe(200)
    expect(getSession).not.toHaveBeenCalled()
    expect(requestIdentityCode).toHaveBeenCalledWith("a@b.com", "support_case", {
      publicSessionId: "ps_resolved",
    })
  })
})
