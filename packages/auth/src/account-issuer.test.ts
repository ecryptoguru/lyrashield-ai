import { describe, expect, it } from "vitest"
import { accountIssuerCompatibility, accountIssuerForCompatibility } from "./account-issuer"

const token = (payload: unknown) =>
  `e30.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`

describe("account issuer compatibility with the previous runtime", () => {
  it("keeps the compatibility field private and rejects caller control", () => {
    expect(accountIssuerCompatibility.account.additionalFields.issuer).toMatchObject({
      input: false,
      returned: false,
    })
  })

  it.each([
    ["credential", "local:credential"],
    ["github", "local:oauth:github"],
    ["google", "https://accounts.google.com"],
  ])("preserves %s account identities", (providerId, issuer) => {
    expect(accountIssuerForCompatibility({ providerId, accountId: "subject" })).toBe(issuer)
  })

  it("binds Microsoft issuer to the provider-validated directory subject", () => {
    const tid = "12345678-1234-1234-1234-123456789abc"
    const issuer = `https://login.microsoftonline.com/${tid}/v2.0`
    expect(
      accountIssuerForCompatibility({
        providerId: "microsoft",
        accountId: "directory-subject",
        idToken: token({ iss: issuer, tid, oid: "directory-subject" }),
      })
    ).toBe(issuer)
  })

  it.each([
    { providerId: "unknown", accountId: "subject" },
    { providerId: "microsoft", accountId: "subject" },
    { providerId: "microsoft", accountId: "subject", idToken: "invalid" },
    {
      providerId: "microsoft",
      accountId: "subject",
      idToken: token({ iss: "https://attacker.test", tid: "tenant", oid: "subject" }),
    },
    {
      providerId: "microsoft",
      accountId: "subject",
      idToken: token({
        iss: "https://login.microsoftonline.com/12345678-1234-1234-1234-123456789abc/v2.0",
        tid: "12345678-1234-1234-1234-123456789abc",
        oid: "different-subject",
      }),
    },
  ])("rejects an unsupported or incomplete identity without token disclosure", (account) => {
    expect(() => accountIssuerForCompatibility(account)).toThrow("Account identity is incomplete")
  })
})
