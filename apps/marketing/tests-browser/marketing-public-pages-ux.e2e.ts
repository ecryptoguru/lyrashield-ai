import { expect, test } from "@playwright/test"
import { mkdirSync } from "node:fs"

// Explicitly replace expected anonymous reads; no booking, account, scan or
// subscription mutation reaches production during these local acceptance tests.
test.beforeEach(async ({ page }) => {
  await page.route("https://app.lyrashieldai.com/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname
    const origin = route.request().headers().origin ?? "http://127.0.0.1:8787"
    await route.fulfill({
      status: pathname.endsWith("/preferences") ? 401 : 200,
      headers: {
        "access-control-allow-origin": origin,
        "access-control-allow-credentials": "true",
        "content-type": "application/json",
      },
      body: JSON.stringify(
        pathname.endsWith("/status") ? { public: false, booking: false } : { success: false }
      ),
    })
  })
})

const routes = [
  "/blog",
  "/blog/check-php-version-php2shell",
  "/blog/tags/verification",
  "/blog/2",
  "/docs/integrations/openai-codex",
  "/pricing",
  "/methodology",
  "/evidence-vault",
  "/agents",
  "/webmcp",
  "/research",
  "/ai-safety",
  "/about",
  "/demo",
  "/support",
  "/compare/snyk",
  "/privacy",
  "/terms",
  "/terms-of-sale",
  "/tools/supabase-rls-checker",
]
for (const path of routes) {
  test(`public page layout and themes: ${path}`, async ({ page }, info) => {
    test.skip(
      /mobile|phone/.test(info.project.name),
      "The matrix supplies its own mobile viewports"
    )
    test.setTimeout(120000)
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    const widths = info.project.name.includes("webkit") ? [390, 1280] : [360, 390, 768, 1280, 1440]
    for (const width of widths) {
      await page.setViewportSize({ width, height: 844 })
      for (const theme of ["dark", "light"]) {
        await page.emulateMedia({ colorScheme: theme as "dark" | "light" })
        const response = await page.goto(path)
        expect(response?.status()).toBe(200)
        await page.evaluate(() => document.fonts.ready)
        await expect(page.locator("h1")).toHaveCount(1)
        await expect(page.locator("h1")).toBeVisible()
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
          JSON.stringify(
            await page.evaluate(() =>
              Array.from(document.querySelectorAll("body *"))
                .filter((el) => el.getBoundingClientRect().right > innerWidth + 1)
                .slice(0, 8)
                .map((el) => ({
                  tag: el.tagName,
                  class: el.className,
                  width: el.getBoundingClientRect().width,
                }))
            )
          )
        ).toBeLessThanOrEqual(1)
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme)
        if (
          [
            "/blog",
            "/blog/check-php-version-php2shell",
            "/docs/integrations/openai-codex",
            "/pricing",
          ].includes(path) &&
          [390, 1440].includes(width)
        ) {
          mkdirSync("../../output/playwright/public-pages-after", { recursive: true })
          await page.screenshot({
            path: `../../output/playwright/public-pages-after/${path.slice(1).replaceAll("/", "-")}-${width}-${theme}.png`,
          })
        }
      }
    }
    expect(errors).toEqual([])
  })
}

