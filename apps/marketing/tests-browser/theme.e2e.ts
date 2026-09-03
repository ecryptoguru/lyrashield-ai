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
  await expect(menu).toHaveCSS("transform", "none")
  await expect(menu.getByText("Resources", { exact: true })).toBeVisible()
  await expect(menu.getByRole("link", { name: "Free tools", exact: true })).toBeVisible()
  await expect(menu.getByRole("link", { name: "Get started" })).toBeVisible()
  const bounds = await menu.boundingBox()
  expect(bounds).not.toBeNull()
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(384)
  expect(await menu.evaluate((element) => element.scrollHeight)).toBeLessThanOrEqual(
    await menu.evaluate((element) => element.clientHeight)
  )
  for (const name of ["For agents", "How it works", "Free scan", "Pricing"]) {
    const link = menu.getByRole("link", { name, exact: true })
    await expect(link).toBeInViewport()
    const linkBounds = await link.boundingBox()
    expect(linkBounds!.height).toBeGreaterThanOrEqual(44)
    expect(linkBounds!.y + linkBounds!.height).toBeLessThanOrEqual(384)
  }

  await page.keyboard.press("Escape")
  await expect(menu).toBeHidden()

  await toggle.click()
  await page.getByRole("button", { name: "Close navigation menu" }).click()
  await expect(menu).toBeHidden()
})

test("keeps mobile menu rows content-sized when the browser expands dialogs", async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 })
  await page.goto("/")
  await page.addStyleTag({ content: "dialog { height: 38rem; }" })

  await page.getByRole("button", { name: "Open navigation menu" }).click()

  const menu = page.locator("#mobile-menu")
  const firstLink = menu.getByRole("link", { name: "For agents" })
  await expect(menu).toBeVisible()
  expect((await menu.boundingBox())!.height).toBeLessThan(400)
  expect((await firstLink.boundingBox())!.height).toBeLessThanOrEqual(48)
})

test("supports standard keyboard navigation in the AI scanner tabs", async ({ page }) => {
  await page.goto("/tools/ai-app-security-scanner")

  const filesTab = page.getByRole("tab", { name: "Select files" })
  const pasteTab = page.getByRole("tab", { name: "Paste code" })
  await filesTab.focus()
  await page.keyboard.press("ArrowRight")

  await expect(pasteTab).toBeFocused()
  await expect(pasteTab).toHaveAttribute("aria-selected", "true")
  await expect(filesTab).toHaveAttribute("tabindex", "-1")
  await expect(page.getByRole("tabpanel", { name: "Paste code" })).toBeVisible()

  await page.keyboard.press("Home")
  await expect(filesTab).toBeFocused()
  await expect(filesTab).toHaveAttribute("aria-selected", "true")
})

test("keeps Free tools separate from the restored desktop Resources menu", async ({ page }) => {
  await page.setViewportSize({ width: 1159, height: 863 })
  await page.goto("/")

  const toolsMenu = page.locator("summary").filter({ hasText: "Free tools" })
  const resourcesMenu = page.locator("summary").filter({ hasText: "Resources" })
  const resourcesDropdown = resourcesMenu.locator("..")
  const label = resourcesMenu.getByText("Resources", { exact: true })
  const chevron = resourcesMenu.locator("[data-nav-chevron]")
  await expect(toolsMenu).toBeVisible()
  await expect(resourcesMenu).toBeVisible()

  const labelBounds = await label.boundingBox()
  const chevronBounds = await chevron.boundingBox()
  expect(labelBounds).not.toBeNull()
  expect(chevronBounds).not.toBeNull()
  const labelCenter = labelBounds!.y + labelBounds!.height / 2
  const chevronCenter = chevronBounds!.y + chevronBounds!.height / 2
  expect(chevronCenter).toBeLessThan(labelCenter)
  expect(labelCenter - chevronCenter).toBeLessThanOrEqual(2)

  await toolsMenu.click()
  await expect(page.getByRole("link", { name: "All free tools", exact: true })).toBeVisible()
  await expect(
    page.getByRole("link", { name: "AI App Security Scanner", exact: true })
  ).toBeVisible()

  await resourcesMenu.click()
  await expect(
    resourcesDropdown.getByRole("link", { name: "Methodology", exact: true })
  ).toBeVisible()
  await expect(resourcesDropdown.getByRole("link", { name: "Guides", exact: true })).toBeVisible()
})

test("keeps desktop navigation labels on one line at the compact desktop width", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1159, height: 863 })
  await page.goto("/")

  const header = page.locator("header.sticky")
  const items = header.locator('nav[aria-label="Main"] > ul > li')
  await expect(items).toHaveCount(7)
  expect(
    await header.evaluate((element) => element.getBoundingClientRect().height)
  ).toBeLessThanOrEqual(65)

  for (const item of await items.all()) {
    expect(
      await item.evaluate((element) => element.getBoundingClientRect().height)
    ).toBeLessThanOrEqual(44)
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1159)
})
