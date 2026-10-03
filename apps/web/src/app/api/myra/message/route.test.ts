import { beforeEach, describe, expect, it, vi } from "vitest"

const env = vi.hoisted(() => ({
  MYRA_PUBLIC_ENABLED: "1",
  MYRA_DASHBOARD_ENABLED: "1",
  NEXT_PUBLIC_APP_URL: "https://app.lyrashieldai.com",
}))
const mocks = vi.hoisted(() => ({
  handleMessage: vi.fn(),
  resolveMyraRequest: vi.fn(),
  checkMyraRateLimit: vi.fn(),
  checkMyraDailyTurnLimit: vi.fn(),
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))

vi.mock("@lyrashield/config", () => ({
  env,
  myraDashboardAllowed: (input: { emailVerified: boolean }) => input.emailVerified,
}))
vi.mock("@lyrashield/myra/server", () => ({
  handleMessage: mocks.handleMessage,
  resolveMyraRequest: mocks.resolveMyraRequest,
}))
vi.mock("@lyrashield/logger", () => ({
  logger: mocks.logger,
  setRequestId: vi.fn(),
  setRequestIdResolver: vi.fn(),
}))
vi.mock("@/lib/rate-limit", () => ({
  checkMyraRateLimit: mocks.checkMyraRateLimit,
  checkMyraDailyTurnLimit: mocks.checkMyraDailyTurnLimit,
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
  workspaceId: "workspace-1",
  role: "owner",
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
  return new Request("https://app.lyrashieldai.com/api/myra/message", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })
}

const message = {
  text: "How do I connect my repository?",
  surface: "DASHBOARD",
  routeContext: "/dashboard/integrations",
  conversationId: "conversation-1",
  sessionMemory: { preferred_depth: "detailed" },
}

describe("POST /api/myra/message", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    env.MYRA_PUBLIC_ENABLED = "1"
    env.MYRA_DASHBOARD_ENABLED = "1"
    mocks.resolveMyraRequest.mockResolvedValue(user)
    mocks.checkMyraRateLimit.mockResolvedValue({ limited: false })
    mocks.checkMyraDailyTurnLimit.mockResolvedValue({ limited: false })
    mocks.handleMessage.mockImplementation((_resolved, _input) =>
      (async function* () {
        yield { type: "ready", conversationId: "conversation-1", traceId: "trace-1" }
      })()
    )
  })

  it("streams for a verified user after same-origin validation and both rate gates", async () => {
    const response = await POST(request(message) as never)

    expect(response.status).toBe(200)
    expect(response.headers.get("Content-Type")).toContain("text/event-stream")
    const stream = await response.text()
    expect(stream).toContain('"type":"ready"')
    expect(mocks.resolveMyraRequest).toHaveBeenCalledOnce()
    expect(mocks.checkMyraRateLimit).toHaveBeenCalledWith("message", "acct:account-1")
    expect(mocks.checkMyraDailyTurnLimit).toHaveBeenCalledWith("user", "acct:account-1")
    expect(mocks.handleMessage).toHaveBeenCalledWith(
      user,
      expect.objectContaining({
        text: message.text,
        conversationId: "conversation-1",
        routeContext: "/dashboard/integrations",
        surface: "DASHBOARD",
        sessionMemory: { preferred_depth: "detailed" },
        signal: expect.any(AbortSignal),
      })
    )
  })

  it("accepts a no-cookie public bearer and keys both limits to its resolved session", async () => {
    mocks.resolveMyraRequest.mockResolvedValue(anonymous)
    const publicMessage = { text: "What can I scan?", surface: "MARKETING" }

    const response = await POST(
      request(publicMessage, {
        "content-type": "application/json",
        "x-myra-session": "public-token",
      }) as never
    )

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('"type":"ready"')
    expect(mocks.checkMyraRateLimit).toHaveBeenCalledWith("message", "ps:public-session-1")
    expect(mocks.checkMyraDailyTurnLimit).toHaveBeenCalledWith("anonymous", "ps:public-session-1")
    expect(mocks.handleMessage).toHaveBeenCalledWith(
      anonymous,
      expect.objectContaining({ text: publicMessage.text, surface: "MARKETING" })
    )
  })

  it("rejects a cross-origin cookie mutation before resolving the principal or reserving limits", async () => {
    const response = await POST(
      request(message, {
        "content-type": "application/json",
        cookie: "lyra.session=browser-session",
        origin: "https://attacker.example",
        "sec-fetch-site": "cross-site",
      }) as never
    )

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ error: { code: "FORBIDDEN" } })
    expect(mocks.resolveMyraRequest).not.toHaveBeenCalled()
    expect(mocks.checkMyraRateLimit).not.toHaveBeenCalled()
    expect(mocks.handleMessage).not.toHaveBeenCalled()
  })

  it("rejects an invalid message before resolving a principal or using model-backed limits", async () => {
    const response = await POST(
      request(
        { ...message, text: "", accountId: "untrusted-account" },
        {
          "content-type": "application/json",
        }
      ) as never
    )

    expect(response.status).toBe(400)
    expect(mocks.resolveMyraRequest).not.toHaveBeenCalled()
    expect(mocks.checkMyraRateLimit).not.toHaveBeenCalled()
    expect(mocks.checkMyraDailyTurnLimit).not.toHaveBeenCalled()
    expect(mocks.handleMessage).not.toHaveBeenCalled()
  })

  it("does not start an SSE stream when the per-message limit is exhausted", async () => {
    mocks.checkMyraRateLimit.mockResolvedValue({ limited: true, retryAfter: 30 })

    const response = await POST(request(message) as never)

    expect(response.status).toBe(429)
    expect(response.headers.get("Retry-After")).toBe("30")
    expect(mocks.checkMyraDailyTurnLimit).not.toHaveBeenCalled()
    expect(mocks.handleMessage).not.toHaveBeenCalled()
  })

  it("does not start an SSE stream when the daily turn limit is exhausted", async () => {
    mocks.checkMyraDailyTurnLimit.mockResolvedValue({ limited: true, retryAfter: 120 })

    const response = await POST(request(message) as never)

    expect(response.status).toBe(429)
    expect(response.headers.get("Retry-After")).toBe("120")
    expect(mocks.checkMyraRateLimit).toHaveBeenCalledOnce()
    expect(mocks.handleMessage).not.toHaveBeenCalled()
  })

  it("hides a disabled public surface before resolving the caller", async () => {
    env.MYRA_PUBLIC_ENABLED = "0"
    const publicMessage = { text: "What can I scan?", surface: "MARKETING" }

    const response = await POST(
      request(publicMessage, { "content-type": "application/json" }) as never
    )

    expect(response.status).toBe(404)
    expect(mocks.resolveMyraRequest).not.toHaveBeenCalled()
    expect(mocks.checkMyraRateLimit).not.toHaveBeenCalled()
    expect(mocks.handleMessage).not.toHaveBeenCalled()
  })

  it("requires a resolved caller and refuses an operator principal before rate limiting", async () => {
    mocks.resolveMyraRequest.mockResolvedValue(null)
    const unauthorized = await POST(
      request(
        { text: "What can I scan?", surface: "MARKETING" },
        {
          "content-type": "application/json",
        }
      ) as never
    )
    expect(unauthorized.status).toBe(401)
    expect(mocks.checkMyraRateLimit).not.toHaveBeenCalled()

    mocks.resolveMyraRequest.mockResolvedValue({
      principal: { kind: "operator", accountId: "operator-1", sessionId: "session-1" },
      workspaceId: null,
      role: null,
    })
    const forbidden = await POST(
      request(
        { text: "What can I scan?", surface: "MARKETING" },
        {
          "content-type": "application/json",
        }
      ) as never
    )
    expect(forbidden.status).toBe(403)
    expect(mocks.checkMyraRateLimit).not.toHaveBeenCalled()
    expect(mocks.handleMessage).not.toHaveBeenCalled()
  })
})