test("blog feature is text-first and article starts before artwork", async ({ page }, info) => {
  await page.goto("/blog")
  const card = page.locator(".blog-card--featured")
  const first = await card.locator(":scope > *").first().getAttribute("class")
  expect(first).toBe("blog-card__story")
  const read = card.getByRole("link", { name: /^Read article:/ })
  await expect(read).toBeVisible()
  mkdirSync("../../output/playwright/public-pages-after", { recursive: true })
  await card.screenshot({
    path: `../../output/playwright/public-pages-after/blog-feature-${info.project.name}.png`,
    animations: "disabled",
  })
  await page.getByRole("searchbox").fill("php2shell")
  await expect(page.locator("#guide-results")).toBeVisible()
  const date = await page
    .locator("[data-guide-entry]")
    .filter({ hasText: "How to check your PHP version" })
    .first()
    .locator("span")
    .first()
    .textContent()
  await page.getByRole("button", { name: "Clear search" }).click()
  await expect(card).toBeVisible()
  await page.goto("/blog/check-php-version-php2shell")
  expect(date).toContain("Oct 24, 2026")
  await expect(page.locator(".blog-post__meta")).toContainText("October 24, 2026")
  const content = await page.locator(".blog-post__content").boundingBox()
  const image = await page.locator(".blog-post__hero").boundingBox()
  expect(content!.y).toBeLessThan(image!.y)
  await page.locator(".blog-post__hero").scrollIntoViewIfNeeded()
  await expect
    .poll(() =>
      page.locator(".blog-post__hero img").evaluate((img: HTMLImageElement) => img.currentSrc)
    )
    .toMatch(/hero-(480|960)\.(avif|webp)|hero\.(avif|webp)/)
  await expect
    .poll(() =>
      page.locator(".blog-post__hero img").evaluate((img: HTMLImageElement) => img.naturalWidth)
    )
    .toBeGreaterThan(0)
})

test("archives have distinct canonicals and bounded linked browsing", async ({ page }) => {
  await page.goto("/blog/2")
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    "href",
    "https://lyrashieldai.com/blog/2"
  )
  await expect(page.locator('meta[name="robots"]')).not.toHaveAttribute("content", /noindex/)
  await page.goto("/blog/tags/verification")
  const items = page.locator(".tag-index__articles > li")
  expect(await items.count()).toBeLessThanOrEqual(20)
  const next = page
    .getByRole("navigation", { name: "Category pages" })
    .getByRole("link", { name: "Next page" })
  if (await next.count()) {
    await next.click()
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      "href",
      /\/blog\/tags\/verification\/2$/
    )
    await expect(page.getByRole("link", { name: "Previous page" })).toBeVisible()
  }
})

test("docs navigation stays bounded and copy announces success", async ({ page, browserName }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  if (browserName === "chromium")
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"])
  else
    await page.addInitScript(() =>
      Object.defineProperty(navigator, "clipboard", { value: { writeText: async () => {} } })
    )
  await page.goto("/docs/integrations/openai-codex")
  const browse = page.locator(".docs-sidebar__browse")
  await browse.locator(":scope > summary").click()
  await expect(page.locator(".docs-sidebar__current")).toBeVisible()
  expect((await page.locator(".docs-sidebar nav").boundingBox())!.height).toBeLessThanOrEqual(465)
  await page.getByRole("searchbox", { name: "Find a guide or integration" }).fill("OAuth")
  await expect(page.locator("[data-docs-empty]")).toContainText("No guide or client name matches")
  await page.getByRole("button", { name: "Back to this guide" }).click()
  await expect(browse).not.toHaveAttribute("open", "")
  await page.getByRole("button", { name: "Copy code to clipboard" }).first().click()
  await expect(page.locator("[data-code-copy-status]")).toHaveText("Code copied to clipboard.")
})

test("docs copy failure selects code and announces manual recovery", async ({ page }) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async () => {
          throw new Error("blocked")
        },
      },
    })
  )
  await page.goto("/docs/integrations/openai-codex")
  await page.getByRole("button", { name: "Copy code to clipboard" }).first().click()
  await expect(page.locator("[data-code-copy-status]")).toContainText(
    "Clipboard unavailable. Code selected"
  )
  expect(await page.evaluate(() => window.getSelection()?.toString().length ?? 0)).toBeGreaterThan(
    0
  )
})

test("local file selection cap and partial review are explicit", async ({ page }) => {
  await page.goto("/tools/secret-exposure-scanner")
  const input = page.locator("#secret-files")
  await expect(input).toBeEnabled()
  await input.setInputFiles(
    Array.from({ length: 21 }, (_, i) => ({
      name: `synthetic-${i}.txt`,
      mimeType: "text/plain",
      buffer: Buffer.from("ordinary text"),
    }))
  )
  await expect(page.locator("#tool-result")).toContainText("21 files selected; 0 scanned")
  await input.setInputFiles([
    { name: "ok.txt", mimeType: "text/plain", buffer: Buffer.from("ordinary text") },
    { name: "binary.txt", mimeType: "text/plain", buffer: Buffer.from([0, 1, 2]) },
  ])
  await expect(page.locator("#tool-result")).toContainText(
    "2 selected; 1 scanned; 1 skipped. Partial review"
  )
  await expect(page.locator("#tool-result")).not.toHaveAttribute("aria-busy", "true")
})

