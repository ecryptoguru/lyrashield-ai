import { describe, expect, it } from "vitest"
import { createOAuthOnboardingReturn, verifyOAuthOnboardingReturn } from "./oauth-onboarding-return"

const QUERY = "client_id=agent-123&response_type=code&scope=lyrashield.read&state=abc"

describe("OAuth onboarding return state (W2-05)", () => {
  it("round-trips the authorization query and binding user", () => {
    const state = createOAuthOnboardingReturn(QUERY, "user_1")
    const result = verifyOAuthOnboardingReturn(state)
    expect(result.valid).toBe(true)
    if (result.valid) {
      expect(result.oauthQuery).toBe(QUERY)
      expect(result.userId).toBe("user_1")
    }
  })

  it("rejects a swapped user binding", () => {
    const state = createOAuthOnboardingReturn(QUERY, "user_1")
    const [, , nonce, exp, sig] = state.split(".")
    const otherUser = Buffer.from("user_2").toString("base64url")
    const forged = `${Buffer.from(QUERY).toString("base64url")}.${otherUser}.${nonce}.${exp}.${sig}`
    expect(verifyOAuthOnboardingReturn(forged)).toEqual({
      valid: false,
      reason: "bad_signature",
    })
  })

  it("expires", () => {
    const state = createOAuthOnboardingReturn(QUERY, "user_1", 1_000)
    expect(verifyOAuthOnboardingReturn(state, 15 * 60 * 1000 + 2_000).valid).toBe(false)
  })

  it("rejects malformed input without throwing", () => {
    expect(verifyOAuthOnboardingReturn("")).toEqual({ valid: false, reason: "malformed" })
    expect(verifyOAuthOnboardingReturn("a.b.c")).toEqual({ valid: false, reason: "malformed" })
    expect(verifyOAuthOnboardingReturn("x.y.z.w.v")).toEqual({
      valid: false,
      reason: "bad_signature",
    })
  })
})
