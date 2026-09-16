import { beforeEach, describe, expect, it, vi } from "vitest"

const env = vi.hoisted(() => ({ MYRA_OPERATOR_ENABLED: "1" }))
const requirePlatformAdminIdentity = vi.fn()
const requirePlatformAdmin = vi.fn()
const getOperatorCase = vi.fn()
const operatorTakeover = vi.fn()
const operatorRelease = vi.fn()
const operatorSetStatus = vi.fn()
const operatorAssign = vi.fn()

vi.mock("@lyrashield/config", () => ({ env }))
vi.mock("@lyrashield/auth/server", () => ({
  requirePlatformAdminIdentity,
  requirePlatformAdmin,
  getSession: vi.fn(),
}))
vi.mock("@lyrashield/myra/server", () => ({
  getOperatorCase,
  operatorTakeover,
  operatorRelease,
  operatorSetStatus,
  operatorAssign,
}))
vi.mock("@lyrashield/logger", () => ({
  setRequestId: vi.fn(),
  setRequestIdResolver: vi.fn(),
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))

const { GET, PATCH } = await import("./route")

const params = Promise.resolve({ id: "case-1" })

function expectPrivateHeaders(response: Response) {
  expect(response.headers.get("Cache-Control")).toBe("private, no-store")
  expect(response.headers.get("Referrer-Policy")).toBe("no-referrer")
}

describe("/api/myra/operator/cases/[id] private headers", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    env.MYRA_OPERATOR_ENABLED = "1"
    requirePlatformAdminIdentity.mockResolvedValue({ userId: "operator-1" })
    requirePlatformAdmin.mockResolvedValue({ userId: "operator-1" })
  })

  it("marks a successful case read as private/no-store", async () => {
    getOperatorCase.mockResolvedValue({ id: "case-1" })
    const response = await GET(
      new Request("https://app.lyrashieldai.com/api/myra/operator/cases/case-1") as never,
      { params } as never
    )

    expect(response.status).toBe(200)
    expectPrivateHeaders(response)
  })

  it("marks mapped service failures as private/no-store", async () => {
    getOperatorCase.mockRejectedValue({ code: "NOT_FOUND" })
    const response = await GET(
      new Request("https://app.lyrashieldai.com/api/myra/operator/cases/missing") as never,
      { params } as never
    )

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({ error: { code: "NOT_FOUND" } })
    expectPrivateHeaders(response)
  })

  it("marks mutation auth failures as private/no-store", async () => {
    requirePlatformAdmin.mockRejectedValue(new Error("ADMIN_REAUTH_REQUIRED"))
    const response = await PATCH(
      new Request("https://app.lyrashieldai.com/api/myra/operator/cases/case-1", {
        method: "PATCH",
        body: JSON.stringify({ action: "takeover" }),
      }) as never,
      { params } as never
    )

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "ADMIN_REAUTH_REQUIRED" },
    })
    expectPrivateHeaders(response)
  })

  it("marks mutation validation failures as private/no-store", async () => {
    const response = await PATCH(
      new Request("https://app.lyrashieldai.com/api/myra/operator/cases/case-1", {
        method: "PATCH",
        body: JSON.stringify({ action: "release" }),
      }) as never,
      { params } as never
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_ERROR" },
    })
    expectPrivateHeaders(response)
    expect(operatorRelease).not.toHaveBeenCalled()
  })
})
