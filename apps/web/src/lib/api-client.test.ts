import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock global fetch
const mockFetch = vi.fn()
vi.stubGlobal("fetch", mockFetch)

const { apiGet, apiPost, apiPatch, apiDelete, apiGetPaginated, ApiError } =
  await import("./api-client")

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
  beforeEach(() => {
    mockFetch.mockReset()
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
})
