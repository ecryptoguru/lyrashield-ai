import { beforeEach, describe, expect, it, vi } from "vitest"

const env = vi.hoisted(() => ({
  MYRA_PUBLIC_ENABLED: "1",
  MYRA_DASHBOARD_ENABLED: "1",
  MYRA_WRITES_ENABLED: "1",
  MYRA_PUBLIC_BOOKING_ENABLED: "1",
  NEXT_PUBLIC_APP_URL: "https://app.lyrashieldai.com",
}))
const mocks = vi.hoisted(() => ({
  confirmProposal: vi.fn(),
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
  confirmProposal: mocks.confirmProposal,
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
  return new Request("https://app.lyrashieldai.com/api/myra/proposals/confirm", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })
}

describe("POST /api/myra/proposals/confirm", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    env.MYRA_PUBLIC_ENABLED = "1"
    env.MYRA_DASHBOARD_ENABLED = "1"
    env.MYRA_WRITES_ENABLED = "1"
    env.MYRA_PUBLIC_BOOKING_ENABLED = "1"
    mocks.getSession.mockResolvedValue({ user: { id: "account-1" } })
    mocks.resolveMyraRequest.mockResolvedValue(user)
    mocks.checkMyraRateLimit.mockResolvedValue({ limited: false })
    mocks.confirmProposal.mockResolvedValue({
      status: "COMPLETED",
      result: { saved: true },
      component: { type: "action_result", proposalId: "proposal-1", status: "COMPLETED" },
    })
  })

  it("confirms only the proposal identified by the verified cookie principal", async () => {
    const response = await POST(request({ proposalId: "proposal-1" }) as never)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: { status: "COMPLETED", result: { saved: true } },
    })
    expect(mocks.confirmProposal).toHaveBeenCalledWith(user, "proposal-1")
    expect(mocks.checkMyraRateLimit).toHaveBeenCalledWith("message", "acct:account-1")
  })

  it("preserves the anonymous bearer path for proposals owned by that public session", async () => {
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
    expect(mocks.confirmProposal).toHaveBeenCalledWith(anonymous, "proposal-1")
    expect(mocks.checkMyraRateLimit).toHaveBeenCalledWith("message", "ps:public-session-1")
    expect(mocks.getSession).not.toHaveBeenCalled()
  })

  it("rejects a cross-origin cookie confirmation before resolving or confirming", async () => {
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
    expect(mocks.checkMyraRateLimit).not.toHaveBeenCalled()
    expect(mocks.confirmProposal).not.toHaveBeenCalled()
  })

  it("rejects unauthenticated callers before consuming a confirmation attempt", async () => {
    mocks.resolveMyraRequest.mockResolvedValue(null)

    const response = await POST(
      request({ proposalId: "proposal-1" }, { "content-type": "application/json" }) as never
    )

    expect(response.status).toBe(401)
    expect(mocks.checkMyraRateLimit).not.toHaveBeenCalled()
    expect(mocks.confirmProposal).not.toHaveBeenCalled()
  })

  it("keeps public writes hidden when the write gate is disabled", async () => {
    env.MYRA_WRITES_ENABLED = "0"

    const response = await POST(request({ proposalId: "proposal-1" }) as never)

    expect(response.status).toBe(404)
    expect(mocks.checkMyraRateLimit).not.toHaveBeenCalled()
    expect(mocks.confirmProposal).not.toHaveBeenCalled()
  })

  it("rejects client-supplied payload data instead of allowing confirmation to be rewritten", async () => {
    const response = await POST(
      request({ proposalId: "proposal-1", payload: { destination: "attacker" } }) as never
    )

    expect(response.status).toBe(400)
    expect(mocks.checkMyraRateLimit).not.toHaveBeenCalled()
    expect(mocks.confirmProposal).not.toHaveBeenCalled()
  })
})
