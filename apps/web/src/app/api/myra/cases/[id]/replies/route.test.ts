import { beforeEach, describe, expect, it, vi } from "vitest"

const env = vi.hoisted(() => ({
  MYRA_PUBLIC_ENABLED: "1",
  MYRA_DASHBOARD_ENABLED: "1",
  MYRA_WRITES_ENABLED: "1",
  NEXT_PUBLIC_APP_URL: "https://app.lyrashieldai.com",
}))
const mocks = vi.hoisted(() => ({
  replyToOwnCase: vi.fn(),
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
  replyToOwnCase: mocks.replyToOwnCase,
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
const params = Promise.resolve({ id: "case-1" })

function request(
  body: unknown,
  headers: Record<string, string> = {
    "content-type": "application/json",
    cookie: "lyra.session=browser-session",
    origin: "https://app.lyrashieldai.com",
    "sec-fetch-site": "same-origin",
  }
) {
  return new Request("https://app.lyrashieldai.com/api/myra/cases/case-1/replies", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })
}

describe("POST /api/myra/cases/[id]/replies", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    env.MYRA_PUBLIC_ENABLED = "1"
    env.MYRA_DASHBOARD_ENABLED = "1"
    env.MYRA_WRITES_ENABLED = "1"
    mocks.getSession.mockResolvedValue({ user: { id: "account-1" } })
    mocks.resolveMyraRequest.mockResolvedValue(user)
    mocks.checkMyraRateLimit.mockResolvedValue({ limited: false })
    mocks.replyToOwnCase.mockResolvedValue({ id: "reply-1", body: "Details attached." })
  })

  it("allows a verified user to reply to their case through a same-origin cookie session", async () => {
    const response = await POST(
      request({ body: "Details attached." }) as never,
      {
        params,
      } as never
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: { id: "reply-1", body: "Details attached." },
    })
    expect(mocks.resolveMyraRequest).toHaveBeenCalledOnce()
    expect(mocks.checkMyraRateLimit).toHaveBeenCalledWith("message", "acct:account-1")
    expect(mocks.replyToOwnCase).toHaveBeenCalledWith(user, "case-1", "Details attached.")
  })

  it("rejects a cross-origin cookie mutation before resolving the case owner", async () => {
    const response = await POST(
      request(
        { body: "Details attached." },
        {
          "content-type": "text/plain",
          cookie: "lyra.session=browser-session",
          origin: "https://attacker.example",
          "sec-fetch-site": "cross-site",
        }
      ) as never,
      { params } as never
    )

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ error: { code: "FORBIDDEN" } })
    expect(mocks.resolveMyraRequest).not.toHaveBeenCalled()
    expect(mocks.checkMyraRateLimit).not.toHaveBeenCalled()
    expect(mocks.replyToOwnCase).not.toHaveBeenCalled()
  })

  it("does not let an anonymous bearer reply to a user-owned case", async () => {
    const anonymous = {
      principal: { kind: "anonymous", publicSessionId: "public-session-1" },
      workspaceId: null,
      role: null,
    }
    mocks.resolveMyraRequest.mockResolvedValue(anonymous)

    const response = await POST(
      request(
        { body: "Details attached." },
        {
          "content-type": "application/json",
          "x-myra-session": "public-token",
        }
      ) as never,
      { params } as never
    )

    expect(response.status).toBe(404)
    expect(mocks.checkMyraRateLimit).not.toHaveBeenCalled()
    expect(mocks.replyToOwnCase).not.toHaveBeenCalled()
  })

  it("requires a resolved principal before accepting a case reply", async () => {
    mocks.resolveMyraRequest.mockResolvedValue(null)

    const response = await POST(
      request({ body: "Details attached." }) as never,
      {
        params,
      } as never
    )

    expect(response.status).toBe(401)
    expect(mocks.checkMyraRateLimit).not.toHaveBeenCalled()
    expect(mocks.replyToOwnCase).not.toHaveBeenCalled()
  })
})
