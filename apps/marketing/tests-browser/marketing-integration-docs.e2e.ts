import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { expect, test, type Page } from "@playwright/test"

const MARKETING_ORIGIN = "http://127.0.0.1:8787"
const APP_ORIGIN = new URL(process.env.PUBLIC_APP_URL || "https://app.lyrashieldai.com").origin

async function stubExpectedAnonymousAppReads(page: Page): Promise<void> {
  const corsHeaders = {
    "access-control-allow-origin": MARKETING_ORIGIN,
    "access-control-allow-credentials": "true",
    vary: "Origin",
  }

  await page.route(
    (url) => url.origin === APP_ORIGIN && url.pathname === "/api/account/preferences",
    async (route) => {
      expect(route.request().method()).toBe("GET")
      expect(route.request().headers().origin).toBe(MARKETING_ORIGIN)
      await route.fulfill({
        status: 401,
        headers: {
          ...corsHeaders,
          "cache-control": "private, no-store",
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          success: false,
          error: { code: "UNAUTHORIZED", message: "Authentication required" },
        }),
      })
    }
  )

  await page.route(
    (url) => url.origin === APP_ORIGIN && url.pathname === "/api/myra/status",
    async (route) => {
      expect(route.request().method()).toBe("GET")
      expect(route.request().headers().origin).toBe(MARKETING_ORIGIN)
      await route.fulfill({
        status: 200,
        headers: {
          ...corsHeaders,
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "Content-Type, x-myra-session",
          "cache-control": "public, max-age=60",
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({ public: false, booking: false }),
      })
    }
  )
}

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
    await stubExpectedAnonymousAppReads(page)
    const consoleErrors: string[] = []
    page.on("console", (message) => {
      if (message.type() === "error") {
        const expectedAnonymousPreference401 =
          message.text() ===
            "Failed to load resource: the server responded with a status of 401 (Unauthorized)" &&
          message.location().url === `${APP_ORIGIN}/api/account/preferences`
        // Chromium logs an HTTP 401 as a console error even when the CORS-valid
        // response is the endpoint's expected anonymous result. Keep all other
        // console errors visible to the assertion below.
        if (expectedAnonymousPreference401) return
        consoleErrors.push(message.text())
      }
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
  await stubExpectedAnonymousAppReads(page)
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
