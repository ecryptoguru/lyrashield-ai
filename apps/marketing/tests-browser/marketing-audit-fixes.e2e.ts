import { expect, test } from "@playwright/test"

test("search finds guides outside the current pagination slice and recovers from no results", async ({
  page,
}) => {
  await page.goto("/blog")
  const search = page.getByLabel("Search all published guides")
  await search.fill("Supabase")
  await expect(page.locator("#guide-results a[href='/blog/supabase-security-guide']")).toBeVisible()
  await expect(page.locator("[data-blog-browse]")).toBeHidden()
  await search.fill("unmatched-guide-query-4829")
  await expect(page.locator("[data-guide-empty]")).toBeVisible()
  await expect(page.locator("[data-guide-count]")).toContainText("0 guides")
  await page.getByRole("button", { name: "Clear search" }).click()
  await expect(search).toBeFocused()
  await expect(page.locator("[data-blog-browse]")).toBeVisible()
  await expect(page.locator("#guide-results")).toBeHidden()
})

test("category browsing is compact, searchable and restores all guides", async ({ page }) => {
  await page.goto("/blog/tags/access-control")
  const rows = page.locator("[data-guide-entry]")
  const total = await rows.count()
  expect(total).toBeGreaterThan(10)
  await expect(page.locator("#guide-results img")).toHaveCount(0)
  await page.getByLabel("Search this category").fill("Supabase")
  await expect(page.locator("#guide-results a[href='/blog/supabase-security-guide']")).toBeVisible()
  await page.getByRole("button", { name: "Clear search" }).click()
  expect(await rows.filter({ visible: true }).count()).toBe(total)
})

test("article TOC leaves the destination below the fixed header", async ({ page }) => {
  await page.goto("/blog/supabase-security-guide")
  const mobileToc = page.locator(".blog-post__mobile-toc")
  const mobile = await mobileToc.isVisible()
  if (mobile) await mobileToc.locator("summary").click()
  const tocLink = page.locator(mobile ? ".blog-post__mobile-toc a" : ".blog-post__toc a").first()
  const href = await tocLink.getAttribute("href")
  expect(href).toBeTruthy()
  await tocLink.click()
  await expect
    .poll(async () => page.locator(href!).evaluate((el) => el.getBoundingClientRect().top))
    .toBeGreaterThanOrEqual(65)
})

test("homepage has one authorized Lite URL entry and a sample explanation", async ({ page }) => {
  await page.goto("/")
  await expect(page.locator("#hero-lite-form")).toHaveCount(1)
  await expect(page.locator("#home-lite-scan-form")).toHaveCount(0)
  await expect(page.getByRole("link", { name: "See a sample Lite result" })).toHaveAttribute(
    "href",
    "#free-scan"
  )
  await expect(page.locator("#hero-scan-authorized")).toBeAttached()
})

test("Myra stays above the mobile CTA and the CTA clears focused inputs", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  // Local app URLs are deliberately excluded by marketing CSP. Stub the
  // capability response at fetch, as the existing Myra browser suite does.
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window)
    window.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      if (url.endsWith("/api/myra/status"))
        return Promise.resolve(Response.json({ public: true, booking: false }))
      return originalFetch(input, init)
    }
  })
  await page.goto("/")
  await page.evaluate(() => window.scrollTo(0, 1600))
  const bar = page.locator("[data-sticky-cta]")
  const launcher = page.locator("#myra-launcher")
  await expect(bar).toBeVisible()
  await expect(launcher).toBeVisible()
  const bounds = await Promise.all([bar.boundingBox(), launcher.boundingBox()])
  expect(bounds[1]!.y + bounds[1]!.height).toBeLessThan(bounds[0]!.y)
  // The local preview intentionally disables scanner inputs. Enable this
  // fixture only to exercise focus coordination without submitting a scan.
  await page.locator("#hero-scan-url").evaluate((input: HTMLInputElement) => {
    input.disabled = false
    input.focus({ preventScroll: true })
  })
  await expect(bar).toBeHidden()
})

test("mobile comparison tables scroll without squeezing prose or widening the page", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/compare/snyk")
  const result = await page
    .locator(".compare-body table")
    .first()
    .evaluate((table) => ({
      scrolls: table.scrollWidth > table.clientWidth,
      cellWidth: table.querySelectorAll("td")[1]?.getBoundingClientRect().width,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }))
  expect(result.scrolls).toBe(true)
  expect(result.cellWidth).toBeGreaterThanOrEqual(200)
  expect(result.overflow).toBeLessThanOrEqual(1)
})

test("SQL warnings have explicit attention and synthetic examples populate the input", async ({
  page,
}) => {
  await page.goto("/tools/supabase-rls-checker")
  await page.getByRole("button", { name: "Load example SQL" }).click()
  await expect(page.locator("#sql-input")).toHaveValue(/auth.uid\(\)/)
  await page
    .locator("#sql-input")
    .fill(
      "alter table public.projects enable row level security; create policy public_read on public.projects using (true);"
    )
  await page.getByRole("button", { name: "Review SQL locally" }).click()
  await expect(page.locator("#tool-result")).toContainText("USING (true)")
  const warning = page.locator("#tool-result li").filter({ hasText: "USING (true)" })
  expect(await warning.evaluate((el) => (el as HTMLElement).style.borderLeftColor)).toBe(
    "var(--danger)"
  )
})

