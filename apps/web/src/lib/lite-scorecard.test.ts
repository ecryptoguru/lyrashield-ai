import { beforeEach, describe, expect, it } from "vitest"
import { buildLiteScorecardPayload } from "@lyrashield/security"
import { createLiteScorecardToken, parseLiteScorecardToken } from "./lite-scorecard"

describe("Lite scorecard tokens", () => {
  beforeEach(() => {
    process.env.BETTER_AUTH_SECRET = "test-secret-at-least-32-characters-long"
  })

  it("round-trips only the allowlisted payload", () => {
    const payload = buildLiteScorecardPayload({
      needsAttention: 1,
      worthReviewing: 2,
      looksOk: 3,
      generatedAt: "2026-07-16T00:00:00.000Z",
    })
    expect(parseLiteScorecardToken(createLiteScorecardToken(payload))).toEqual(payload)
  })

  it("rejects a modified payload", () => {
    const token = createLiteScorecardToken(
      buildLiteScorecardPayload({ needsAttention: 1, worthReviewing: 0, looksOk: 1 })
    )
    const tampered = `${token[0] === "A" ? "B" : "A"}${token.slice(1)}`
    expect(parseLiteScorecardToken(tampered)).toBeNull()
  })
})
