import { describe, expect, it } from "vitest"
import { parsePaginationParams } from "./api-response"

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
