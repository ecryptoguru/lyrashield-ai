import { beforeEach, describe, expect, it, vi } from "vitest"

const env = vi.hoisted(() => ({
  MYRA_PUBLIC_ENABLED: "1",
  MYRA_DASHBOARD_ENABLED: "1",
  MYRA_WRITES_ENABLED: "0",
  NEXT_PUBLIC_APP_URL: "https://app.lyrashieldai.com",
}))
const mocks = vi.hoisted(() => ({
  cancelProposal: vi.fn(),
  resolveMyraRequest: vi.fn(),
  checkMyraRateLimit: vi.fn(),
  getSession: vi.fn(),
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))

vi.mock("@lyrashield/config", () => ({
  env,
  myraDashboardAllowed: (input: { emailVerified: boolean }) => input.emailVerified,
}))
vi.mock("@lyrashield/auth/server", () => ({ getSession: mocks.getSession }))
vi.mock("@lyrashield/myra/server", () => ({
  cancelProposal: mocks.cancelProposal,
  resolveMyraRequest: mocks.resolveMyraRequest,
}))
vi.mock("@lyrashield/logger", () => ({
  logger: mocks.logger,
  setRequestId: vi.fn(),
  setRequestIdResolver: vi.fn(),
}))
vi.mock("@/lib/rate-limit", () => ({ checkMyraRateLimit: mocks.checkMyraRateLimit }))

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
    cookie: "lyra.session=browser-session",
    origin: "https://app.lyrashieldai.com",
    "sec-fetch-site": "same-origin",
  }
) {
  return new Request("https://app.lyrashieldai.com/api/myra/proposals/cancel", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })
}

describe("POST /api/myra/proposals/cancel", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    env.MYRA_PUBLIC_ENABLED = "1"
    env.MYRA_DASHBOARD_ENABLED = "1"
    // Proposal cancellation abandons a pending action; it is deliberately
    // available even while confirmed Myra writes are disabled.
    env.MYRA_WRITES_ENABLED = "0"
    mocks.getSession.mockResolvedValue({ user: { id: "account-1" } })
    mocks.resolveMyraRequest.mockResolvedValue(user)
    mocks.checkMyraRateLimit.mockResolvedValue({ limited: false })
    mocks.cancelProposal.mockResolvedValue({ status: "CANCELLED" })
  })

  it("cancels a user-owned proposal through the same-origin cookie channel while writes are off", async () => {
    const response = await POST(request({ proposalId: "proposal-1" }) as never)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: { status: "CANCELLED" },
    })
    expect(mocks.cancelProposal).toHaveBeenCalledWith(user, "proposal-1")
    expect(mocks.checkMyraRateLimit).toHaveBeenCalledWith("message", "acct:account-1")
  })

  it("preserves cancellation for a no-cookie bearer session and keys its limit to that session", async () => {
    mocks.resolveMyraRequest.mockResolvedValue(anonymous)

    const response = await POST(
      request(
        { proposalId: "proposal-1" },
        {
          "content-type": "application/json",
          "x-myra-session": "public-token",
        }
      ) as never
    )

    expect(response.status).toBe(200)
    expect(mocks.cancelProposal).toHaveBeenCalledWith(anonymous, "proposal-1")
    expect(mocks.checkMyraRateLimit).toHaveBeenCalledWith("message", "ps:public-session-1")
    expect(mocks.getSession).not.toHaveBeenCalled()
  })

  it("rejects cross-origin cookie cancellation before parsing or resolving the proposal", async () => {
    const response = await POST(
      request(
        { proposalId: "proposal-1" },
        {
          "content-type": "text/plain",
          cookie: "lyra.session=browser-session",
          origin: "https://attacker.example",
          "sec-fetch-site": "cross-site",
        }
      ) as never
    )

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ error: { code: "FORBIDDEN" } })
    expect(mocks.resolveMyraRequest).not.toHaveBeenCalled()
    expect(mocks.cancelProposal).not.toHaveBeenCalled()
  })

  it("validates the exact proposal-id body before resolving a principal", async () => {
    const response = await POST(
      request(
        { proposalId: "proposal-1", accountId: "attacker-account" },
        {
          "content-type": "application/json",
        }
      ) as never
    )

    expect(response.status).toBe(400)
    expect(mocks.resolveMyraRequest).not.toHaveBeenCalled()
    expect(mocks.checkMyraRateLimit).not.toHaveBeenCalled()
    expect(mocks.cancelProposal).not.toHaveBeenCalled()
  })

  it("requires a session and respects the principal feature gate before the rate limit", async () => {
    mocks.resolveMyraRequest.mockResolvedValue(null)
    const unauthorized = await POST(
      request({ proposalId: "proposal-1" }, { "content-type": "application/json" }) as never
    )
    expect(unauthorized.status).toBe(401)
    expect(mocks.checkMyraRateLimit).not.toHaveBeenCalled()

    mocks.resolveMyraRequest.mockResolvedValue(user)
    env.MYRA_DASHBOARD_ENABLED = "0"
    const disabled = await POST(
      request({ proposalId: "proposal-1" }, { "content-type": "application/json" }) as never
    )
    expect(disabled.status).toBe(404)
    expect(mocks.checkMyraRateLimit).not.toHaveBeenCalled()
    expect(mocks.cancelProposal).not.toHaveBeenCalled()
  })

  it("does not reveal or cancel a proposal rejected by the service ownership check", async () => {
    mocks.cancelProposal.mockRejectedValue(
      Object.assign(new Error("That item does not belong to this session"), {
        code: "OWNERSHIP_MISMATCH",
      })
    )

    const response = await POST(request({ proposalId: "foreign-proposal" }) as never)

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: { code: "OWNERSHIP_MISMATCH" },
    })
    expect(mocks.cancelProposal).toHaveBeenCalledWith(user, "foreign-proposal")
  })

  it("stops before cancellation when the principal is rate limited", async () => {
    mocks.checkMyraRateLimit.mockResolvedValue({ limited: true, retryAfter: 35 })

    const response = await POST(request({ proposalId: "proposal-1" }) as never)

    expect(response.status).toBe(429)
    expect(response.headers.get("Retry-After")).toBe("35")
    expect(mocks.cancelProposal).not.toHaveBeenCalled()
  })
})
