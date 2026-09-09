import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

/**
 * W2-11: Personal and Workspace settings are separate surfaces.
 *
 * `/dashboard/settings` owns the user's account (sign-in accounts, 2FA, account
 * deletion). `/dashboard/settings/workspace` owns workspace administration
 * (plan/retention, API keys, team/connections/schedules links). Administrative
 * surfaces stay behind their existing gates; the split only separates the
 * destinations, it never widens who can act.
 */
describe("settings personal/workspace split contract", () => {
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const personal = readFileSync(new URL("./page.tsx", import.meta.url), "utf8")
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const workspace = readFileSync(new URL("./workspace/page.tsx", import.meta.url), "utf8")

  it("keeps account-level surfaces on the personal page", () => {
    expect(personal).toContain("<ConnectedAccounts />")
    expect(personal).toContain("<TwoFactorSecurity")
    expect(personal).toContain("<DeleteAccount />")
  })

  it("keeps workspace administration on the workspace page", () => {
    expect(workspace).toContain("<ApiKeysSection")
    expect(workspace).toContain('href="/dashboard/team"')
    expect(workspace).toContain('href="/dashboard/connections"')
    expect(workspace).toContain('href="/dashboard/notifications"')
    expect(workspace).toContain('href="/dashboard/scans?tab=monitoring"')
  })

  it("does not leak workspace administration onto the personal page", () => {
    expect(personal).not.toContain("ApiKeysSection")
    expect(personal).not.toContain('href="/dashboard/team"')
    expect(workspace).not.toContain("<DeleteAccount")
    expect(workspace).not.toContain("<ConnectedAccounts")
    expect(workspace).not.toContain("<TwoFactorSecurity")
  })

  it("preserves the API-key admin gate on the workspace page", () => {
    expect(workspace).toContain('["OWNER", "ADMIN"].includes(membership.role)')
    expect(workspace).toContain('membership?.status === "active"')
  })

  it("links the two destinations without changing either URL contract", () => {
    expect(personal).toContain('href="/dashboard/settings/workspace"')
    expect(workspace).toContain('title: "Workspace settings"')
  })
})
