import { describe, it, expect } from "vitest"
import { findingFilterToApiQuery, parseFindingListParams } from "./finding-list-params"

describe("parseFindingListParams", () => {
  it("defaults to Open + priority when the URL carries no state", () => {
    expect(parseFindingListParams({})).toEqual({
      filter: "OPEN",
      sort: "priority",
      target: "",
      q: "",
    })
  })

  it("parses valid filter and sort values", () => {
    expect(parseFindingListParams({ filter: "ALL", sort: "severity" })).toEqual({
      filter: "ALL",
      sort: "severity",
      target: "",
      q: "",
    })
    expect(parseFindingListParams({ filter: "VERIFIED" })).toEqual({
      filter: "VERIFIED",
      sort: "priority",
      target: "",
      q: "",
    })
  })

  it("falls back to defaults on invalid values instead of throwing", () => {
    expect(parseFindingListParams({ filter: "DROP TABLE", sort: "1=1" })).toEqual({
      filter: "OPEN",
      sort: "priority",
      target: "",
      q: "",
    })
  })

  it("trims and bounds the search query to 120 characters", () => {
    expect(parseFindingListParams({ q: "  injection  " }).q).toBe("injection")
    expect(parseFindingListParams({ q: "x".repeat(500) }).q).toHaveLength(120)
  })

  it("keeps the target filter verbatim", () => {
    expect(parseFindingListParams({ target: "target-1" }).target).toBe("target-1")
  })

  it("is deterministic for identical input — the server/client hydration contract", () => {
    const a = parseFindingListParams({ filter: "HIGH", sort: "newest", q: "cwe" })
    const b = parseFindingListParams({ filter: "HIGH", sort: "newest", q: "cwe" })
    expect(a).toEqual(b)
  })
})

describe("findingFilterToApiQuery", () => {
  it("maps Open to an explicit status query — the default view is queried, not implied", () => {
    expect(findingFilterToApiQuery("OPEN")).toEqual({ status: "OPEN" })
  })

  it("maps All to no constraint", () => {
    expect(findingFilterToApiQuery("ALL")).toEqual({})
  })

  it("maps severities and verified correctly", () => {
    expect(findingFilterToApiQuery("CRITICAL")).toEqual({ severity: "CRITICAL" })
    expect(findingFilterToApiQuery("VERIFIED")).toEqual({ verified: "true" })
    expect(findingFilterToApiQuery("FIXED")).toEqual({ status: "FIXED" })
  })
})
