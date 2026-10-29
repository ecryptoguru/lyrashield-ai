import { expect, test } from "@playwright/test"
import { mkdirSync, writeFileSync } from "node:fs"

// Capture both sides at identical widths. Baseline mode is opt-in and never
// changes expected production behavior or substitutes synthetic media evidence.
test("recovered homepage reveals cinema and keeps mobile controls usable", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "chromium", "The matrix supplies its own viewports")
  test.setTimeout(120000)
  const phase = process.env.LANDING_BASELINE === "1" ? "before" : "after"
  const output = `../../output/playwright/premium-landing/${phase}`
  mkdirSync(output, { recursive: true })
  const results: unknown[] = []
  for (const width of [360, 390, 768, 1280, 1440]) {
    for (const theme of ["dark", "light"]) {
      await page.setViewportSize({ width, height: width < 1024 ? 844 : 900 })
      await page.addInitScript((value) => localStorage.setItem("lyra-theme", value), theme)
      await page.goto(phase === "before" ? "https://lyrashieldai.com/" : "/")
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value
      }, theme)
      await page.evaluate(() => document.fonts.ready)
      const metrics = await page.evaluate(() => {
        const main = document.querySelector("main")!
        const text = (main as HTMLElement).innerText.replace(
          main.querySelector<HTMLElement>("#cloud-plans")?.innerText ?? "",
          ""
        )
        return {
          width: innerWidth,
          pageHeight: document.documentElement.scrollHeight,
          visibleWordsExcludingPricing: text.trim().split(/\s+/).length,
          overflow: document.documentElement.scrollWidth - innerWidth,
          ctaBottom: document.querySelector(".premium-hero__primary")!.getBoundingClientRect()
            .bottom,
        }
      })
      results.push({ theme, ...metrics })
      expect(metrics.overflow).toBeLessThanOrEqual(1)
      if (phase === "after") {
        // Recovery restores the original scroll distance; compression budgets
        // from the withdrawn redesign must not shorten the cinematic timeline.
        if (width < 1024) {
          const window = await page
            .locator(".premium-hero__content")
            .evaluate((el) => parseFloat(getComputedStyle(el).paddingTop))
          expect(window).toBeGreaterThanOrEqual(112)
          await expect(page.locator(".premium-hero__veil")).toHaveCSS("background-image", "none")
        }
        if (width === 390) expect(metrics.ctaBottom).toBeLessThan(844)
      }
      await page.screenshot({ path: `${output}/${width}-${theme}.png`, fullPage: true })
      if (width === 390 || width === 1440)
        await page.screenshot({ path: `${output}/hero-${width}-${theme}.png` })
    }
  }
  writeFileSync(`${output}/layout.json`, JSON.stringify(results, null, 2))
})

test("homepage answers and structured data agree without JavaScript", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false })
  const page = await context.newPage()
  await page.goto("http://127.0.0.1:8787/")
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1)
  const faq = page.locator("#faq details")
  const entities = await page.locator('script[type="application/ld+json"]').allTextContents()
  const flatten = (value: unknown): Record<string, unknown>[] => {
    if (Array.isArray(value)) return value.flatMap(flatten)
    if (!value || typeof value !== "object") return []
    const object = value as Record<string, unknown>
    return [object, ...flatten(object["@graph"])]
  }
  const nodes = entities.flatMap((entity) => flatten(JSON.parse(entity)))
  const faqSchema = nodes.find((node) => node["@type"] === "FAQPage")!
  const questions = faqSchema.mainEntity as { name: string; acceptedAnswer: { text: string } }[]
  expect(questions.length).toBeGreaterThan(0)
  await expect(faq).toHaveCount(questions.length)
  for (const [index, question] of questions.entries()) {
    await expect(faq.nth(index).locator("summary")).toHaveText(question.name)
    expect(await faq.nth(index).locator("p").textContent()).toBe(question.acceptedAnswer.text)
  }
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    "href",
    "https://lyrashieldai.com/"
  )
  await expect(page.locator('#free-scan a[href="/scan"]').first()).toBeVisible()
  await expect(page.locator("[data-journey-chapter]")).toHaveCount(7)
  await context.close()
})

test("local text compression preserves HTML and leaves video ranges byte-identical", async ({
  request,
}) => {
  const identity = await request.get("/", { headers: { "Accept-Encoding": "identity" } })
  const expected = await identity.body()
  for (const encoding of ["br", "gzip"]) {
    const compressed = await request.get("/", { headers: { "Accept-Encoding": encoding } })
    expect(compressed.headers()["content-encoding"]).toBe(encoding)
    expect(compressed.headers().vary).toContain("Accept-Encoding")
    expect(await compressed.body()).toEqual(expected)
  }
  const media = "/media-local/assurance-world/v3/local/desktop/assurance-world.mp4"
  const original = await request.get(media, {
    headers: { Range: "bytes=0-1023", "Accept-Encoding": "identity" },
  })
  const ranged = await request.get(media, {
    headers: { Range: "bytes=0-1023", "Accept-Encoding": "br" },
  })
  expect(ranged.status()).toBe(206)
  expect(ranged.headers()["content-encoding"]).toBeUndefined()
  expect((await ranged.body()).length).toBe(1024)
  expect(await ranged.body()).toEqual(await original.body())
})