test("no-script tools explain availability and remain inert", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false })
  const page = await context.newPage()
  await page.goto("http://127.0.0.1:8787/tools/supabase-rls-checker")
  await expect(page.getByText(/Interactive checks need JavaScript to run locally/)).toBeVisible()
  await expect(page.getByRole("button", { name: "Review SQL locally" })).toBeDisabled()
  await expect(page.locator("#tool-result")).toContainText("Results appear here")
  await page.goto("http://127.0.0.1:8787/blog/tags/verification")
  await expect(page.locator(".tag-index__articles > li").first()).toBeVisible()
  await context.close()
})

test("pricing definitions, contact fallback and policy navigation are reachable", async ({
  page,
}) => {
  await page.goto("/pricing")
  await page.getByRole("link", { name: "How minutes are counted" }).click()
  await expect(page.locator("#minute-definition")).toBeInViewport()
  await expect(page.getByRole("button", { name: /Local.*Launching later/ })).toBeAttached()
  await page.goto("/demo")
  await expect(page.locator("[data-demo-contact]")).toContainText("@")
  await expect(page.getByRole("link", { name: "Request a time", exact: true })).toHaveAttribute(
    "href",
    /body=.*timezone/i
  )
  for (const path of ["/privacy", "/terms", "/terms-of-sale"]) {
    await page.goto(path)
    await page.getByText("On this page", { exact: true }).click()
    await expect(page.getByRole("navigation", { name: "Policy sections" })).toBeVisible()
    const link = page.getByRole("navigation", { name: "Policy sections" }).getByRole("link").first()
    const href = await link.getAttribute("href")
    await link.click()
    await expect(page.locator(href!)).toBeInViewport()
  }
})

test("reading layouts retain keyboard access with reduced motion and enlarged text", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  for (const path of [
    "/blog",
    "/blog/tags/verification",
    "/blog/tags/agent-security",
    "/docs/integrations/openai-codex",
    "/pricing",
    "/tools/supabase-rls-checker",
  ]) {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(path)
    await page.addStyleTag({ content: "html { font-size: 200% !important; }" })
    await expect(page.locator("html")).toHaveCSS("font-size", "32px")
    await page.evaluate(() => document.fonts.ready)
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
      JSON.stringify(
        await page.evaluate(() =>
          Array.from(document.querySelectorAll("body *"))
            .filter((el) => el.getBoundingClientRect().right > innerWidth + 1)
            .slice(0, 8)
            .map((el) => ({
              tag: el.tagName,
              class: el.className,
              width: el.getBoundingClientRect().width,
            }))
        )
      )
    ).toBeLessThanOrEqual(1)
    await page.keyboard.press("Tab")
    await expect(page.locator(":focus")).toBeVisible()
  }
})

test("category search states its scope without expanding the archive", async ({ page }) => {
  await page.goto("/blog/tags/verification")
  await expect(page.getByRole("searchbox", { name: "Search this category" })).toBeEnabled()
  await expect(page.getByText("Search all guides in this category.", { exact: true })).toBeVisible()
  await expect(page.locator("#guide-results")).toBeHidden()
})

test("docs search retains expanded matches across responsive breakpoints", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto("/docs/integrations/openai-codex")
  await page.locator("[data-docs-search]").fill("cursor")
  const matchingGroup = page
    .locator("[data-docs-section]")
    .filter({ has: page.locator("[data-docs-link]:not([hidden])", { hasText: "Cursor" }) })
  await expect(matchingGroup).toHaveAttribute("open", "")
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator(".docs-sidebar__summary").click()
  await expect(matchingGroup).toHaveAttribute("open", "")
  await expect(matchingGroup.getByRole("link", { name: /Cursor/ })).toBeVisible()
})
