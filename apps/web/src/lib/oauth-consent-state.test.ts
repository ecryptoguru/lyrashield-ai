import { describe, expect, it } from "vitest"
import {
  connectionGrantMatchesConsent,
  createOAuthConsentState,
  verifyOAuthConsentState,
} from "./oauth-consent-state"

const base = {
  clientId: "client-cursor",
  scopes: ["lyrashield.read", "lyrashield.write"],
  userId: "user-1",
}

describe("oauth consent state", () => {
  it("round-trips a signed state and binds the authorization request identity", () => {
    const state = createOAuthConsentState(base, 1_000)
    const result = verifyOAuthConsentState(state, 2_000)
    expect(result.valid).toBe(true)
    if (result.valid) {
      expect(result.payload.clientId).toBe("client-cursor")
      expect(result.payload.scopes).toEqual(["lyrashield.read", "lyrashield.write"])
      expect(result.payload.userId).toBe("user-1")
    }
  })

  it("rejects a tampered payload", () => {
    const state = createOAuthConsentState(base, 1_000)
    const [encoded, sig] = state.split(".")
    const forged = Buffer.from(
      JSON.stringify({ ...base, clientId: "client-evil", exp: 2_000, nonce: "x" })
    ).toString("base64url")
    expect(verifyOAuthConsentState(`${forged}.${sig}`, 2)).toEqual({
      valid: false,
      reason: "bad_signature",
    })
    expect(encoded).toBeTruthy()
  })

  it("rejects an expired state", () => {
    const state = createOAuthConsentState(base, 1_000)
    expect(verifyOAuthConsentState(state, 1_000 + 15 * 60 * 1000 + 1).valid).toBe(false)
  })

  it("rejects malformed input", () => {
    expect(verifyOAuthConsentState("not-a-state").valid).toBe(false)
    expect(verifyOAuthConsentState("a.b.c").valid).toBe(false)
  })

  it("binds the grant to the consented client and requested scopes", () => {
    const verified = verifyOAuthConsentState(createOAuthConsentState(base, 1_000), 2_000)
    expect(verified.valid).toBe(true)
    if (!verified.valid) return

    expect(
      connectionGrantMatchesConsent(verified.payload, {
        oauthClientId: "client-cursor",
        scopes: ["lyrashield.read"],
      })
    ).toBe(true)

    // A different OAuth client never matches.
    expect(
      connectionGrantMatchesConsent(verified.payload, {
        oauthClientId: "client-other",
        scopes: ["lyrashield.read"],
      })
    ).toBe(false)

    // A write grant cannot ride on a read-only authorization request.
    expect(
      connectionGrantMatchesConsent(verified.payload, {
        oauthClientId: "client-cursor",
        scopes: ["lyrashield.read", "lyrashield.write", "extra.scope"],
      })
    ).toBe(false)
  })

  it("never lets a read-only consent state authorize a write connection", () => {
    const readOnly = createOAuthConsentState(
      { clientId: "client-cursor", scopes: ["lyrashield.read"], userId: "user-1" },
      1_000
    )
    const verified = verifyOAuthConsentState(readOnly, 2_000)
    expect(verified.valid).toBe(true)
    if (!verified.valid) return
    expect(
      connectionGrantMatchesConsent(verified.payload, {
        oauthClientId: "client-cursor",
        scopes: ["lyrashield.read", "lyrashield.write"],
      })
    ).toBe(false)
  })
})
