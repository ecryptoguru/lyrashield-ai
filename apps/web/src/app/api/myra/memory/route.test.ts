import { beforeEach, describe, expect, it, vi } from "vitest"

const env = vi.hoisted(() => ({
  MYRA_DASHBOARD_ENABLED: "1",
  MYRA_WRITES_ENABLED: "1",
  NEXT_PUBLIC_APP_URL: "https://app.lyrashieldai.com",
}))
const mocks = vi.hoisted(() => ({
  clearAccountMemory: vi.fn(),
  resolveMyraRequest: vi.fn(),
  getSession: vi.fn(),
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))

vi.mock("@lyrashield/config", () => ({
  env,
  myraDashboardAllowed: (input: { emailVerified: boolean }) => input.emailVerified,
}))
vi.mock("@lyrashield/auth/server", () => ({ getSession: mocks.getSession }))
vi.mock("@lyrashield/myra/server", () => ({
  clearAccountMemory: mocks.clearAccountMemory,
  resolveMyraRequest: mocks.resolveMyraRequest,
}))
vi.mock("@lyrashield/logger", () => ({
  logger: mocks.logger,
  setRequestId: vi.fn(),
  setRequestIdResolver: vi.fn(),
}))

const { DELETE } = await import("./route")

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

function request(
  headers: Record<string, string> = {
    cookie: "lyra.session=browser-session",
    origin: "https://app.lyrashieldai.com",
    "sec-fetch-site": "same-origin",
  }
) {
  return new Request("https://app.lyrashieldai.com/api/myra/memory", {
    method: "DELETE",
    headers,
  })
}

describe("DELETE /api/myra/memory", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    env.MYRA_DASHBOARD_ENABLED = "1"
    env.MYRA_WRITES_ENABLED = "1"
    mocks.getSession.mockResolvedValue({ user: { id: "account-1" } })
    mocks.resolveMyraRequest.mockResolvedValue(user)
    mocks.clearAccountMemory.mockResolvedValue({ cleared: 3 })
  })

  it("clears memory for the resolved signed-in account on a same-origin cookie request", async () => {
    const response = await DELETE(request() as never)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: { cleared: 3 },
    })
    expect(mocks.resolveMyraRequest).toHaveBeenCalledOnce()
    expect(mocks.clearAccountMemory).toHaveBeenCalledWith(user)
  })

  it("rejects a cross-origin cookie deletion before resolving the account", async () => {
    const response = await DELETE(
      request({
        cookie: "lyra.session=browser-session",
        origin: "https://attacker.example",
        "sec-fetch-site": "cross-site",
      }) as never
    )

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ error: { code: "FORBIDDEN" } })
    expect(mocks.resolveMyraRequest).not.toHaveBeenCalled()
    expect(mocks.clearAccountMemory).not.toHaveBeenCalled()
  })

  it("does not let an anonymous public bearer clear account memory", async () => {
    mocks.resolveMyraRequest.mockResolvedValue({
      principal: { kind: "anonymous", publicSessionId: "public-session-1" },
      workspaceId: null,
      role: null,
    })

    const response = await DELETE(request({ "x-myra-session": "public-token" }) as never)

    expect(response.status).toBe(401)
    expect(mocks.clearAccountMemory).not.toHaveBeenCalled()
  })

  it("requires a signed-in principal before deleting memory", async () => {
    mocks.resolveMyraRequest.mockResolvedValue(null)

    const response = await DELETE(request({}) as never)

    expect(response.status).toBe(401)
    expect(mocks.clearAccountMemory).not.toHaveBeenCalled()
  })

  it("hides memory controls for a signed-in account that fails the dashboard gate", async () => {
    mocks.resolveMyraRequest.mockResolvedValue({
      principal: { ...user.principal, emailVerified: false },
      workspaceId: null,
      role: null,
    })

    const response = await DELETE(request() as never)

    expect(response.status).toBe(404)
    expect(mocks.clearAccountMemory).not.toHaveBeenCalled()
  })
})
