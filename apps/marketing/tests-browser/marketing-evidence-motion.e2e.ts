import { expect, test } from "@playwright/test"

test.beforeEach(async ({ page }, testInfo) => {
  if (testInfo.project.name === "chromium") await page.setViewportSize({ width: 1440, height: 900 })
})

for (const theme of ["dark", "light"] as const) {
  test(`one example retains uncertainty through all stages in ${theme}`, async ({ page }) => {
    await page
      .context()
      .addCookies([{ name: "lyrashield-theme", value: theme, domain: "127.0.0.1", path: "/" }])
    await page.goto("/")
    const journey = page.locator("evidence-journey")
    await expect(journey).toHaveClass(/is-enhanced/)
    const links = page
      .getByRole("navigation", { name: "Evidence journey chapters" })
      .getByRole("link")
    for (let index = 0; index < 7; index++) {
      await links.nth(index).click()
      await expect(links.nth(index)).toHaveAttribute("aria-current", "step")
      await expect(page.locator("[data-journey-scene]")).toHaveAttribute(
        "data-stage",
        String(index)
      )
      await expect(page.locator(".journey__badge")).toHaveText("Detected")
      await expect(page.locator(".journey__artifact")).toContainText("Finding EX-014")
    }
    await expect(page.locator(".journey__report")).toBeVisible()
    await expect(page.locator(".journey__report")).toContainText("Insufficient evidence")
    await expect(page.locator(".journey__report")).toContainText("Approval required")
    await expect(page.locator(".journey__report")).toContainText("Retest coverage incomplete")
    await expect(page.locator("[data-receipt-stage].is-collected")).toHaveCount(5)
    await page.locator(".journey__report").evaluate(async (element) => {
      await Promise.all(
        element
          .getAnimations({ subtree: true })
          .map((animation) => animation.finished.catch(() => {}))
      )
    })
    await page.screenshot({
      path: `../../output/playwright/evidence-motion/report-${theme}-${page.viewportSize()!.width}.png`,
    })
    await page.getByRole("link", { name: "Skip to the product preview" }).click()
    await expect(page.locator("#product-preview")).toBeInViewport()
  })

  test(`current dashboard previews expand and restore keyboard focus in ${theme}`, async ({
    page,
  }) => {
    await page
      .context()
      .addCookies([{ name: "lyrashield-theme", value: theme, domain: "127.0.0.1", path: "/" }])
    await page.goto("/")
    const triggers = page.locator("[data-product-expand]")
    for (const trigger of await triggers.all()) {
      await page
        .locator(`[data-product-select="${await trigger.getAttribute("data-product-view")}"]`)
        .click()
      await trigger.click()
      const dialog = page.getByRole("dialog", {
        name: `${await trigger.getAttribute("data-product-title")} preview`,
      })
      await expect(dialog).toBeVisible()
      const image = dialog.locator("img")
      await expect(image).toHaveAttribute("src", new RegExp(`current-.*-${theme}\\.webp`))
      await expect
        .poll(() => image.evaluate((el) => (el as HTMLImageElement).naturalWidth))
        .toBeGreaterThan(0)
      await expect(dialog.getByRole("button", { name: "Close preview" })).toBeFocused()
      await page.keyboard.press("Tab")
      await expect(dialog.getByRole("region", { name: "Enlarged product image" })).toBeFocused()
      await page.keyboard.press("Escape")
      await expect(dialog).not.toBeVisible()
      await expect(trigger).toBeFocused()
      expect(await page.evaluate(() => document.documentElement.style.overflow)).toBe("")
    }
  })
}

test("tabs interrupt cleanly and copy feedback handles denied clipboard access", async ({
  page,
}) => {
  await page.goto("/")
  await page.getByRole("tab", { name: "Web app", exact: true }).focus()
  await page.keyboard.press("ArrowRight")
  const cli = page.getByRole("tab", { name: "CLI", exact: true })
  await expect(cli).toBeFocused()
  await expect(cli).toHaveAttribute("aria-selected", "true")
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error("denied")
        },
      },
    })
  )
  await page.getByRole("button", { name: "Copy login command" }).click()
  await expect(page.locator("[data-copy-status]")).toHaveText(
    "Copy unavailable. Select the command below to copy it."
  )
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => {} },
    })
  )
  await page.getByRole("button", { name: "Copy login command" }).click()
  await expect(page.locator("[data-copy-status]")).toHaveText("Copied")
  await cli.focus()
  await page.keyboard.press("End")
  await expect(page.getByRole("tab", { name: "Coding agents", exact: true })).toBeFocused()
  await page.keyboard.press("Home")
  await expect(page.getByRole("tab", { name: "Web app", exact: true })).toBeFocused()
  await expect(page.locator('[role="tabpanel"]:visible')).toHaveCount(1)
})

