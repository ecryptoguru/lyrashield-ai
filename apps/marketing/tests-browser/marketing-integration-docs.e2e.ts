import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { expect, test } from "@playwright/test"

const paths = [
  "/docs/integrations/pi",
  "/docs/integrations/kiro",
  "/docs/integrations/github-copilot-cloud-agent",
  "/docs/integrations/augment-vscode",
  "/docs/integrations/augment-jetbrains",
]

for (const route of paths) {
  test(`integration guide renders cleanly at desktop and mobile widths: ${route}`, async ({
    page,
  }, testInfo) => {
    const consoleErrors: string[] = []
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text())
    })
    page.on("pageerror", (error) => consoleErrors.push(error.message))

    const response = await page.goto(route)
    expect(response?.status()).toBe(200)
    await expect(page.locator("h1")).toBeVisible()
    await page.evaluate(() => document.fonts.ready)

    const sidebar = page.locator(".docs-sidebar")
    if (testInfo.project.name === "mobile") {
      await expect(sidebar.locator("summary")).toBeVisible()
      await expect(sidebar.locator("nav")).toBeHidden()
    } else {
      await expect(sidebar.locator("summary")).toBeHidden()
      await expect(sidebar.locator("nav")).toBeVisible()
    }

    const layout = await page.evaluate(() => ({
      viewport: window.innerWidth,
      pageWidth: document.documentElement.scrollWidth,
    }))
    expect(layout.pageWidth).toBeLessThanOrEqual(layout.viewport + 1)

    const screenshot = join(
      tmpdir(),
      "lyrashield-marketing-integration-smoke",
      testInfo.project.name,
      `${route.split("/").filter(Boolean).at(-1)}.png`
    )
    mkdirSync(dirname(screenshot), { recursive: true })
    await page.screenshot({ path: screenshot, fullPage: true })

    expect(consoleErrors, `${route} console errors`).toEqual([])
  })
}

test("mobile docs browse disclosure is keyboard accessible and keeps the title in view", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/docs/integrations/kiro")

  const browse = page.locator(".docs-sidebar__browse")
  const summary = browse.locator("summary")
  const title = page.locator("h1")
  await expect(summary).toBeVisible()
  await expect(summary).toHaveText("Browse documentation")
  await expect(browse).not.toHaveAttribute("open", "")
  await expect(page.locator(".docs-sidebar nav")).toBeHidden()

  const initialTitleBounds = await title.boundingBox()
  expect(initialTitleBounds).not.toBeNull()
  expect(initialTitleBounds!.y + initialTitleBounds!.height).toBeLessThanOrEqual(844)

  const screenshot = join(
    tmpdir(),
    "lyrashield-marketing-integration-smoke",
    testInfo.project.name,
    "docs-browse-initial-viewport.png"
  )
  mkdirSync(dirname(screenshot), { recursive: true })
  await page.screenshot({ path: screenshot, fullPage: false })

  await summary.focus()
  await page.keyboard.press("Enter")
  await expect(browse).toHaveAttribute("open", "")
  await expect(page.locator(".docs-sidebar nav")).toBeVisible()
  await expect(page.locator('.docs-sidebar a[aria-current="page"]')).toBeVisible()

  await page.keyboard.press("Space")
  await expect(browse).not.toHaveAttribute("open", "")
  await expect(page.locator(".docs-sidebar nav")).toBeHidden()
  await expect(title).toBeInViewport()
})
