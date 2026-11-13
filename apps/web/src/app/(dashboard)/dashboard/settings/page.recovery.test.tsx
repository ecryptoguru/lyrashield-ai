import { renderToStaticMarkup } from "react-dom/server"
import { expect, it, vi } from "vitest"
vi.mock("@/lib/cache", () => ({
  getCachedSession: async () => ({ userId: "user" }),
  getCachedWorkspaceId: async () => "missing-workspace",
}))
vi.mock("@lyrashield/db", () => ({
  prisma: {
    user: { findUnique: async () => ({ twoFactorEnabled: false }) },
    workspace: { findUnique: async () => null },
    workspaceMember: { findUnique: async () => null },
  },
}))
vi.mock("./delete-account", () => ({ DeleteAccount: () => null }))
vi.mock("./connected-accounts", () => ({ ConnectedAccounts: () => null }))
vi.mock("./two-factor-security", () => ({ TwoFactorSecurity: () => null }))
vi.mock("./analytics-preferences", () => ({ AnalyticsPreferences: () => null }))
import SettingsPage from "./page"
it("offers recovery when the selected workspace row no longer exists", async () => {
  const html = renderToStaticMarkup(await SettingsPage())
  expect(html).toContain("This workspace is no longer available")
  expect(html).toContain('href="/onboarding"')
  expect(html).not.toContain("missing-workspace")
})
