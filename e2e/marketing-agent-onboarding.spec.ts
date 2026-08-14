import { expect, test } from "@playwright/test"

test("agent onboarding has OAuth-first setup and an explicit approval boundary", async ({
  page,
}) => {
  await page.goto("/agents")
  await expect(page).toHaveTitle(/Coding Agents/)
  await expect(page.getByText("npx lyrashield login --oauth")).toBeVisible()
  await expect(page.getByText("npx lyrashield init")).toBeVisible()
  await expect(page.getByText(/explicit human approval/i)).toBeVisible()
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

test("machine-readable onboarding response is Markdown", async ({ request }) => {
  const response = await request.get("/agents.md")
  expect(response.headers()["content-type"]).toContain("text/markdown")
  await expect(response.text()).resolves.toContain("# Release assurance for coding agents")
})

test("llms.txt publishes concrete agent setup URLs", async ({ request }) => {
  const response = await request.get("/llms.txt")
  const body = await response.text()

  expect(body).toContain("https://lyrashieldai.com/agents")
  expect(body).toContain("https://lyrashieldai.com/agents.md")
  expect(body).not.toContain("${origin}")
})