test("switching reduced motion at runtime keeps the record and removes travel", async ({
  page,
}) => {
  await page.goto("/")
  await page.locator("#journey-retest").scrollIntoViewIfNeeded()
  await page.emulateMedia({ reducedMotion: "reduce" })
  await expect(page.locator("evidence-journey")).not.toHaveClass(/is-enhanced/)
  await expect(page.locator(".journey__artifact")).toHaveCSS("transform", "none")
  await expect(page.locator(".journey__report")).toBeVisible()
  for (const receipt of await page.locator("[data-receipt-stage]").all())
    await expect(receipt).toBeVisible()
})

test("hero controls remain stationary and the new preview assets are used", async ({ page }) => {
  await page.goto("/")
  for (const selector of [
    "#premium-hero-title",
    ".premium-hero__primary",
    ".premium-hero__secondary",
  ]) {
    expect(await page.locator(selector).evaluate((el) => el.getAnimations().length)).toBe(0)
  }
  for (const src of await page
    .locator(".hero-frame__img")
    .evaluateAll((images) => images.map((el) => el.getAttribute("src"))))
    expect(src).toMatch(/\/product\/current-/)
  await page.screenshot({
    path: `../../output/playwright/evidence-motion/hero-${page.viewportSize()!.width}.png`,
  })
})

test("native smooth chapter navigation is monotonic and keeps a stable evidence scene", async ({
  page,
}) => {
  await page.goto("/")
  await page.getByRole("link", { name: "Overview", exact: true }).click()
  await expect(page.locator("[data-journey-scene]")).toHaveAttribute("data-stage", "0")
  // Exercise the real smooth-scroll path: disabling scroll-behavior concealed
  // the old destination -> overview -> destination flash.
  for (const destination of [6, 0]) {
    const sample = await page.evaluate(async (target) => {
      const scene = document.querySelector<HTMLElement>("[data-journey-scene]")!
      const stages = [Number(scene.dataset.stage)]
      const heights = [scene.getBoundingClientRect().height]
      const observer = new MutationObserver(() => {
        stages.push(Number(scene.dataset.stage))
        heights.push(scene.getBoundingClientRect().height)
      })
      observer.observe(scene, { attributes: true, attributeFilter: ["data-stage"] })
      document.querySelector<HTMLAnchorElement>(`[data-journey-link="${target}"]`)!.click()
      await new Promise<void>((resolve) => {
        let previous = scrollY
        let stable = 0
        const start = performance.now()
        const tick = () => {
          stable = scrollY === previous ? stable + 1 : 0
          previous = scrollY
          if ((stable > 12 && performance.now() - start > 350) || performance.now() - start > 4000)
            resolve()
          else requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
      observer.disconnect()
      return {
        stages,
        heights,
        final: Number(scene.dataset.stage),
        behavior: getComputedStyle(document.documentElement).scrollBehavior,
      }
    }, destination)
    expect(sample.behavior).toBe("smooth")
    expect(sample.final).toBe(destination)
    expect(Math.max(...sample.heights) - Math.min(...sample.heights)).toBeLessThan(1)
    expect(sample.stages).toEqual(
      [...sample.stages].sort((a, b) => (destination === 6 ? a - b : b - a))
    )
  }
})

test("scrolling within a chapter does not rewrite navigation or receipt content", async ({
  page,
}) => {
  await page.goto("/#journey-target")
  await expect(page.locator("[data-journey-scene]")).toHaveAttribute("data-stage", "1")
  await page.evaluate(() => {
    document.documentElement.style.scrollBehavior = "auto"
  })
  const writes = await page.evaluate(async () => {
    let count = 0
    const observer = new MutationObserver((mutations) => {
      count += mutations.filter((mutation) => mutation.attributeName !== "style").length
    })
    observer.observe(document.querySelector("evidence-journey")!, {
      attributes: true,
      childList: true,
      subtree: true,
    })
    for (let i = 0; i < 5; i++) {
      scrollBy(0, 5)
      await new Promise(requestAnimationFrame)
    }
    observer.disconnect()
    return count
  })
  expect(writes).toBe(0)
})

test("short and enlarged-text layouts keep the complete example readable", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto("/#assurance-world")
  await expect(page.locator(".journey__report")).toBeVisible()
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%"
  })
  await expect(page.locator("evidence-journey")).toHaveClass(/is-flow/)
  await expect(page.getByRole("button", { name: "Open navigation menu" })).toBeVisible()
  await page.getByRole("button", { name: "Open navigation menu" }).click()
  await expect(page.locator("#mobile-menu")).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.locator(".journey__report")).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
