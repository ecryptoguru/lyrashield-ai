import { expect, test } from "@playwright/test"

for (const width of [390, 1440]) {
  test(`GitHub recovery preserves retry, install-new and MCP return at ${width}px`, async ({
    page,
  }, testInfo) => {
    const requests: Record<string, unknown>[] = []
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname
      if (path === "/api/integrations/github/install") {
        requests.push(route.request().postDataJSON())
        await route.fulfill({
          status: 503,
          json: { success: false, error: { code: "TEST_RETRY", message: "Try again" } },
        })
      } else if (path === "/api/integrations/github/repos") {
        await route.fulfill({ json: { success: true, data: [] } })
      } else if (path === "/api/onboarding") {
        await route.fulfill({
          json: {
            success: true,
            data: {
              ...route.request().postDataJSON(),
              workspaceId: "ws-browser",
              updatedAt: "2026-10-26T00:00:00Z",
            },
          },
        })
      } else await route.fulfill({ json: { success: true, data: [] } })
    })
    await page.setViewportSize({ width, height: 900 })
    await page.goto("?github-connection=recovery&github=already_claimed")
    const recovery = page.getByRole("region", { name: "GitHub connection recovery" })
    await expect(recovery).toContainText("already connected")
    await expect(recovery.getByRole("link")).toHaveCount(0)
    await recovery.getByRole("button", { name: "Retry connection" }).click()
    await expect.poll(() => requests.length).toBe(1)
    expect(requests[0]).toMatchObject({
      workspaceId: "ws-browser",
      returnTo: "onboarding",
      mode: "existing",
      oauthReturnState: "signed-mcp-return-fixture",
    })
    await recovery.getByRole("button", { name: "Install on another account" }).click()
    await expect.poll(() => requests.length).toBe(2)
    expect(requests[1]).toMatchObject({
      mode: "install-new",
      oauthReturnState: "signed-mcp-return-fixture",
    })
    await page.getByRole("button", { name: "Reconnect GitHub", exact: true }).click()
    await expect.poll(() => requests.length).toBe(3)
    expect(requests[2]).toMatchObject({ mode: "existing" })
    await expect(recovery.getByRole("button", { name: "Skip for now" })).toBeEnabled()
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`github-recovery-${width}.png`) })
  })

  test(`GitHub chooser escapes labels and starts fresh proof at ${width}px`, async ({
    page,
  }, testInfo) => {
    let payload: Record<string, unknown> | undefined
    await page.route("**/api/integrations/github/install", async (route) => {
      payload = route.request().postDataJSON()
      await route.fulfill({
        json: { success: true, data: { installUrl: "http://127.0.0.1:3101/oauth-proof-fixture" } },
      })
    })
    await page.route("**/oauth-proof-fixture", (route) =>
      route.fulfill({ contentType: "text/html", body: "<h1>Fresh provider authorization</h1>" })
    )
    await page.setViewportSize({ width, height: 844 })
    await page.goto("?github-connection=choose")
    await expect(page.getByRole("button", { name: "Continue with GitHub" })).toBeDisabled()
    await expect(page.locator("img")).toHaveCount(0)
    await page.getByLabel("GitHub account").selectOption("777")
    await expect(page.getByLabel("GitHub account")).toHaveValue("777")
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`github-chooser-${width}.png`) })
    await page.getByRole("button", { name: "Continue with GitHub" }).click()
    await expect(page.getByRole("heading", { name: "Fresh provider authorization" })).toBeVisible()
    expect(payload).toEqual({
      workspaceId: "ws-browser",
      chooserState: "signed-chooser-fixture",
      selectedId: 777,
    })
  })
}

test("recovery hides connection actions when membership cannot authorize them", async ({
  page,
}) => {
  await page.route("**/api/**", (route) => route.fulfill({ json: { success: true, data: [] } }))
  await page.goto("?github-connection=recovery&github=already_claimed&member=no")
  const recovery = page.getByRole("region", { name: "GitHub connection recovery" })
  await expect(recovery.getByRole("button", { name: "Retry connection" })).toHaveCount(0)
  await expect(recovery.getByRole("button", { name: "Install on another account" })).toHaveCount(0)
  await expect(recovery.getByRole("button", { name: "Skip for now" })).toBeVisible()
})
