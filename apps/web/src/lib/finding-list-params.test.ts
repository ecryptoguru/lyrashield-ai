import { describe, it, expect } from "vitest"
import {
  findingFilterToApiQuery,
  findingsHref,
  reportsHref,
  parseFindingListParams,
  withPreservedSearchParams,
} from "./finding-list-params"

describe("parseFindingListParams", () => {
  it("defaults to Open + priority when the URL carries no state", () => {
    expect(parseFindingListParams({})).toEqual({
      filter: "OPEN",
      sort: "priority",
      scanId: "",
      target: "",
      scopeValid: true,
      q: "",
    })
  })

  it("parses valid filter and sort values", () => {
    expect(parseFindingListParams({ filter: "ALL", sort: "severity" })).toEqual({
      filter: "ALL",
      sort: "severity",
      scanId: "",
      target: "",
      scopeValid: true,
      q: "",
    })
    expect(parseFindingListParams({ filter: "VERIFIED" })).toEqual({
      filter: "VERIFIED",
      sort: "priority",
      scanId: "",
      target: "",
      scopeValid: true,
      q: "",
    })
  })

  it("falls back to defaults on invalid values instead of throwing", () => {
    expect(parseFindingListParams({ filter: "DROP TABLE", sort: "1=1" })).toEqual({
      filter: "OPEN",
      sort: "priority",
      scanId: "",
      target: "",
      scopeValid: true,
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

  it("maps the UI scan scope independently from API origin scanId and accepts targetId alias", () => {
    expect(parseFindingListParams({ scanId: " scan-2 ", targetId: " target-1 " })).toMatchObject({
      scanId: "scan-2",
      target: "target-1",
      scopeValid: true,
    })
  })

  it("marks blank or conflicting scope inputs invalid instead of dropping scope", () => {
    expect(parseFindingListParams({ scanId: " " }).scopeValid).toBe(false)
    expect(parseFindingListParams({ target: "target-1", targetId: "target-2" }).scopeValid).toBe(
      false
    )
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

describe("reportsHref", () => {
  it("opens the direct Reports route while preserving scan and target scope", () => {
    expect(reportsHref({ scanId: "scan 1", targetId: "target/1" })).toBe(
      "/dashboard/reports?scanId=scan+1&targetId=target%2F1"
    )
    expect(reportsHref({})).toBe("/dashboard/reports")
  })
})

describe("findingsHref", () => {
  it("keeps scan and target scope in finding links", () => {
    expect(
      findingsHref({ tab: "issues", finding: "finding-1", scanId: "scan-2", target: "target-1" })
    ).toBe("/dashboard/findings?tab=issues&finding=finding-1&scanId=scan-2&target=target-1")
  })
})

describe("withPreservedSearchParams", () => {
  it("keeps current scan and target scope on tab navigation without copying search filters", () => {
    expect(
      withPreservedSearchParams(
        "/dashboard/findings?tab=evidence&target=stale",
        new URLSearchParams("scanId=scan-3&target=target-2&filter=HIGH&q=secret"),
        ["scanId", "target", "targetId"]
      )
    ).toBe("/dashboard/findings?tab=evidence&scanId=scan-3&target=target-2")
  })
})

it("combines all three filter axes without losing scan and target scope", () => {
  const state = parseFindingListParams({
    status: "OPEN",
    severity: "HIGH",
    evidence: "VERIFIED",
    scanId: "scan-1",
    target: "target-1",
  })
  expect(state).toMatchObject({ scanId: "scan-1", target: "target-1", scopeValid: true })
  expect(findingFilterToApiQuery(state.filter)).toEqual({
    status: "OPEN",
    severity: "HIGH",
    verified: "true",
  })
})

it("supports pending retest and unverified evidence independently", () => {
  const state = parseFindingListParams({
    status: "FIXED_PENDING_RETEST",
    severity: "ALL",
    evidence: "UNVERIFIED",
  })
  expect(findingFilterToApiQuery(state.filter)).toEqual({
    status: "FIXED_PENDING_RETEST",
    verified: "false",
  })
})

it("preserves the scope of legacy exclusive links and validates new axes", () => {
  expect(findingFilterToApiQuery(parseFindingListParams({ filter: "HIGH" }).filter)).toEqual({
    severity: "HIGH",
  })
  expect(
    findingFilterToApiQuery(
      parseFindingListParams({ status: "ALL", severity: "DROP TABLE", evidence: "invalid" }).filter
    )
  ).toEqual({})
})
