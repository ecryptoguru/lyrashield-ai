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
  await expect(page.locator(".premium-hero")).toHaveCSS("background-color", "rgb(238, 246, 250)")
  await expect(page.locator(".hero-frame")).toHaveCSS("background-color", "rgb(245, 249, 252)")
  await expect(page.locator("evidence-world")).toHaveCSS("background-color", "rgb(8, 17, 28)")

  await toggle.click()
  await expect(root).toHaveAttribute("data-theme-preference", "light")
  await expect(activeIcon("light")).toBeVisible()
  await expect
    .poll(() => page.evaluate(() => document.cookie.includes("lyrashield-theme=light")))
    .toBe(true)

  await toggle.click()
  await expect(root).toHaveAttribute("data-theme-preference", "dark")
  await expect(root).toHaveAttribute("data-theme", "dark")
  await expect(activeIcon("dark")).toBeVisible()
  await expect(themeColor).toHaveAttribute("content", "#08111c")
  await expect(page.locator(".premium-hero")).toHaveCSS("background-color", "rgb(8, 17, 28)")
  await expect(page.locator(".hero-frame")).toHaveCSS("background-color", "rgb(8, 17, 28)")
  await expect(page.locator("evidence-world")).toHaveCSS("background-color", "rgb(8, 17, 28)")

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

for (const viewport of [
  { name: "mobile", width: 390, height: 844 },
  { name: "desktop", width: 1440, height: 900 },
]) {
  test(`cross-fades story cards without horizontal overflow on ${viewport.name}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport)
    await page.goto("/")
    const expectedChapterHeight = viewport.name === "mobile" ? 1055 : 1035
    expect(
      await page.locator('[data-chapter-index="0"]').evaluate((el) => el.clientHeight)
    ).toBeGreaterThanOrEqual(expectedChapterHeight)
    await page.locator("evidence-world").scrollIntoViewIfNeeded()
    await page.evaluate(() => customElements.whenDefined("evidence-world"))

    const gateway = page.locator('[data-chapter-index="0"]')
    await expect(gateway.locator('[data-story-card-index="0"]')).toHaveClass(/is-card-active/)
    await gateway.evaluate((chapter) => {
      const top = chapter.getBoundingClientRect().top + scrollY
      scrollTo(0, top + chapter.clientHeight * 0.7 - innerHeight * (innerWidth < 768 ? 0.68 : 0.5))
    })
    await expect(gateway.locator('[data-story-card-index="1"]')).toHaveClass(/is-card-active/)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      viewport.width
    )
  })
}

test("shows every story card in reduced-motion mode", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto("/")
  await page.locator("evidence-world").scrollIntoViewIfNeeded()
  await expect(page.locator("[data-story-card-index]")).toHaveCount(12)
  for (const card of await page.locator("[data-story-card-index]").all())
    await expect(card).toBeVisible()
})

test("keeps the mobile story card anchored below the header without flashing the video", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/")

  const world = page.locator("evidence-world")
  await world.scrollIntoViewIfNeeded()
  await page.evaluate(() => customElements.whenDefined("evidence-world"))
  const firstChapter = page.locator('[data-chapter-index="0"]')
  await firstChapter.evaluate((chapter) => {
    const top = chapter.getBoundingClientRect().top + scrollY
    scrollTo(0, top + 200)
  })

  await expect(world).toHaveClass(/is-pinned/)
  const activeCard = firstChapter.locator(".is-card-active")
  await expect(activeCard).toBeVisible()
  await expect
    .poll(() => activeCard.evaluate((card) => getComputedStyle(card).transform))
    .toBe("none")
  expect(
    await activeCard.evaluate((card) => innerHeight - card.getBoundingClientRect().bottom)
  ).toBe(16)

  const headerBottom = await page
    .locator("header.sticky")
    .evaluate((header) => header.getBoundingClientRect().bottom)
  const progressTop = await page
    .locator(".evidence-world__chrome")
    .evaluate((chrome) => chrome.getBoundingClientRect().top)
  expect(progressTop).toBeGreaterThan(headerBottom)

  const video = page.locator(".evidence-world__video")
  await expect(video).toHaveClass(/is-front/, { timeout: 15_000 })
  await page.locator('[data-chapter-index="1"]').evaluate((chapter) => {
    const top = chapter.getBoundingClientRect().top + scrollY
    scrollTo(0, top + 200)
  })
  await expect(video).toHaveClass(/is-front/)
})

test("retains the motion layout on a short portrait phone", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 })
  await page.goto("/")
  const world = page.locator("evidence-world")
  await world.scrollIntoViewIfNeeded()
  await page.evaluate(() => customElements.whenDefined("evidence-world"))
  await world.evaluate((element) => {
    const top = element.getBoundingClientRect().top + scrollY
    scrollTo(0, top + 200)
  })

  await expect(world).toHaveClass(/is-motion-layout/)
  await expect(world).toHaveClass(/is-pinned/)
  await expect(page.locator(".evidence-world__stage")).toHaveCSS("position", "sticky")
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320)
})

test("keeps a short landscape phone in the stable document flow", async ({ page }) => {
  await page.setViewportSize({ width: 844, height: 390 })
  await page.goto("/")
  const world = page.locator("evidence-world")
  await world.scrollIntoViewIfNeeded()
  await page.evaluate(() => customElements.whenDefined("evidence-world"))

  await expect(page.locator(".evidence-world__stage")).toHaveCSS("position", "relative")
  await expect(page.locator(".evidence-world__chapters")).toHaveCSS("margin-top", "0px")
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(844)
})

test("keeps the compact mobile menu inside the visible viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 400 })
  await page.goto("/")

  const toggle = page.getByRole("button", { name: "Open navigation menu" })
  await toggle.click()

  const menu = page.locator("#mobile-menu")
  await expect(menu).toBeVisible()
  await expect(menu.getByText("Explore", { exact: true })).toBeVisible()
  await expect(menu.getByRole("link", { name: "Get started" })).toBeVisible()
  const bounds = await menu.boundingBox()
  expect(bounds).not.toBeNull()
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(384)
  expect(await menu.evaluate((element) => element.scrollHeight)).toBeLessThanOrEqual(
    await menu.evaluate((element) => element.clientHeight)
  )

  await page.keyboard.press("Escape")
  await expect(menu).toBeHidden()

  await toggle.click()
  await page.getByRole("button", { name: "Close navigation menu" }).click()
  await expect(menu).toBeHidden()
})
