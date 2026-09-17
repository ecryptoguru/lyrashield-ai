import { beforeEach, describe, expect, it, vi } from "vitest"

const env = vi.hoisted(() => ({ MYRA_PUBLIC_ENABLED: "1" }))
const { requestIdentityCode, resolveMyraRequest, verifyTurnstile, checkMyraRateLimit, logger } =
  vi.hoisted(() => ({
    requestIdentityCode: vi.fn(),
    resolveMyraRequest: vi.fn(),
    verifyTurnstile: vi.fn(),
    checkMyraRateLimit: vi.fn(),
    logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  }))

vi.mock("@lyrashield/config", () => ({ env }))
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

function request(body: unknown) {
  return new Request("https://app.lyrashieldai.com/api/myra/identity/request", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("POST /api/myra/identity/request", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    env.MYRA_PUBLIC_ENABLED = "1"
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
})
