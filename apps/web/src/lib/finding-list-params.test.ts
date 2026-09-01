import { describe, it, expect } from "vitest"
import { parseFindingListParams } from "./finding-list-params"

describe("parseFindingListParams", () => {
  it("defaults to All + priority when the URL carries no state", () => {
    expect(parseFindingListParams({})).toEqual({ filter: "ALL", sort: "priority" })
  })

  it("parses valid filter and sort values", () => {
    expect(parseFindingListParams({ filter: "OPEN", sort: "severity" })).toEqual({
      filter: "OPEN",
      sort: "severity",
    })
    expect(parseFindingListParams({ filter: "VERIFIED" })).toEqual({
      filter: "VERIFIED",
      sort: "priority",
    })
  })

  it("falls back to defaults on invalid values instead of throwing", () => {
    expect(parseFindingListParams({ filter: "DROP TABLE", sort: "1=1" })).toEqual({
      filter: "ALL",
      sort: "priority",
    })
  })

  it("is deterministic for identical input — the server/client hydration contract", () => {
    const a = parseFindingListParams({ filter: "HIGH", sort: "newest" })
    const b = parseFindingListParams({ filter: "HIGH", sort: "newest" })
    expect(a).toEqual(b)
  })
})
