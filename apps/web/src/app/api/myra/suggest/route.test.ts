import { beforeEach, describe, expect, it, vi } from "vitest"

const env = vi.hoisted(() => ({
  MYRA_PUBLIC_ENABLED: "1",
  MYRA_DASHBOARD_ENABLED: "1",
}))
const mocks = vi.hoisted(() => ({
  suggest: vi.fn(),
  resolveMyraRequest: vi.fn(),
  checkMyraRateLimit: vi.fn(),
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))

vi.mock("@lyrashield/config", () => ({
  env,
  myraDashboardAllowed: (input: { emailVerified: boolean }) => input.emailVerified,
}))
vi.mock("@lyrashield/myra/server", () => ({
  suggest: mocks.suggest,
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
    workspaceId: "workspace-1",
    role: "owner",
  },
  workspaceId: "workspace-1",
  role: "owner",
}
const anonymous = {
  principal: { kind: "anonymous", publicSessionId: "public-session-1" },
  workspaceId: null,
  role: null,
}
const suggestions = [{ title: "Connect a repository", href: "/docs/integrations/github" }]

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://app.lyrashieldai.com/api/myra/suggest", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
}

describe("POST /api/myra/suggest", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    env.MYRA_PUBLIC_ENABLED = "1"
    env.MYRA_DASHBOARD_ENABLED = "1"
    mocks.resolveMyraRequest.mockResolvedValue(anonymous)
    mocks.checkMyraRateLimit.mockResolvedValue({ limited: false })
    mocks.suggest.mockResolvedValue({ suggestions })
  })

  it("serves public suggestions to a no-cookie bearer and limits by verified session", async () => {
    const body = {
      text: "connection",
      surface: "MARKETING",
      routeContext: "/docs/integrations",
    }

    const response = await POST(request(body, { "x-myra-session": "public-token" }) as never)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ success: true, data: { suggestions } })
    expect(mocks.resolveMyraRequest).toHaveBeenCalledOnce()
    expect(mocks.checkMyraRateLimit).toHaveBeenCalledWith("suggest", "ps:public-session-1")
    expect(mocks.suggest).toHaveBeenCalledWith(
      anonymous,
      "connection",
      "MARKETING",
      "/docs/integrations"
    )
  })

  it("serves dashboard suggestions only to an enabled signed-in principal", async () => {
    mocks.resolveMyraRequest.mockResolvedValue(user)
    const body = { text: "scan status", surface: "DASHBOARD" }

    const response = await POST(
      request(body, {
        cookie: "lyra.session=browser-session",
        origin: "https://app.lyrashieldai.com",
        "sec-fetch-site": "same-origin",
      }) as never
    )

    expect(response.status).toBe(200)
    expect(mocks.checkMyraRateLimit).toHaveBeenCalledWith("suggest", "acct:account-1")
    expect(mocks.suggest).toHaveBeenCalledWith(user, "scan status", "DASHBOARD", undefined)
  })

  it("rejects invalid or client-extended input before resolving or searching", async () => {
    const response = await POST(
      request({ text: "x", surface: "MARKETING", accountId: "attacker-account" }) as never
    )

    expect(response.status).toBe(400)
    expect(mocks.resolveMyraRequest).not.toHaveBeenCalled()
    expect(mocks.checkMyraRateLimit).not.toHaveBeenCalled()
    expect(mocks.suggest).not.toHaveBeenCalled()
  })

  it("requires a resolved principal before applying the suggestion limit", async () => {
    mocks.resolveMyraRequest.mockResolvedValue(null)

    const response = await POST(request({ text: "connection", surface: "MARKETING" }) as never)

    expect(response.status).toBe(401)
    expect(mocks.checkMyraRateLimit).not.toHaveBeenCalled()
    expect(mocks.suggest).not.toHaveBeenCalled()
  })

  it("stops before knowledge search when the caller is rate limited", async () => {
    mocks.checkMyraRateLimit.mockResolvedValue({ limited: true, retryAfter: 25 })

    const response = await POST(request({ text: "connection", surface: "MARKETING" }) as never)

    expect(response.status).toBe(429)
    expect(response.headers.get("Retry-After")).toBe("25")
    expect(mocks.suggest).not.toHaveBeenCalled()
  })

  it("hides suggestions when the requested surface is disabled", async () => {
    env.MYRA_PUBLIC_ENABLED = "0"

    const response = await POST(request({ text: "connection", surface: "MARKETING" }) as never)

    expect(response.status).toBe(404)
    expect(mocks.resolveMyraRequest).not.toHaveBeenCalled()
    expect(mocks.checkMyraRateLimit).not.toHaveBeenCalled()
    expect(mocks.suggest).not.toHaveBeenCalled()
  })

  it("hides the dashboard surface when that feature gate is disabled", async () => {
    env.MYRA_DASHBOARD_ENABLED = "0"
    mocks.resolveMyraRequest.mockResolvedValue(anonymous)

    const response = await POST(request({ text: "scan status", surface: "DASHBOARD" }) as never)

    expect(response.status).toBe(404)
    expect(mocks.checkMyraRateLimit).not.toHaveBeenCalled()
    expect(mocks.suggest).not.toHaveBeenCalled()
  })
})
