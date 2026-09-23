import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { isMyraAllowedEmail, myraDashboardAllowed, normalizeMyraAllowedEmails } from "./myra-access"

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

  it("gates the dashboard on verified email, not the old launch allowlist", () => {
    const allowlist = normalizeMyraAllowedEmails("ankit@lyrashieldai.com")
    expect(
      myraDashboardAllowed({
        email: "ankit@lyrashieldai.com",
        emailVerified: true,
        allowlist,
      })
    ).toBe(true)
    // An unverified email fails even when it is on the old allowlist.
    expect(
      myraDashboardAllowed({
        email: "ankit@lyrashieldai.com",
        emailVerified: false,
        allowlist,
      })
    ).toBe(false)
    expect(
      myraDashboardAllowed({
        email: "other@example.com",
        emailVerified: true,
        allowlist,
      })
    ).toBe(true)
    expect(
      myraDashboardAllowed({
        email: "ankit@lyrashieldai.com",
        emailVerified: true,
        allowlist: "",
      })
    ).toBe(true)
  })

  it("is the single gate shared by the dashboard layout and the API principal gate", () => {
    const read = (path: string) =>
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      readFileSync(new URL(path, import.meta.url), "utf8")
    const layout = read("../../../apps/web/src/app/(dashboard)/layout.tsx")
    const lib = read("../../../apps/web/src/app/api/myra/_lib.ts")
    // The UI mount and the API gate must not drift into two rules again.
    expect(layout).toContain("myraDashboardAllowed")
    expect(layout).toContain("emailVerified")
    expect(lib).toContain("myraDashboardAllowed")
  })
})
