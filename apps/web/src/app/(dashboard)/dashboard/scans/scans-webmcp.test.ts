import { describe, expect, it, vi } from "vitest"
import type { TargetItem } from "./scan-types"
import {
  createCheckSecurityScanHandler,
  resolveReviewOption,
  resolveVisibleTargetByName,
} from "./scans-webmcp.utils"

function target(partial: Partial<TargetItem> & { id: string; name: string }): TargetItem {
  return { type: "REPO", ...partial } as TargetItem
}

const abortSignal = new AbortController().signal

function okFetch(data: unknown) {
  return vi.fn(async () => ({
    ok: true,
    json: async () => ({ success: true, data }),
  })) as unknown as typeof fetch
}

describe("resolveVisibleTargetByName", () => {
  const targets = [
    target({ id: "t-1", name: "Storefront" }),
    target({ id: "t-2", name: "api" }),
    target({ id: "t-3", name: "API" }),
  ]

  it("matches the visible name case-insensitively and rejects ambiguity", () => {
    expect(resolveVisibleTargetByName(targets, "storefront").id).toBe("t-1")
    expect(() => resolveVisibleTargetByName(targets, "API")).toThrow(/Multiple targets/)
    expect(() => resolveVisibleTargetByName(targets, "missing")).toThrow(/No target named/)
    // Exact match only — substrings never resolve.
    expect(() => resolveVisibleTargetByName(targets, "store")).toThrow(/No target named/)
  })
})

describe("resolveReviewOption", () => {
  it("picks the requested available type, then the page selection, then the first", () => {
    const repo = target({ id: "t-1", name: "repo", type: "REPO" })
    expect(resolveReviewOption(repo, "DEEP_REVIEW", "CODE_REVIEW").id).toBe("DEEP_REVIEW")
    expect(resolveReviewOption(repo, undefined, "CODE_REVIEW").id).toBe("CODE_REVIEW")
    expect(resolveReviewOption(repo, undefined, "GONE")).toBeDefined()
  })

  it("refuses a review type the target cannot run today", () => {
    const apiNoSpec = target({ id: "t-2", name: "api", type: "API", apiSpecUrl: null })
    expect(() => resolveReviewOption(apiNoSpec, "API_DEEP", "API_SAFE")).toThrow(/not available/)
  })
})

describe("check_security_scan handler", () => {
  const targets = [
    target({ id: "t-1", name: "Storefront", type: "WEB_APP", url: "https://app.example.com" }),
  ]

  it("calls the shared eligibility contract with the page workspace — never agent input", async () => {
    const fetchFn = okFetch({ allowed: true, code: null, plan: "PRO", remainingMinutes: 120 })
    const handler = createCheckSecurityScanHandler({
      workspaceId: "ws-page",
      getTargets: () => targets,
      getSelectedPreset: () => "WEB_APP_SAFE",
      fetchFn: fetchFn as never,
    })

    const result = await handler({ targetName: "storefront" }, { signal: abortSignal })

    const [url, init] = vi.mocked(fetchFn).mock.calls[0]! as [string, RequestInit]
    expect((init.method ?? "GET").toUpperCase()).toBe("GET")
    const params = new URL(url, "http://app.test").searchParams
    expect(params.get("workspaceId")).toBe("ws-page")
    expect(params.get("targetId")).toBe("t-1")
    // URL reviews map depth to goal via the shared option policy
    // (SAFE → LAUNCH_REVIEW) — the tool sends what the composer would.
    expect(params.get("goal")).toBe("LAUNCH_REVIEW")
    expect(params.get("mode")).toBe("SAFE")
    expect(result).toMatchObject({
      allowed: true,
      plan: "PRO",
      remainingMinutes: 120,
      reviewType: { id: "WEB_APP_SAFE" },
      target: { name: "Storefront", type: "WEB_APP" },
    })
  })

  it("maps the requested review type to the option's goal and mode", async () => {
    const fetchFn = okFetch({ allowed: false, code: "DOMAIN_VERIFICATION_REQUIRED" })
    const handler = createCheckSecurityScanHandler({
      workspaceId: "ws-page",
      getTargets: () => targets,
      getSelectedPreset: () => "WEB_APP_SAFE",
      fetchFn: fetchFn as never,
    })

    await handler({ targetName: "Storefront", reviewType: "WEB_APP_DEEP" }, { signal: abortSignal })

    const [url] = vi.mocked(fetchFn).mock.calls[0]! as [string]
    const params = new URL(url, "http://app.test").searchParams
    expect(params.get("goal")).toBe("FULL_PENTEST")
    expect(params.get("mode")).toBe("DEEP")
  })

  it("returns an eligibility denial as a successful read", async () => {
    const fetchFn = okFetch({
      allowed: false,
      code: "NO_MINUTES_REMAINING",
      message: "Your agent-minute balance is exhausted.",
      plan: "FREE",
      remainingMinutes: 0,
    })
    const handler = createCheckSecurityScanHandler({
      workspaceId: "ws-page",
      getTargets: () => targets,
      getSelectedPreset: () => "WEB_APP_SAFE",
      fetchFn: fetchFn as never,
    })

    const result = await handler({ targetName: "Storefront" }, { signal: abortSignal })

    expect(result.allowed).toBe(false)
    expect(result.code).toBe("NO_MINUTES_REMAINING")
    expect(result.remainingMinutes).toBe(0)
  })

  it("throws only on transport/API failures, never mutating anything", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({ error: { message: "Target not found in this workspace" } }),
    })) as unknown as typeof fetch
    const handler = createCheckSecurityScanHandler({
      workspaceId: "ws-page",
      getTargets: () => targets,
      getSelectedPreset: () => "WEB_APP_SAFE",
      fetchFn: fetchFn as never,
    })

    await expect(handler({ targetName: "Storefront" }, { signal: abortSignal })).rejects.toThrow(
      "Target not found in this workspace"
    )
    const [url, init] = vi.mocked(fetchFn).mock.calls[0]! as [string, RequestInit]
    expect(url.startsWith("/api/scans/eligibility")).toBe(true)
    expect(init.body).toBeUndefined()
  })
})
