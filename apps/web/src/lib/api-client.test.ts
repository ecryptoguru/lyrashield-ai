import { describe, it, expect, vi, beforeEach, afterAll } from "vitest"
import { z } from "zod"

// Mock global fetch
const mockFetch = vi.fn()
vi.stubGlobal("fetch", mockFetch)

const {
  apiGet,
  apiPost,
  apiPut,
  apiPatch,
  apiDelete,
  apiGetPaginated,
  apiGetConditional,
  ApiError,
} = await import("./api-client")

function jsonResponse(data: unknown, success = true, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () =>
      success
        ? { success: true, data }
        : { success: false, error: { code: "TEST_ERROR", message: "Test error" } },
  }
}

describe("api-client", () => {
  it("sends domain verification as a validated PUT through the shared request helper", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ status: "VERIFIED" }))
    await expect(
      apiPut(
        "/api/target-domain-verifications",
        { workspaceId: "ws1", verificationId: "p1" },
        { schema: z.object({ status: z.literal("VERIFIED") }) }
      )
    ).resolves.toEqual({ status: "VERIFIED" })
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/target-domain-verifications",
      expect.objectContaining({
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId: "ws1", verificationId: "p1" }),
      })
    )
  })
  beforeEach(() => {
    mockFetch.mockReset()
  })
  afterAll(() => {
    vi.unstubAllGlobals()
  })

  describe("apiGet", () => {
    it("returns data on success", async () => {
      mockFetch.mockResolvedValue(jsonResponse({ id: "1", name: "test" }))
      const result = await apiGet("/api/test")
      expect(result).toEqual({ id: "1", name: "test" })
      expect(mockFetch).toHaveBeenCalledWith(
        "/api/test",
        expect.objectContaining({ method: "GET", signal: expect.any(AbortSignal) })
      )
    })

    it("throws ApiError on failure", async () => {
      mockFetch.mockResolvedValue(jsonResponse(null, false, 400))
      await expect(apiGet("/api/test")).rejects.toThrow(ApiError)
      await expect(apiGet("/api/test")).rejects.toMatchObject({ code: "TEST_ERROR", status: 400 })
    })

    it("propagates an already-aborted parent signal", async () => {
      mockFetch.mockImplementation(async (_url, init) => {
        expect(init.signal.aborted).toBe(true)
        throw new DOMException("Aborted", "AbortError")
      })
      const controller = new AbortController()
      controller.abort()

      await expect(apiGet("/api/test", { signal: controller.signal })).rejects.toMatchObject({
        code: "ABORTED",
      })
    })
  })

  describe("apiPost", () => {
    it("sends JSON body and returns data", async () => {
      mockFetch.mockResolvedValue(jsonResponse({ id: "2" }))
      const result = await apiPost("/api/test", { name: "foo" })
      expect(result).toEqual({ id: "2" })
      const call = mockFetch.mock.calls[0]!
      expect(call[0]).toBe("/api/test")
      expect(call[1].method).toBe("POST")
      expect(call[1].headers["Content-Type"]).toBe("application/json")
      expect(JSON.parse(call[1].body)).toEqual({ name: "foo" })
    })

    it("works without body", async () => {
      mockFetch.mockResolvedValue(jsonResponse({ ok: true }))
      await apiPost("/api/test")
      const init = mockFetch.mock.calls[0]![1]
      expect(init.body).toBeUndefined()
    })
  })

  describe("apiPatch", () => {
    it("sends PATCH with JSON body", async () => {
      mockFetch.mockResolvedValue(jsonResponse({ updated: true }))
      const result = await apiPatch("/api/test", { step: 1 })
      expect(result).toEqual({ updated: true })
      expect(mockFetch.mock.calls[0]![1].method).toBe("PATCH")
    })
  })

  describe("apiDelete", () => {
    it("sends DELETE", async () => {
      mockFetch.mockResolvedValue(jsonResponse({ deleted: true }))
      const result = await apiDelete("/api/test/1")
      expect(result).toEqual({ deleted: true })
      expect(mockFetch.mock.calls[0]![1].method).toBe("DELETE")
    })
  })

  describe("apiGetPaginated", () => {
    it("returns items + nextCursor", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: { items: [{ id: "1" }, { id: "2" }], nextCursor: "3" },
        }),
      })
      const result = await apiGetPaginated("/api/test", { workspaceId: "ws1", limit: "10" })
      expect(result.items).toEqual([{ id: "1" }, { id: "2" }])
      expect(result.nextCursor).toBe("3")
      const url = mockFetch.mock.calls[0]![0] as string
      expect(url).toContain("workspaceId=ws1")
      expect(url).toContain("limit=10")
    })

    it("returns null nextCursor when no more pages", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: { items: [{ id: "1" }], nextCursor: null },
        }),
      })
      const result = await apiGetPaginated("/api/test")
      expect(result.items).toEqual([{ id: "1" }])
      expect(result.nextCursor).toBeNull()
    })

    it("skips undefined params", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: { items: [], nextCursor: null },
        }),
      })
      await apiGetPaginated("/api/test", { workspaceId: "ws1", cursor: undefined })
      const url = mockFetch.mock.calls[0]![0] as string
      expect(url).toContain("workspaceId=ws1")
      expect(url).not.toContain("cursor")
    })

    it("throws ApiError on network failure", async () => {
      mockFetch.mockRejectedValue(new TypeError("Failed to fetch"))
      await expect(apiGet("/api/test")).rejects.toMatchObject({ code: "NETWORK_ERROR", status: 0 })
    })

    it("throws ApiError on non-JSON response", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("Invalid JSON")
        },
      })
      await expect(apiGet("/api/test")).rejects.toMatchObject({ code: "PARSE_ERROR", status: 200 })
    })

    it("returns undefined when data is undefined but success is true", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ success: true }),
      })
      const result = await apiGet("/api/test")
      expect(result).toBeUndefined()
    })

    it("throws ApiError on paginated network failure", async () => {
      mockFetch.mockRejectedValue(new TypeError("Failed to fetch"))
      await expect(apiGetPaginated("/api/test")).rejects.toMatchObject({
        code: "NETWORK_ERROR",
        status: 0,
      })
    })
  })
  describe("apiGetConditional", () => {
    it("sends If-None-Match and returns a null body on 304", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 304,
        headers: { get: (h: string) => (h === "ETag" ? '"abc"' : null) },
        json: async () => ({}),
      })

      const result = await apiGetConditional("/api/test", { etag: '"abc"' })

      expect(result).toEqual({ data: null, etag: '"abc"', status: 304 })
      const headers = mockFetch.mock.calls[0]![1].headers as Headers
      expect(headers.get("If-None-Match")).toBe('"abc"')
    })

    it("aborts in flight when the caller's signal aborts", async () => {
      // The function owns `signal` for its own timeout, so a caller signal must be
      // forwarded explicitly — otherwise a polling effect's cleanup cannot cancel
      // the request and it runs on until the timeout fires.
      const controller = new AbortController()
      mockFetch.mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => {
              const err = new Error("aborted")
              err.name = "AbortError"
              reject(err)
            })
          })
      )

      const pending = apiGetConditional("/api/test", { signal: controller.signal })
      controller.abort()

      await expect(pending).rejects.toMatchObject({ code: "ABORTED" })
    })

    it("does not issue a request when the caller's signal is already aborted", async () => {
      const controller = new AbortController()
      controller.abort()
      mockFetch.mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            if (init.signal?.aborted) {
              const err = new Error("aborted")
              err.name = "AbortError"
              reject(err)
              return
            }
          })
      )

      await expect(
        apiGetConditional("/api/test", { signal: controller.signal })
      ).rejects.toMatchObject({ code: "ABORTED" })
    })

    it("reports a malformed successful response as a parse error", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => {
          throw new Error("Invalid JSON")
        },
      })

      await expect(apiGetConditional("/api/test")).rejects.toMatchObject({
        code: "PARSE_ERROR",
        status: 200,
      })
    })

    it("reports schema validation failure as VALIDATION_ERROR with real status", async () => {
      const schema = z.object({ id: z.string(), count: z.number() })
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({
          success: true,
          data: { id: "1", count: "not-a-number" },
        }),
      })

      await expect(apiGetConditional("/api/test", { schema })).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        status: 200,
      })
    })
  })

  describe("schema validation", () => {
    it("returns parsed data when the response matches the schema", async () => {
      const schema = z.object({ id: z.string(), count: z.number() })
      mockFetch.mockResolvedValue(jsonResponse({ id: "1", count: 5 }))
      const result = await apiGet("/api/test", { schema })
      expect(result).toEqual({ id: "1", count: 5 })
    })

    it("throws a VALIDATION_ERROR when the response does not match the schema", async () => {
      const schema = z.object({ id: z.string(), count: z.number() })
      mockFetch.mockResolvedValue(jsonResponse({ id: "1", count: "five" }))
      await expect(apiGet("/api/test", { schema })).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        status: 200,
      })
    })

    it("validates POST responses when a schema is provided", async () => {
      const schema = z.object({ id: z.string() })
      mockFetch.mockResolvedValue(jsonResponse({ id: "created" }))
      const result = await apiPost("/api/test", { name: "foo" }, { schema })
      expect(result).toEqual({ id: "created" })
    })

    it("does not require a schema and returns raw data", async () => {
      mockFetch.mockResolvedValue(jsonResponse({ id: "raw" }))
      const result = await apiGet("/api/test")
      expect(result).toEqual({ id: "raw" })
    })
  })
})