for (const sample of [
  { route: "security-headers-checker", button: "Load example headers", input: "#headers-input" },
  { route: "jwt-session-inspector", button: "Load example JWT and cookie", input: "#jwt-input" },
]) {
  test(`${sample.route} loads clearly synthetic input`, async ({ page }) => {
    await page.goto(`/tools/${sample.route}`)
    await page.getByRole("button", { name: sample.button }).click()
    await expect(page.locator(sample.input)).not.toHaveValue("")
    await expect(page.locator(sample.input)).toBeFocused()
  })
}

test("no-finding local code results do not display urgent finding actions", async ({ page }) => {
  await page.goto("/tools/ai-app-security-scanner")
  await page.locator("#ai-app-paste-tab").click()
  await page.locator("#ai-app-paste").fill("export function hello() { return 'Hello, world'; }")
  await page.locator("#ai-app-run").click()
  const result = page.locator("#ai-app-result")
  await expect(result).toContainText(/no finding/i)
  await expect(result).toContainText("Control guidance (not a finding)")
  await expect(result).not.toContainText("Finding action:")
  await expect(result).not.toContainText("CRITICAL")
  await expect(result).not.toContainText("HIGH")
})

test("WebMCP safe sample separates general control guidance from findings", async ({ page }) => {
  await page.goto("/tools/webmcp-security-checker")
  await page.locator("#webmcp-load-safe").click()
  await page.locator("#webmcp-run").click()
  const result = page.locator("#webmcp-result")
  await expect(result).toContainText("Control guidance (not a finding)")
  await expect(result).not.toContainText("Finding action:")
})

test("product captures retain their full aspect ratios and phone previews explain panning", async ({
  page,
}) => {
  await page.goto("/")
  await page.locator("#product-preview").scrollIntoViewIfNeeded()
  const images = page.locator(".hero-frame__img:visible")
  await expect(images).toHaveCount(1)
  for (const image of await images.all()) {
    await expect
      .poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth))
      .toBeGreaterThan(0)
    const proportions = await image.evaluate((node: HTMLImageElement) => ({
      rendered: node.getBoundingClientRect().width / node.getBoundingClientRect().height,
      source: node.naturalWidth / node.naturalHeight,
    }))
    expect(Math.abs(proportions.rendered - proportions.source)).toBeLessThan(0.03)
  }
  await page.setViewportSize({ width: 320, height: 844 })
  await page.getByRole("button", { name: "Findings", exact: true }).click()
  await page.getByRole("button", { name: "Expand Findings preview" }).click()
  await expect(page.getByRole("heading", { name: "Findings preview", exact: true })).toBeVisible()
  await expect(page.locator("#product-preview-hint")).toBeVisible()
  const region = page.getByRole("region", { name: "Enlarged product image" })
  await region.focus()
  await page.keyboard.press("ArrowRight")
  await expect.poll(() => region.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0)
  await page.keyboard.press("Escape")
  await expect(page.getByRole("button", { name: "Expand Findings preview" })).toBeFocused()
})

test("mobile sticky signup yields to the visible final signup action", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/")
  await page.evaluate(() => scrollTo({ top: innerHeight + 200, behavior: "instant" }))
  await expect(page.locator("[data-sticky-cta]")).toBeVisible()
  await page.locator('[data-cta-id="final-cta-create-account"]').scrollIntoViewIfNeeded()
  await expect(page.locator("[data-sticky-cta]")).toBeHidden()
  await page.evaluate(() => scrollTo({ top: innerHeight + 200, behavior: "instant" }))
  await expect(page.locator("[data-sticky-cta]")).toBeVisible()
})

test("methodology uses the supplied scan and finding captures in both themes", async ({ page }) => {
  await page.goto("/methodology")
  for (const theme of ["dark", "light"]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value
    }, theme)
    const images = page.locator(".product-shot--paired .product-shot__img:visible")
    await expect(images).toHaveCount(2)
    for (const image of await images.all()) {
      await image.scrollIntoViewIfNeeded()
      await expect(image).toHaveAttribute(
        "src",
        new RegExp(`current-(scan|findings)-${theme}\\.webp$`)
      )
      await expect
        .poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth))
        .toBeGreaterThan(0)
    }
  }
})

test("translucent supporting bands preserve text contrast against any film brightness", async ({
  page,
}) => {
  for (const theme of ["light", "dark"]) {
    await page
      .context()
      .addCookies([{ name: "lyrashield-theme", value: theme, domain: "127.0.0.1", path: "/" }])
    await page.goto("/")
    for (const selector of ["#different", "#free-scan"]) {
      const ratios = await page.locator(selector).evaluate((surface) => {
        const canvas = document.createElement("canvas")
        canvas.width = canvas.height = 1
        const ctx = canvas.getContext("2d")!
        const read = (color: string, under = "#000") => {
          ctx.fillStyle = under
          ctx.fillRect(0, 0, 1, 1)
          ctx.fillStyle = color
          ctx.fillRect(0, 0, 1, 1)
          return Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3)
        }
        const luminance = (rgb: number[]) =>
          rgb.reduce((sum, channel, i) => {
            const c = channel / 255
            return (
              sum +
              (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4) *
                [0.2126, 0.7152, 0.0722][i]!
            )
          }, 0)
        const foreground = luminance(
          read(getComputedStyle(surface).getPropertyValue("--text-muted"))
        )
        return ["#000", "#fff"].map((under) => {
          const background = luminance(read(getComputedStyle(surface).backgroundColor, under))
          return (
            (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)
          )
        })
      })
      expect(Math.min(...ratios)).toBeGreaterThanOrEqual(4.5)
    }
  }
})
