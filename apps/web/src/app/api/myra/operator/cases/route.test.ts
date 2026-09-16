import { beforeEach, describe, expect, it, vi } from "vitest"

const env = vi.hoisted(() => ({ MYRA_OPERATOR_ENABLED: "1" }))
const requirePlatformAdminIdentity = vi.fn()
const listOperatorCases = vi.fn()

vi.mock("@lyrashield/config", () => ({ env }))
vi.mock("@lyrashield/auth/server", () => ({
  requirePlatformAdminIdentity,
  getSession: vi.fn(),
}))
vi.mock("@lyrashield/myra/server", () => ({ listOperatorCases }))
vi.mock("@lyrashield/logger", () => ({
  setRequestId: vi.fn(),
  setRequestIdResolver: vi.fn(),
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))

const { GET } = await import("./route")

function request(url = "https://app.lyrashieldai.com/api/myra/operator/cases") {
  return new Request(url, { method: "GET" })
}

function expectPrivateHeaders(response: Response) {
  expect(response.headers.get("Cache-Control")).toBe("private, no-store")
  expect(response.headers.get("Referrer-Policy")).toBe("no-referrer")
}

describe("GET /api/myra/operator/cases private headers", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    env.MYRA_OPERATOR_ENABLED = "1"
    requirePlatformAdminIdentity.mockResolvedValue({ userId: "operator-1" })
    listOperatorCases.mockResolvedValue({ items: [], nextCursor: null })
  })

  it("marks a successful list as private/no-store", async () => {
    const response = await GET(request() as never)

    expect(response.status).toBe(200)
    expectPrivateHeaders(response)
    expect(listOperatorCases).toHaveBeenCalledWith(
      { status: undefined, cursor: undefined },
      "operator-1"
    )
  })

  it("stays private when the operator surface is disabled", async () => {
    env.MYRA_OPERATOR_ENABLED = "0"
    const response = await GET(request() as never)

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({ error: { code: "NOT_FOUND" } })
    expectPrivateHeaders(response)
    expect(requirePlatformAdminIdentity).not.toHaveBeenCalled()
  })

  it("marks mapped auth errors as private/no-store", async () => {
    requirePlatformAdminIdentity.mockRejectedValue(new Error("UNAUTHORIZED"))
    const response = await GET(request() as never)

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ error: { code: "UNAUTHORIZED" } })
    expectPrivateHeaders(response)
  })

  it("marks unmapped auth failures as a private 403", async () => {
    requirePlatformAdminIdentity.mockRejectedValue(new Error("totp-expired"))
    const response = await GET(request() as never)

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ error: { code: "FORBIDDEN" } })
    expectPrivateHeaders(response)
  })

  it("marks validation failures as private/no-store", async () => {
    const response = await GET(
      request("https://app.lyrashieldai.com/api/myra/operator/cases?status=BOGUS") as never
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_ERROR" },
    })
    expectPrivateHeaders(response)
  })

  it("marks service failures as private/no-store", async () => {
    listOperatorCases.mockRejectedValue(new Error("database down"))
    const response = await GET(request() as never)

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INTERNAL_ERROR" },
    })
    expectPrivateHeaders(response)
  })
})
