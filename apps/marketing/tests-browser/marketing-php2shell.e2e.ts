import { test, expect } from "@playwright/test"
import { readFile } from "node:fs/promises"

const slugs = [
  "php2shell-explained",
  "check-php-version-php2shell",
  "patch-php2shell-docker-fpm-apache",
  "php2shell-wordpress-hosting",
  "php2shell-still-flagged-after-updating",
  "php2shell-investigate-earlier-compromise",
  "cve-2026-115560-session-upload-progress",
]

test("guided assessment gives actionable separate results without target traffic", async ({
  page,
}) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto("/tools/php2shell-checker")
  const submissions: string[] = []
  page.on("request", (request) => {
    if (request.method() !== "GET") submissions.push(request.url())
  })
  await page.getByRole("button", { name: "Load example", exact: true }).click()
  await page.getByRole("button", { name: "Check PHP2Shell locally" }).click()
  const results = page.getByRole("region", { name: "PHP assessment" })
  await expect(results).toBeFocused()
  await expect
    .poll(async () => Math.round((await results.boundingBox())?.y ?? -1))
    .toBeGreaterThanOrEqual(72)
  await expect(results).toContainText("Affected upstream version reported")
  await expect(results).toContainText("Reported configuration needs action")
  await expect(results).toContainText("8.4.27")
  await expect(results).toContainText("replace running containers")
  expect(submissions).toEqual([])
  expect(errors).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await expect(
    page.getByRole("link", { name: "Sign up for a Deep scan", exact: true })
  ).toHaveAttribute("href", /\/sign-up\?source=php2shell-checker(?:&|$)/)
})

test("patched thresholds retain session uncertainty and edits clear stale results", async ({
  page,
}) => {
  await page.goto("/tools/php2shell-checker")
  await page.getByLabel("Exact PHP version", { exact: false }).fill("8.4.27")
  await page.getByRole("button", { name: "Check PHP2Shell locally" }).click()
  const results = page.getByRole("region", { name: "PHP assessment" })
  await expect(results).toContainText("Original PHP2Shell patch threshold met")
  await expect(results).toContainText("Session configuration needs review")
  await expect(results).toContainText("does not verify a deployed runtime")
  await page.getByLabel("Exact PHP version", { exact: false }).fill("8.4")
  await expect(results).toBeHidden()
  await page.getByRole("button", { name: "Check PHP2Shell locally" }).click()
  await expect(results).toContainText("Enter an exact version")
  await page.getByRole("button", { name: "Reset", exact: true }).click()
  await expect(results).toBeHidden()
  await expect(page.getByLabel("Exact PHP version", { exact: false })).toHaveValue("")
})

test("assessment download carries inputs, rules and unverified state", async ({ page }) => {
  await page.goto("/tools/php2shell-checker")
  await page.getByRole("button", { name: "Load example", exact: true }).click()
  await page.getByRole("button", { name: "Check PHP2Shell locally" }).click()
  const pending = page.waitForEvent("download")
  await page.getByRole("button", { name: "Download assessment" }).click()
  const download = await pending
  expect(download.suggestedFilename()).toBe("php2shell-assessment.json")
  const path = await download.path()
  expect(path).toBeTruthy()
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Playwright supplies the temporary path of this synthetic download.
  const report = JSON.parse(await readFile(path!, "utf8"))
  expect(report.input.version).toBe("8.4.26")
  expect(report.verified).toBe(false)
  expect(report.rules).toMatch(/^php2shell-guided\//)
  expect(report.session.status).toBe("review")
})

test("clipboard rejection exposes selectable report text", async ({ page }) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async () => {
          throw new Error("denied")
        },
      },
    })
  )
  await page.goto("/tools/php2shell-checker")
  await page.getByRole("button", { name: "Check PHP2Shell locally" }).click()
  await page.getByRole("button", { name: "Copy assessment" }).click()
  await expect(page.getByLabel("Assessment text to copy manually")).toBeFocused()
  await expect(page.getByLabel("Assessment text to copy manually")).toHaveValue(/"verified": false/)
  await expect(page.locator("#php-export-status")).toContainText("Clipboard unavailable")
})

for (const outcome of ["resolve", "reject"] as const) {
  test(`a delayed clipboard ${outcome} cannot change a replacement assessment`, async ({
    page,
  }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        value: {
          writeText: () =>
            new Promise<void>((resolve, reject) => {
              Object.assign(window, {
                settleClipboard: (success: boolean) =>
                  success ? resolve() : reject(new Error("denied")),
              })
            }),
        },
      })
    })
    await page.goto("/tools/php2shell-checker")
    await page.getByRole("button", { name: "Load example", exact: true }).click()
    await page.getByRole("button", { name: "Check PHP2Shell locally" }).click()
    await page.getByRole("button", { name: "Copy assessment" }).click()
    await page.getByRole("button", { name: "Reset", exact: true }).click()
    await page.getByLabel("Exact PHP version", { exact: false }).fill("8.4.27")
    await page.getByRole("button", { name: "Check PHP2Shell locally" }).click()
    await page.evaluate((success) => {
      const testWindow = window as typeof window & { settleClipboard: (success: boolean) => void }
      testWindow.settleClipboard(success)
    }, outcome === "resolve")
    await expect(page.locator("#php-export-status")).toHaveText("")
    await expect(page.getByLabel("Assessment text to copy manually")).toBeHidden()
    await expect(page.getByRole("region", { name: "PHP assessment" })).toBeFocused()
  })
}

for (const slug of slugs) {
  test(`article ${slug} has generated imagery, metadata and conversion links`, async ({ page }) => {
    await page.goto(`/blog/${slug}`)
    await expect(page.locator("h1")).toBeVisible()
    await expect(page.locator("article time").first()).toContainText("October 24, 2026")
    const image = page.locator("article picture img").first()
    // The shared layout keeps the hero outside article on some templates.
    const hero = (await image.count())
      ? image
      : page.locator('img[src*="/images/blog/library/php2shell-"]').first()
    await expect(hero).toBeVisible()
    expect(await hero.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(
      true
    )
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      "href",
      `https://lyrashieldai.com/blog/${slug}`
    )
    expect(await page.locator(`a[href="/tools/php2shell-checker"]`).count()).toBeGreaterThan(0)
    expect(await page.locator('a[href*="/sign-up"]').count()).toBeGreaterThan(0)
    await expect(page.getByTestId("php2shell-cluster").locator('a[href^="/blog/"]')).toHaveCount(6)
    const schema = await page.locator('script[type="application/ld+json"]').allTextContents()
    expect(schema.flatMap((value) => JSON.parse(value))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          "@type": "BlogPosting",
          url: `https://lyrashieldai.com/blog/${slug}`,
        }),
      ])
    )
    expect(schema.join(" ")).toContain("FAQPage")
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
}

test("without JavaScript the checker cannot submit runtime details", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false })
  const page = await context.newPage()
  await page.goto("http://127.0.0.1:8787/tools/php2shell-checker")
  await expect(page.getByRole("button", { name: "Check PHP2Shell locally" })).toBeDisabled()
  await page.getByLabel("Exact PHP version", { exact: false }).fill("8.4.26")
  await page.getByLabel("Exact PHP version", { exact: false }).press("Enter")
  expect(new URL(page.url()).search).toBe("")
  await expect(page.getByText("If the check button stays disabled", { exact: false })).toBeVisible()
  await context.close()
})
