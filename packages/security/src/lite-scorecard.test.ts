import { describe, expect, it } from "vitest"
import { buildLiteScorecardPayload } from "./lite-scorecard"

describe("buildLiteScorecardPayload", () => {
  it("constructs a frozen, explicitly allowlisted public payload", () => {
    const payload = buildLiteScorecardPayload({
      needsAttention: 1,
      worthReviewing: 2,
      looksOk: 3,
      referralCode: "23456789",
      generatedAt: "2026-07-16T00:00:00.000Z",
      targetUrl: "https://private.example",
      secret: ["should", "never", "be", "public"].join("-"),
    } as never)
    expect(payload).toEqual({
      kind: "lite-check",
      payloadVersion: 1,
      checkVersion: "lite-2026-07-16.1",
      generatedAt: "2026-07-16T00:00:00.000Z",
      needsAttention: 1,
      worthReviewing: 2,
      looksOk: 3,
      referralCode: "23456789",
    })
    expect(JSON.stringify(payload)).not.toContain("private.example")
    expect(JSON.stringify(payload)).not.toContain("should-never-be-public")
    expect(Object.isFrozen(payload)).toBe(true)
  })

  it("rejects invalid aggregate counts and referral codes", () => {
    expect(() =>
      buildLiteScorecardPayload({ needsAttention: -1, worthReviewing: 0, looksOk: 0 })
    ).toThrow()
    expect(() =>
      buildLiteScorecardPayload({
        needsAttention: 0,
        worthReviewing: 0,
        looksOk: 0,
        referralCode: "INVALID!",
      })
    ).toThrow()
  })
})
