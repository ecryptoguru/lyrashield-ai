import { beforeEach, describe, expect, it, vi } from "vitest"

const env = vi.hoisted(() => ({ MYRA_PUBLIC_ENABLED: "1", MYRA_DASHBOARD_ENABLED: "1" }))
const {
  rateAssistantMessage,
  resolveMyraRequest,
  checkMyraRateLimit,
  logger,
  myraDashboardAllowed,
  MyraServiceError,
} = vi.hoisted(() => ({
  rateAssistantMessage: vi.fn(),
  resolveMyraRequest: vi.fn(),
  checkMyraRateLimit: vi.fn(),
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  myraDashboardAllowed: vi.fn((input: { emailVerified: boolean }) => input.emailVerified),
  MyraServiceError: class MyraServiceError extends Error {
    readonly code: string
    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  },
}))

vi.mock("@lyrashield/config", () => ({ env, myraDashboardAllowed }))
vi.mock("@lyrashield/logger", () => ({
  logger,
  setRequestId: vi.fn(),
  setRequestIdResolver: vi.fn(),
}))
vi.mock("@lyrashield/myra/server", () => ({
  rateAssistantMessage,
  resolveMyraRequest,
  MyraServiceError,
}))
vi.mock("@/lib/rate-limit", () => ({ checkMyraRateLimit }))

const { POST } = await import("./route")

const verifiedUser = {
  principal: {
    kind: "user",
    accountId: "account-1",
    sessionId: "session-1",
    email: "owner@example.com",
    emailVerified: true,
    workspaceId: null,
    role: null,
  },
}

function request(body: unknown) {
  return new Request("https://app.lyrashieldai.com/api/myra/feedback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("POST /api/myra/feedback", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    env.MYRA_DASHBOARD_ENABLED = "1"
    env.MYRA_PUBLIC_ENABLED = "1"
    checkMyraRateLimit.mockResolvedValue({ limited: false })
    rateAssistantMessage.mockResolvedValue({ messageId: "m-1", rating: "helpful" })
    resolveMyraRequest.mockResolvedValue(verifiedUser)
  })

  it("rates a message the caller owns", async () => {
    const response = await POST(request({ messageId: "m-1", rating: "helpful" }) as never)

    expect(response.status).toBe(200)
    expect(rateAssistantMessage).toHaveBeenCalledWith(verifiedUser, "m-1", "helpful")
  })

  it("refuses an unauthenticated caller", async () => {
    resolveMyraRequest.mockResolvedValue(null)

    const response = await POST(request({ messageId: "m-1", rating: "helpful" }) as never)

    expect(response.status).toBe(401)
    expect(rateAssistantMessage).not.toHaveBeenCalled()
  })

  it("refuses a platform operator", async () => {
    resolveMyraRequest.mockResolvedValue({
      principal: { kind: "operator", accountId: "op", sessionId: "s" },
    })

    const response = await POST(request({ messageId: "m-1", rating: "helpful" }) as never)

    expect(response.status).toBe(401)
    expect(rateAssistantMessage).not.toHaveBeenCalled()
  })

  it("rejects an invalid body before rating anything", async () => {
    const response = await POST(request({ messageId: "m-1", rating: "maybe" }) as never)

    expect(response.status).toBe(400)
    expect(rateAssistantMessage).not.toHaveBeenCalled()
  })

  it("rejects unknown body keys", async () => {
    const response = await POST(
      request({ messageId: "m-1", rating: "helpful", extra: true }) as never
    )

    expect(response.status).toBe(400)
    expect(rateAssistantMessage).not.toHaveBeenCalled()
  })

  it("returns 429 when the caller is rate limited", async () => {
    checkMyraRateLimit.mockResolvedValue({ limited: true, retryAfter: 30 })

    const response = await POST(request({ messageId: "m-1", rating: "helpful" }) as never)

    expect(response.status).toBe(429)
    expect(rateAssistantMessage).not.toHaveBeenCalled()
  })

  it("answers 404 for a message another owner owns", async () => {
    rateAssistantMessage.mockRejectedValue(new MyraServiceError("NOT_FOUND", "Answer not found."))

    const response = await POST(request({ messageId: "someone-elses", rating: "helpful" }) as never)

    expect(response.status).toBe(404)
  })
})
