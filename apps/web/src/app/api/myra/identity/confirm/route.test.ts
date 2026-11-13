import { beforeEach, describe, expect, it, vi } from "vitest"

const env = vi.hoisted(() => ({
  MYRA_PUBLIC_ENABLED: "1",
  NEXT_PUBLIC_APP_URL: "https://app.lyrashieldai.com",
}))
const { confirmIdentityCode, resolveMyraRequest, checkMyraRateLimit, getSession, logger } =
  vi.hoisted(() => ({
    confirmIdentityCode: vi.fn(),
    resolveMyraRequest: vi.fn(),
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
vi.mock("@lyrashield/myra/server", () => ({ confirmIdentityCode, resolveMyraRequest }))
vi.mock("@/lib/rate-limit", () => ({
  checkMyraRateLimit,
  clientIpFromRequest: () => "203.0.113.1",
}))

const { POST } = await import("./route")

const user = {
  principal: {
    kind: "user",
    accountId: "account-1",
    sessionId: "session-1",
    email: "owner@example.com",
    emailVerified: true,
    workspaceId: null,
    role: null,
  },
  workspaceId: null,
  role: null,
}

const anonymous = {
  principal: { kind: "anonymous", publicSessionId: "public-session-1" },
  workspaceId: null,
  role: null,
}

function request(
  body: unknown,
  headers: Record<string, string> = {
    "content-type": "application/json",
    origin: "https://app.lyrashieldai.com",
    "sec-fetch-site": "same-origin",
  }
) {
  return new Request("https://app.lyrashieldai.com/api/myra/identity/confirm", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })
}

const confirmation = {
  email: "owner@example.com",
  purpose: "support_case",
  code: "123456",
}

describe("POST /api/myra/identity/confirm", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    env.MYRA_PUBLIC_ENABLED = "1"
    getSession.mockResolvedValue({ user: { id: "account-1" } })
    resolveMyraRequest.mockResolvedValue(user)
    checkMyraRateLimit.mockResolvedValue({ limited: false })
    confirmIdentityCode.mockResolvedValue(true)
  })

  it("rejects a cross-origin cookie write before resolving a principal or consuming attempts", async () => {
    const response = await POST(
      request(confirmation, {
        "content-type": "text/plain",
        cookie: "lyra.session=browser-session",
        origin: "https://attacker.lyrashieldai.com",
        "sec-fetch-site": "same-site",
      }) as never
    )

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "FORBIDDEN" },
    })
    expect(resolveMyraRequest).not.toHaveBeenCalled()
    expect(checkMyraRateLimit).not.toHaveBeenCalled()
    expect(confirmIdentityCode).not.toHaveBeenCalled()
  })

  it("allows a same-origin cookie session and binds confirmation to that account", async () => {
    const response = await POST(
      request(confirmation, {
        "content-type": "application/json",
        cookie: "lyra.session=browser-session",
        origin: "https://app.lyrashieldai.com",
        "sec-fetch-site": "same-origin",
      }) as never
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: { verified: true },
    })
    expect(resolveMyraRequest).toHaveBeenCalledOnce()
    expect(checkMyraRateLimit).toHaveBeenCalledWith("verify", "203.0.113.1")
    expect(confirmIdentityCode).toHaveBeenCalledWith(
      "owner@example.com",
      "support_case",
      "123456",
      { accountId: "account-1" }
    )
  })

  it("continues to allow a public bearer session without browser-cookie CSRF metadata", async () => {
    resolveMyraRequest.mockResolvedValue(anonymous)

    const response = await POST(
      request(confirmation, {
        "content-type": "application/json",
        "x-myra-session": "public-token",
      }) as never
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: { verified: true },
    })
    expect(getSession).not.toHaveBeenCalled()
    expect(confirmIdentityCode).toHaveBeenCalledWith(
      "owner@example.com",
      "support_case",
      "123456",
      { publicSessionId: "public-session-1" }
    )
  })

  it("stops before resolving the session when the verification IP is rate limited", async () => {
    checkMyraRateLimit.mockResolvedValue({ limited: true, retryAfter: 45 })

    const response = await POST(request(confirmation) as never)

    expect(response.status).toBe(429)
    expect(response.headers.get("Retry-After")).toBe("45")
    expect(resolveMyraRequest).not.toHaveBeenCalled()
    expect(confirmIdentityCode).not.toHaveBeenCalled()
  })
})
