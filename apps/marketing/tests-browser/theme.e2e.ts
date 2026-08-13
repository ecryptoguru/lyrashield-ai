import { expect, test } from "@playwright/test"

test("cycles and synchronizes the rendered marketing theme", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" })
  await page.goto("/")

  const root = page.locator("html")
  const toggle = page.locator("#theme-toggle")
  const themeColor = page.locator("meta[data-theme-color]")
  const activeIcon = (preference: string) =>
    toggle.locator(`[data-theme-icon="${preference}"]:not(.hidden)`)

  await expect(root).toHaveAttribute("data-theme-preference", "system")
  await expect(root).toHaveAttribute("data-theme", "light")
  await expect(activeIcon("system")).toBeVisible()
  await expect(toggle).toHaveAttribute("aria-label", "System theme active. Change color theme")
  await expect(toggle).toHaveAttribute("title", "System theme")
  await expect(themeColor).toHaveAttribute("content", "#f5f9fc")

  await toggle.click()
  await expect(root).toHaveAttribute("data-theme-preference", "light")
  await expect(activeIcon("light")).toBeVisible()

  await toggle.click()
  await expect(root).toHaveAttribute("data-theme-preference", "dark")
  await expect(root).toHaveAttribute("data-theme", "dark")
  await expect(activeIcon("dark")).toBeVisible()
  await expect(themeColor).toHaveAttribute("content", "#08111c")

  await toggle.click()
  await page.emulateMedia({ colorScheme: "dark" })
  await expect(root).toHaveAttribute("data-theme-preference", "system")
  await expect(root).toHaveAttribute("data-theme", "dark")

  await page.evaluate(() =>
    dispatchEvent(new StorageEvent("storage", { key: "lyrashield-theme", newValue: "light" }))
  )
  await expect(root).toHaveAttribute("data-theme-preference", "light")
  await expect(root).toHaveAttribute("data-theme", "light")
  await expect(activeIcon("light")).toBeVisible()
  await expect(toggle).toHaveAttribute("aria-label", "Light theme active. Change color theme")
  await expect(toggle).toHaveAttribute("title", "Light theme")
  await expect(themeColor).toHaveAttribute("content", "#f5f9fc")
})

test("disconnects an incomplete motion world without a page error", async ({ page }) => {
  const errors: Error[] = []
  page.on("pageerror", (error) => errors.push(error))
  await page.goto("/")
  await page.locator("evidence-world").scrollIntoViewIfNeeded()
  await page.evaluate(async () => {
    await customElements.whenDefined("evidence-world")
    const world = document.createElement("evidence-world")
    document.body.append(world)
    world.remove()
  })
  expect(errors).toEqual([])
})
