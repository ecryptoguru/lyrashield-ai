import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ retrieve: vi.fn() }))

vi.mock("@lyrashield/logger", () => ({ logger: { info: vi.fn(), error: vi.fn() } }))
vi.mock("@/lib/licenses/license-service", () => ({
  retrieveLicenseByToken: mocks.retrieve,
}))

import { POST } from "./route"

const TEST_TOKEN = ["one", "time", "token"].join("-")

describe("POST /api/licenses/retrieve", () => {
  beforeEach(() => vi.clearAllMocks())

  it("retrieves through the POST body with private response headers", async () => {
    mocks.retrieve.mockResolvedValue({
      licenseKey: "LYRA-TEST-KEY",
      licenseBlob: "signed-blob",
      licenseId: "license-1",
    })

    const response = await POST(
      new Request("https://app.lyrashieldai.com/api/licenses/retrieve", {
        method: "POST",
        body: JSON.stringify({ token: TEST_TOKEN }),
      })
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("Cache-Control")).toBe("private, no-store")
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer")
    expect(mocks.retrieve).toHaveBeenCalledWith(TEST_TOKEN)
  })

  it("rejects malformed bodies without calling the token service", async () => {
    const response = await POST(
      new Request("https://app.lyrashieldai.com/api/licenses/retrieve", {
        method: "POST",
        body: JSON.stringify({ token: "short" }),
      })
    )

    expect(response.status).toBe(404)
    expect(response.headers.get("Cache-Control")).toBe("private, no-store")
    expect(mocks.retrieve).not.toHaveBeenCalled()
  })
})
