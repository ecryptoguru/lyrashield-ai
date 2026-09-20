import { expect, test } from "@playwright/test"

test("agent onboarding distinguishes local setup and scoped hosted writes", async ({ page }) => {
  await page.goto("/agents")
  await expect(page).toHaveTitle(/coding agents/i)
  // The commands render in both the setup <pre> block and the numbered-step
  // inline <code> elements — first() avoids the strict-mode multiple match.
  await expect(page.getByText("npx lyrashield login --oauth").first()).toBeVisible()
  await expect(page.getByText("npx lyrashield init").first()).toBeVisible()
  await expect(
    page.locator("#setup").getByText(/browser-confirmed grant and execution-time checks/i)
  ).toBeVisible()
  await expect(
    page.getByRole("link", { name: /Set up LyraShield for your agent/i })
  ).toHaveAttribute("href", "/docs/integrations/agent-plugins")
})

test("mobile navigation reaches agent onboarding", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 })
  await page.goto("/")
  await page.getByRole("button", { name: "Open navigation menu" }).click()
  await page.getByRole("link", { name: "For agents" }).click()
  await expect(page).toHaveURL(/\/agents$/)
  await expect(
    page.getByRole("heading", { name: /Release assurance your coding agent can act on/i })
  ).toBeVisible()
})

// /agents.md and /llms.txt handler coverage lives in src/tests/agent-onboarding.test.ts.
// (direct GET-handler invocation): extensioned SSR endpoints self-redirect under
// `wrangler dev --local` — the assets layer normalizes `/agents.md` to
// `/agents.md/` and Astro's trailingSlash:"never" then 301s it back, looping.
// Production serves them correctly; the quirk is local-dev only.
