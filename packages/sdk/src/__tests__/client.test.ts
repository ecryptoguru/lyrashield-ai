import { describe, it, expect, vi, beforeEach } from "vitest"
import { z } from "zod"
import { LyraShieldClient } from "../client"
import { LyraShieldError, NotModified } from "../errors"
import { paginate, type Paginated } from "../pagination"

function makeFetch(mock: ReturnType<typeof vi.fn>): typeof fetch {
  return mock as unknown as typeof fetch
}

function mockResponse({
  ok = true,
  status = 200,
  statusText = "OK",
  headers = new Headers(),
  body,
}: {
  ok?: boolean
  status?: number
  statusText?: string
  headers?: Headers
  body?: unknown
}) {
  return {
    ok,
    status,
    statusText,
    headers,
    json: async () => body,
  }
}

describe("LyraShieldClient", () => {
  let mockFetch: ReturnType<typeof vi.fn>
  let client: LyraShieldClient

  beforeEach(() => {
    mockFetch = vi.fn()
    client = new LyraShieldClient({
      apiKey: "test-key",
      apiUrl: "http://localhost:3000",
      fetchFn: makeFetch(mockFetch),
    })
  })

  it("sends apiKey as Authorization Bearer header", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ body: { success: true, data: { ok: true } } }))
    await client.request("GET", "/workspaces")
    const init = mockFetch.mock.calls[0]![1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers["Authorization"]).toBe("Bearer test-key")
  })

  it("sends User-Agent lyra-shield-sdk/version", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ body: { success: true, data: { ok: true } } }))
    await client.request("GET", "/workspaces")
    const init = mockFetch.mock.calls[0]![1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers["User-Agent"]).toMatch(/^lyrashield-sdk\//)
  })

  it("throws before fetch when path is already prefixed with /api/", async () => {
    await expect(client.request("GET", "/api/v1/workspaces")).rejects.toMatchObject({
      code: "INVALID_PATH",
      message: expect.stringContaining("SDK paths must be bare"),
    })
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("parses the envelope and returns data", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ body: { success: true, data: { id: "ws-1" } } }))
    const data = (await client.request("GET", "/workspaces")) as { id: string }
    expect(data.id).toBe("ws-1")
  })

  it("throws LyraShieldError when success is false on HTTP 200", async () => {
    mockFetch.mockResolvedValue(
      mockResponse({
        body: { success: false, error: { code: "TEST_ERROR", message: "Bad request" } },
      })
    )
    await expect(client.request("GET", "/workspaces")).rejects.toBeInstanceOf(LyraShieldError)
    try {
      await client.request("GET", "/workspaces")
    } catch (err) {
      const e = err as LyraShieldError
      expect(e.message).toBe("Bad request")
      expect(e.code).toBe("TEST_ERROR")
    }
  })

  it("extracts known API error codes", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        body: { success: false, error: { code: "SCAN_RATE_LIMITED", message: "rate limited" } },
      })
    )
    try {
      await client.request("GET", "/scans")
    } catch (err) {
      const e = err as LyraShieldError
      expect(e.isScanRateLimited).toBe(true)
      expect(e.isScanConcurrencyLimit).toBe(false)
    }
  })

  it("retries on 429 for idempotent GET with Retry-After", async () => {
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0)
    mockFetch
      .mockResolvedValueOnce(
        mockResponse({
          ok: false,
          status: 429,
          statusText: "Too Many Requests",
          headers: new Headers({ "retry-after": "0" }),
          body: {},
        })
      )
      .mockResolvedValueOnce(mockResponse({ body: { success: true, data: { id: "scan-1" } } }))

    const data = await client.request("GET", "/scans")
    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect((data as { id: string }).id).toBe("scan-1")
    randomSpy.mockRestore()
  })

  it("does not retry a non-idempotent POST on 429", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        headers: new Headers({ "retry-after": "1" }),
        body: {},
      })
    )
    await expect(client.request("POST", "/scans", { body: {} })).rejects.toBeInstanceOf(
      LyraShieldError
    )
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it("returns NotModified for a 304 on /scans list", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        status: 304,
        statusText: "Not Modified",
        headers: new Headers({ etag: '"abc"' }),
        body: {},
      })
    )
    const result = await client.request("GET", "/scans", { etag: '"abc"' })
    expect(result).toBeInstanceOf(NotModified)
    expect((result as NotModified).etag).toBe('"abc"')
  })

  it("returns NotModified for a 304 on /scans/[id]", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        status: 304,
        statusText: "Not Modified",
        headers: new Headers({ etag: '"def"' }),
        body: {},
      })
    )
    const result = await client.request("GET", "/scans/s-1", { etag: '"def"' })
    expect(result).toBeInstanceOf(NotModified)
  })

  it("uses error.message from JSON body over status text", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        ok: false,
        status: 403,
        statusText: "Forbidden",
        body: { error: { message: "Permission denied" } },
      })
    )
    try {
      await client.request("GET", "/scans")
    } catch (err) {
      const e = err as LyraShieldError
      expect(e.message).toBe("Permission denied")
    }
  })

  it("falls back to status text when JSON body has no error message", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        body: {},
      })
    )
    try {
      await client.request("GET", "/scans")
    } catch (err) {
      const e = err as LyraShieldError
      expect(e.message).toContain("500")
      expect(e.message).toContain("Internal Server Error")
    }
  })

  it("wraps Zod validation failures in LyraShieldError with VALIDATION_ERROR", async () => {
    const schema = z.object({ id: z.string(), count: z.number() })
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        body: { success: true, data: { id: "1", count: "not-a-number" } },
      })
    )
    try {
      await client.request("GET", "/scans", { parse: (d) => schema.parse(d) })
      expect.fail("should have thrown")
    } catch (err) {
      const e = err as LyraShieldError
      expect(e).toBeInstanceOf(LyraShieldError)
      expect(e.code).toBe("VALIDATION_ERROR")
      expect(e.status).toBe(200)
      expect(e.message).toContain("Response validation failed")
    }
  })

  it("wraps invalid JSON responses in LyraShieldError with PARSE_ERROR", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON at position 0")
      },
    })
    try {
      await client.request("GET", "/scans")
      expect.fail("should have thrown")
    } catch (err) {
      const e = err as LyraShieldError
      expect(e).toBeInstanceOf(LyraShieldError)
      expect(e.code).toBe("PARSE_ERROR")
      expect(e.status).toBe(200)
      expect(e.message).toContain("Invalid JSON response")
    }
  })

  it("returns undefined for 204 No Content responses", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 204,
      statusText: "No Content",
      headers: new Headers(),
      json: async () => {
        throw new SyntaxError("Unexpected end of JSON input")
      },
    })
    const result = await client.request("DELETE", "/scans/s-1")
    expect(result).toBeUndefined()
  })
})

describe("paginate", () => {
  it("iterates over cursor pages", async () => {
    const client = new LyraShieldClient({
      apiKey: "k",
      apiUrl: "http://localhost:3000",
      fetchFn: vi.fn() as unknown as typeof fetch,
    })
    const request = vi
      .spyOn(client, "request")
      .mockResolvedValueOnce({ items: [{ id: "1" }], nextCursor: "c2", total: 3 })
      .mockResolvedValueOnce({ items: [{ id: "2" }], nextCursor: null, total: 3 })

    const itemSchema = z.object({ id: z.string() })
    const pages: Paginated<{ id: string }>[] = []
    for await (const page of paginate(client, "GET", "/findings", { limit: 1 }, itemSchema)) {
      pages.push(page)
    }

    expect(pages).toHaveLength(2)
    expect(pages[0]?.items[0]?.id).toBe("1")
    expect(pages[1]?.items[0]?.id).toBe("2")
    expect(request).toHaveBeenCalledWith("GET", "/findings?limit=1", { parse: expect.any(Function) })
    expect(request).toHaveBeenLastCalledWith(
      "GET",
      "/findings?limit=1&cursor=c2",
      { parse: expect.any(Function) }
    )
  })
})
