import { describe, expect, it } from "vitest"
import {
  findRecoveryPreset,
  getReviewSetupGuidance,
  isBillingRecoveryCode,
  mergePolledScans,
  mergeResolvedOffPageScans,
  missingActiveScanIds,
  nextActiveScanPollInterval,
  scanRecoveryHref,
} from "./scans-client.utils"

describe("active-scan poll backoff", () => {
  // The backoff ramp must check the one-minute bound before the five-minute
  // bound — otherwise the medium interval is unreachable and the list stays
  // on the fast interval for five minutes before jumping straight to slow.
  it.each([
    [0, 10_000],
    [90_000, 30_000],
    [400_000, 60_000],
  ])("elapsed %i ms schedules the next poll in %i ms", (elapsedMs, intervalMs) => {
    expect(nextActiveScanPollInterval(elapsedMs)).toBe(intervalMs)
  })

  it("keeps the boundaries on the intended side of each phase", () => {
    expect(nextActiveScanPollInterval(59_999)).toBe(10_000)
    expect(nextActiveScanPollInterval(60_000)).toBe(30_000)
    expect(nextActiveScanPollInterval(299_999)).toBe(30_000)
    expect(nextActiveScanPollInterval(300_000)).toBe(60_000)
  })
})

describe("scan polling", () => {
  it("updates the first page while preserving older paginated scans", () => {
    const current = [
      { id: "new", status: "RUNNING" },
      { id: "old", status: "COMPLETED" },
    ]
    const refreshed = [
      { id: "latest", status: "QUEUED" },
      { id: "new", status: "COMPLETED" },
    ]

    expect(mergePolledScans(current, refreshed, { hasMore: true })).toEqual([
      { id: "latest", status: "QUEUED" },
      { id: "new", status: "COMPLETED" },
      { id: "old", status: "COMPLETED" },
    ])
  })

  it("preserves an omitted active row when the refreshed page is incomplete", () => {
    const current = [
      { id: "running", status: "RUNNING" },
      { id: "old", status: "COMPLETED" },
    ]

    expect(mergePolledScans(current, [], { hasMore: true })).toEqual(current)
  })

  it("drops an omitted active row only when the refreshed page is complete", () => {
    const current = [
      { id: "running", status: "RUNNING" },
      { id: "old", status: "COMPLETED" },
    ]

    expect(mergePolledScans(current, [], { hasMore: false })).toEqual([
      { id: "old", status: "COMPLETED" },
    ])
  })

  it("bounds off-page active status refreshes to IDs missing from an incomplete first page", () => {
    const current = [
      { id: "first", status: "QUEUED" },
      { id: "off-page", status: "VERIFYING" },
      { id: "complete", status: "COMPLETED" },
    ]

    expect(missingActiveScanIds(current, new Set(["first"]), true)).toEqual(["off-page"])
    expect(missingActiveScanIds(current, new Set(["first"]), false)).toEqual([])
  })

  it("updates resolved off-page scans in place and removes scoped IDs that no longer exist", () => {
    const current = [
      { id: "first", status: "QUEUED" },
      { id: "completed", status: "RUNNING" },
      { id: "deleted", status: "VERIFYING" },
    ]

    expect(
      mergeResolvedOffPageScans(
        current,
        [{ id: "completed", status: "COMPLETED" }],
        ["completed", "deleted"]
      )
    ).toEqual([
      { id: "first", status: "QUEUED" },
      { id: "completed", status: "COMPLETED" },
    ])
  })
})

describe("scan recovery", () => {
  it("prefills the existing creation flow without starting a scan", () => {
    expect(scanRecoveryHref({ targetId: "target/1", goal: "TEST_APP", mode: "STANDARD" })).toBe(
      "/dashboard/scans?new=1&target=target%2F1&goal=TEST_APP&mode=STANDARD"
    )
  })

  it("only restores an available option matching the prior goal and mode", () => {
    const options = [
      { id: "safe", available: true, goal: "LAUNCH_REVIEW", mode: "SAFE" },
      { id: "deep", available: false, goal: "FULL_PENTEST", mode: "DEEP" },
    ]

    expect(findRecoveryPreset(options, "LAUNCH_REVIEW", "SAFE")).toBe("safe")
    expect(findRecoveryPreset(options, "FULL_PENTEST", "DEEP")).toBe("")
  })

  it.each(["NO_MINUTES_REMAINING", "TRIAL_EXPIRED", "DEEP_NOT_ALLOWED"])(
    "routes %s to billing recovery",
    (code) => expect(isBillingRecoveryCode(code)).toBe(true)
  )

  it("keeps transient API errors out of billing recovery", () => {
    expect(isBillingRecoveryCode("RATE_LIMITED")).toBe(false)
    expect(isBillingRecoveryCode(null)).toBe(false)
  })
})

describe("review setup guidance", () => {
  it("gives an API target without a specification one direct unlock action", () => {
    expect(
      getReviewSetupGuidance({
        targetId: "target-1",
        targetType: "API",
        hasApiSpec: false,
      })
    ).toEqual({
      actionLabel: "Add OpenAPI document",
      href: "/dashboard/targets/target-1",
      message: "Add an OpenAPI document to unlock Contract and Contract Behavior reviews.",
    })
  })

  it("does not show setup guidance when every available review is already configured", () => {
    expect(
      getReviewSetupGuidance({
        targetId: "target-1",
        targetType: "API",
        hasApiSpec: true,
      })
    ).toBeNull()
  })
})
