import { describe, expect, it } from "vitest"
import { apiError, apiSuccess, parsePaginationParams } from "./api-response"
import { withApiRequest } from "./api-auth"

function params(entries: Record<string, string>): URLSearchParams {
  return new URLSearchParams(entries)
}

describe("parsePaginationParams", () => {
  it("defaults to 50 for surfaces that have not opted into the compact page", () => {
    expect(parsePaginationParams(params({})).limit).toBe(50)
  })

  it("defaults to 25 for the runs and issues lists", () => {
    expect(parsePaginationParams(params({}), 25).limit).toBe(25)
  })

  it("honours an explicit limit within the 1-100 bound", () => {
    expect(parsePaginationParams(params({ limit: "10" }), 25).limit).toBe(10)
    expect(parsePaginationParams(params({ limit: "500" }), 25).limit).toBe(100)
    // Zero and non-numeric values fall back to the surface default.
    expect(parsePaginationParams(params({ limit: "0" }), 25).limit).toBe(25)
    expect(parsePaginationParams(params({ limit: "NaN" }), 25).limit).toBe(25)
  })

  it("passes the cursor through untouched", () => {
    expect(parsePaginationParams(params({ cursor: "abc" }), 25).cursor).toBe("abc")
    expect(parsePaginationParams(params({}), 25).cursor).toBeNull()
  })
})

describe("request id correlation", () => {
  it("echoes the inbound x-request-id on the response and inside the error envelope", async () => {
    const handler = withApiRequest(async () => apiError("FORBIDDEN", "nope", 403))
    const res = await handler(
      new Request("http://localhost/api/x", { headers: { "x-request-id": "req_test_1" } })
    )

    expect(res.headers.get("x-request-id")).toBe("req_test_1")
    const body = (await res.json()) as { error: { code: string; requestId?: string } }
    expect(body.error.code).toBe("FORBIDDEN")
    expect(body.error.requestId).toBe("req_test_1")
  })

  it("stamps a generated x-request-id on success responses too", async () => {
    const handler = withApiRequest(async () => apiSuccess({ ok: true }))
    const res = await handler(new Request("http://localhost/api/x"))

    const stamped = res.headers.get("x-request-id")
    expect(stamped).toBeTruthy()
    const body = (await res.json()) as { success: boolean }
    expect(body.success).toBe(true)
  })
})

it("preserves rate-limit status, retry headers and structured error details in request context", async () => {
  const handler = withApiRequest(async () =>
    apiError(
      "RATE_LIMITED",
      "Retry later",
      429,
      { "Retry-After": "37", "Cache-Control": "private, no-store" },
      { remaining: 0 }
    )
  )
  const response = await handler(
    new Request("https://app.test/api/project", { headers: { "x-request-id": "request-37" } })
  )
  expect(response.status).toBe(429)
  expect(response.headers.get("retry-after")).toBe("37")
  expect(response.headers.get("cache-control")).toBe("private, no-store")
  expect(response.headers.get("x-request-id")).toBe("request-37")
  expect(await response.json()).toEqual({
    success: false,
    error: {
      code: "RATE_LIMITED",
      message: "Retry later",
      requestId: "request-37",
      details: { remaining: 0 },
    },
  })
})
