import { afterEach, describe, expect, it, vi } from "vitest"
import { createEgressProxyFetchFn } from "./egress-proxy-client"

describe("createEgressProxyFetchFn response boundary", () => {
  afterEach(() => vi.restoreAllMocks())

  const createFetch = () =>
    createEgressProxyFetchFn({ url: "https://proxy.example.com", secret: "test-token" })!

  it("returns a validated proxy response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json({
        ok: true,
        result: { html: "ok", status: 200, headers: { "content-type": "text/plain" } },
      })
    )

    const response = await createFetch()("https://example.com")
    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toBe("ok")
  })

  it.each([
    { ok: true, result: { html: "ok", status: 999, headers: {} } },
    { ok: true, result: { html: "ok", status: 200, headers: { broken: 42 } } },
    { ok: false, reason: "unknown_reason" },
    { ok: true },
  ])("classifies malformed proxy JSON as invalid_response %#", async (body) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json(body))

    await expect(createFetch()("https://example.com")).rejects.toMatchObject({
      name: "EgressProxyError",
      reason: "invalid_response",
    })
  })
})
