import { describe, expect, it } from "vitest"
import { APPROVED_PLATFORM_ADMIN_EMAILS, normalizePlatformAdminEmails } from "./platform-admin"

describe("platform admin email configuration", () => {
  it("accepts exactly the two approved addresses and returns canonical order", () => {
    expect(normalizePlatformAdminEmails(" AnKit@LyraShieldAI.com , ECRYPToguru@gmail.com ")).toBe(
      APPROVED_PLATFORM_ADMIN_EMAILS.join(",")
    )
  })

  it("rejects missing, duplicate, extra, aliased, and plus-addressed values", () => {
    for (const value of [
      "",
      "ecryptoguru@gmail.com",
      "ecryptoguru@gmail.com,ecryptoguru@gmail.com",
      "ecryptoguru@gmail.com,ankit@lyrashieldai.com,admin@lyrashieldai.com",
      "e.crypto.guru@gmail.com,ankit@lyrashieldai.com",
      "ecryptoguru+admin@gmail.com,ankit@lyrashieldai.com",
    ]) {
      expect(() => normalizePlatformAdminEmails(value)).toThrow(
        "PLATFORM_ADMIN_EMAILS must contain exactly the approved platform administrators"
      )
    }
  })
})
