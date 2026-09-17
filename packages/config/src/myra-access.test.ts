import { describe, expect, it } from "vitest"
import { isMyraAllowedEmail, normalizeMyraAllowedEmails } from "./myra-access"

describe("Myra account allowlist", () => {
  it("normalizes email casing and grants exact membership only", () => {
    const allowlist = normalizeMyraAllowedEmails(" Ankit@LyraShieldAI.com ")
    expect(allowlist).toBe("ankit@lyrashieldai.com")
    expect(isMyraAllowedEmail("ANKIT@lyrashieldai.com", allowlist)).toBe(true)
    expect(isMyraAllowedEmail("ecryptoguru@gmail.com", allowlist)).toBe(false)
  })

  it("rejects malformed and duplicate entries", () => {
    expect(() => normalizeMyraAllowedEmails("not-an-email")).toThrow("unique, valid")
    expect(() => normalizeMyraAllowedEmails("a@example.com,A@example.com")).toThrow("unique, valid")
  })
})
