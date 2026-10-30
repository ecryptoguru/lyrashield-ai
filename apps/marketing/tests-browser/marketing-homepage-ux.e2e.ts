import { expect, test } from "@playwright/test"

// Keep local UX tests independent of authenticated production services.
test.beforeEach(async ({ page }) => {
  await page.route("**/api/account/preferences", (route) =>
    route.fulfill({
      status: 401,
      json: {},
      headers: {
        "access-control-allow-origin": route.request().headers().origin ?? "*",
        "access-control-allow-credentials": "true",
      },
    })
  )
  await page.route("**/api/myra/status", (route) =>
    route.fulfill({
      json: { enabled: false },
      headers: {
        "access-control-allow-origin": route.request().headers().origin ?? "*",
        "access-control-allow-credentials": "true",
      },
    })
  )
})

test("CLI copy preserves the displayed command and reports clipboard rejection", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const state = { text: "", fail: false }
    Object.assign(window, { clipboardForTest: state })
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async (text: string) => {
          if (state.fail) throw new Error("clipboard denied")
          state.text = text
        },
      },
    })
  })
  await page.goto("/")
  await page.getByText("CLI setup", { exact: true }).click()
  const command = await page.locator("[data-cli-command]").textContent()
  expect(command).toMatch(/^npx .*lyrashield.* login/)
  await page.getByRole("button", { name: "Copy command", exact: true }).click()
  await expect(page.locator("[data-copy-status]")).toHaveText("Copied")
  expect(
    await page.evaluate(
      () => (window as unknown as { clipboardForTest: { text: string } }).clipboardForTest.text
    )
  ).toBe(command)
  await page.evaluate(() => {
    ;(window as unknown as { clipboardForTest: { fail: boolean } }).clipboardForTest.fail = true
  })
  await page.getByRole("button", { name: "Copy command", exact: true }).click()
  await expect(page.locator("[data-copy-status]")).toHaveText(
    "Copy unavailable. Select the command to copy it."
  )
  await expect(page.getByRole("button", { name: "Copy command", exact: true })).toBeEnabled()
})

test("desktop disclosures dismiss on Escape, outside pointer and focus departure", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto("/")
  const details = page.locator('details[name="desktop-navigation"]').first()
  const summary = details.locator("summary")
  await summary.focus()
  await summary.press("Enter")
  await expect(details).toHaveAttribute("open", "")
  // Safari's system keyboard preference may skip links on Tab; direct focus
  // still exercises Escape from inside the disclosure on every engine.
  await details.getByRole("link").first().focus()
  await expect(details.getByRole("link").first()).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(details).not.toHaveAttribute("open", "")
  await expect(summary).toBeFocused()
  await summary.click()
  await page.locator("h1").click()
  await expect(details).not.toHaveAttribute("open", "")
  await summary.click()
  await page.locator("#theme-toggle").focus()
  await expect(details).not.toHaveAttribute("open", "")
})

for (const viewport of [
  { width: 360, height: 640 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
]) {
  test(`homepage actions and mobile navigation fit ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport)
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.goto("/")
    await expect(page).toHaveTitle(/LyraShield AI/)
    await expect(page.locator("h1")).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      viewport.width
    )
    const primary = await page.locator(".premium-hero__primary").boundingBox()
    expect(primary && primary.x >= 0 && primary.x + primary.width <= viewport.width).toBe(true)
    if (viewport.width < 1024) {
      await page.getByRole("button", { name: "Open navigation menu" }).click()
      const menu = page.getByRole("dialog", { name: "Mobile navigation" })
      await menu.getByText("Learn", { exact: true }).click()
      await menu.getByRole("link", { name: "Support", exact: true }).scrollIntoViewIfNeeded()
      const bounds = await menu.boundingBox()
      expect(bounds && bounds.y >= 0 && bounds.y + bounds.height <= viewport.height).toBe(true)
      // WebKit's IntersectionObserver reports zero for nonmodal dialog descendants.
      const support = await menu.getByRole("link", { name: "Support", exact: true }).boundingBox()
      expect(support && support.y >= 0 && support.y + support.height <= viewport.height).toBe(true)
      await page.keyboard.press("Escape")
      await expect(menu).not.toBeVisible()
    }
    await expect(page.locator("astro-error-overlay, #vite-error-overlay")).toHaveCount(0)
    expect(errors).toEqual([])
  })
}

test("enlarged text and 200 percent CSS zoom retain usable navigation and actions", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto("/")
  await page.evaluate(() => {
    document.documentElement.style.zoom = "2"
  })
  await expect(page.locator(".premium-hero__primary")).toBeVisible()
  const width = await page.evaluate(() => innerWidth)
  const primary = await page.locator(".premium-hero__primary").boundingBox()
  expect(primary && primary.x >= 0 && primary.x + primary.width <= width).toBe(true)
  await page.evaluate(() => {
    document.documentElement.style.zoom = "1"
    document.documentElement.style.fontSize = "200%"
  })
  await expect(page.getByRole("button", { name: "Open navigation menu" })).toBeVisible()
  await page.getByRole("button", { name: "Open navigation menu" }).click()
  const menu = page.getByRole("dialog", { name: "Mobile navigation" })
  await menu.getByText("Learn", { exact: true }).click()
  await menu.getByRole("link", { name: "Support", exact: true }).scrollIntoViewIfNeeded()
  const bounds = await menu.boundingBox()
  expect(bounds && bounds.y >= 0 && bounds.y + bounds.height <= 900).toBe(true)
})
