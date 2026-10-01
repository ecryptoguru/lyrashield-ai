import { expect, test } from "@playwright/test"

test("agent onboarding distinguishes local setup and scoped hosted writes", async ({ page }) => {
  await page.goto("/agents")
  await expect(page).toHaveTitle(/coding agents/i)
  // The commands render in both the setup <pre> block and the numbered-step
  // inline <code> elements — first() avoids the strict-mode multiple match.
  await expect(page.getByText("npx --yes lyrashield@0.2.13 login --oauth").first()).toBeVisible()
  await expect(page.getByText("npx --yes lyrashield@0.2.13 init --dry-run").first()).toBeVisible()
  await expect(page.getByRole("heading", { name: "Preview local stdio setup" })).toBeVisible()
  await expect(
    page.getByText(/The second previews setup paths only; it does not write client configuration/i)
  ).toBeVisible()
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

test("manual plugin guides keep install, discovery and authentication separate", async ({
  page,
}) => {
  await page.goto("/docs/integrations/vscode-agent-plugin")
  await expect(page.getByRole("heading", { name: "Manual plugin instructions" })).toBeVisible()
  await expect(page.locator("main")).toContainText("MANUAL_REQUIRED")
  await expect(page.getByRole("link", { name: "manually configure VS Code MCP" })).toHaveAttribute(
    "href",
    "/docs/integrations/vscode"
  )
  await page.goto("/docs/integrations/github-copilot-cloud-agent")
  await expect(page.locator("main")).toContainText("copy only the reviewed, versioned")
  await expect(page.locator("main")).toContainText(".github/skills/")
  await expect(page.locator("main")).not.toContainText("enabledPlugins")
  await expect(page.locator("main")).not.toContainText("extraKnownMarketplaces")
  await expect(page.locator("main")).toContainText("connect_required")
})

test("Claude and Pi guides use current MCP setup while package releases remain pending", async ({
  page,
}) => {
  await page.goto("/docs/integrations/claude-code")
  await expect(page.getByRole("heading", { name: "Current guided setup" })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Agent Plugin release pending" })).toBeVisible()
  await expect(page.locator("main")).not.toContainText("claude plugin marketplace add")
  await expect(page.locator("main")).toContainText("@lyrashield/mcp@0.2.11")
  await page.goto("/docs/integrations/pi")
  await expect(page.locator("main")).toContainText("predates native MCP support")
  await expect(page.locator("main")).toContainText("pi mcp login lyrashield")
  await expect(page.locator("main")).toContainText("pending release")
})
