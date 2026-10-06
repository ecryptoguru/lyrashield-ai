import { expect, test } from "@playwright/test"

test("narrow header fixes stay scoped and target dropdown summaries", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 })
  await page.goto("/")

  const narrowLayout = await page.evaluate(() => {
    const unrelatedHeader = document.createElement("header")
    const row = document.createElement("div")
    row.style.display = "flex"
    row.style.gap = "24px"
    unrelatedHeader.append(row)
    document.body.append(unrelatedHeader)
    const unrelatedGap = getComputedStyle(row).gap
    unrelatedHeader.remove()
    return {
      width: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      unrelatedGap,
    }
  })

  expect(narrowLayout.scrollWidth).toBeLessThanOrEqual(narrowLayout.width)
  expect(narrowLayout.unrelatedGap).toBe("24px")

  await page.setViewportSize({ width: 1100, height: 900 })
  const summary = page
    .locator('#site-header nav[aria-label="Main"] > ul > li > details > summary')
    .first()
  await expect(summary).toHaveCSS("padding-left", "8px")
})

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

    const gateway = page.locator('[data-chapter-index="0"]')
    const scrollToChapterProgress = async (progress: number) =>
      gateway.evaluate((chapter, chapterProgress) => {
        const top = chapter.getBoundingClientRect().top + scrollY
        scrollTo(
          0,
          top +
            chapter.clientHeight * chapterProgress -
            innerHeight * (innerWidth < 768 ? 0.68 : 0.5)
        )
      }, progress)

    // The world spans the whole story. Scrolling its tall parent into view may
    // land on any middle chapter; position the first chapter's scroll anchor
    // deliberately so this test starts on card 0 before checking its transition.
    await scrollToChapterProgress(0.2)
    await page.evaluate(() => customElements.whenDefined("evidence-world"))
    await expect(gateway.locator('[data-story-card-index="0"]')).toHaveClass(/is-card-active/)
    await scrollToChapterProgress(0.7)
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

// Item 2.2: the sheet scrolls inside the viewport and exposes every
// destination, instead of dropping entries to fit a 390x400 screen.
test("scrolls the mobile menu inside the viewport and reaches every destination", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 400 })
  await page.goto("/")

  const toggle = page.getByRole("button", { name: "Open navigation menu" })
  await toggle.click()

  const menu = page.locator("#mobile-menu")
  await expect(menu).toBeVisible()
  await expect(menu).toHaveCSS("transform", "none")

  // The sheet is capped at the viewport and scrolls internally.
  const bounds = await menu.boundingBox()
  expect(bounds).not.toBeNull()
  expect(bounds!.height).toBeLessThanOrEqual(400)
  const styles = await menu.evaluate((element) => {
    const computed = getComputedStyle(element)
    return {
      overflowY: computed.overflowY,
      maxHeight: computed.maxHeight,
      viewportHeight: innerHeight,
    }
  })
  expect(styles.overflowY).toBe("auto")
  // max-height: 100dvh resolves to the viewport height; the source form is
  // asserted in src/tests/header-nav-layout.test.ts.
  expect(parseFloat(styles.maxHeight)).toBe(styles.viewportHeight)

  // Every desktop destination is present, one accordion per menu.
  for (const label of ["Product", "Free tools", "Learn"]) {
    await expect(menu.getByText(label, { exact: true })).toBeVisible()
  }
  await expect(menu.getByRole("link", { name: "Pricing", exact: true })).toBeVisible()
  await expect(menu.getByRole("link", { name: "Coding agents", exact: true })).toBeVisible()
  await expect(menu.getByRole("link", { name: "Start free trial" })).toBeVisible()

  // Escape closes the sheet.
  await page.keyboard.press("Escape")
  await expect(menu).toBeHidden()

  // Re-open: opening an accordion must not close the sheet, and its entries
  // are reachable by scrolling inside the sheet.
  await toggle.click()
  await menu.getByText("Learn", { exact: true }).click()
  const docs = menu.getByRole("link", { name: "Docs", exact: true })
  await expect(docs).toBeAttached()
  await docs.scrollIntoViewIfNeeded()
  await expect(docs).toBeInViewport()

  // The close button also closes the sheet.
  await page.getByRole("button", { name: "Close navigation menu" }).click()
  await expect(menu).toBeHidden()
})

test("keeps mobile menu rows content-sized when the browser expands dialogs", async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 })
  await page.goto("/")
  // Force a tall dialog: the sheet must stay capped by the viewport rather
  // than stretch to the injected height, and its rows stay touch-sized.
  await page.addStyleTag({ content: "dialog { height: 38rem; }" })

  await page.getByRole("button", { name: "Open navigation menu" }).click()

  const menu = page.locator("#mobile-menu")
  const firstLink = menu.getByRole("link", { name: "Coding agents" })
  await expect(menu).toBeVisible()
  // The entrance animation scales the dialog from 0.98, temporarily making
  // a 44px row measure 43px. Measure touch targets after the animation ends.
  await menu.evaluate(async (dialog) => {
    await Promise.all(dialog.getAnimations().map((animation) => animation.finished))
  })
  expect((await menu.boundingBox())!.height).toBeLessThanOrEqual(852)
  // min-height: 2.75rem renders as 43.83px at this width, so round to the
  // nearest pixel before checking the 44px touch target.
  expect(Math.round((await firstLink.boundingBox())!.height)).toBeGreaterThanOrEqual(44)
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

test("keeps the Free tools menu separate from the Learn menu", async ({ page }) => {
  await page.setViewportSize({ width: 1159, height: 863 })
  await page.goto("/")

  // Scope to the desktop list: the mobile sheet lives in the same <nav>.
  const desktopNav = page.locator('header.sticky nav[aria-label="Main"] > ul')
  const toolsMenu = desktopNav.locator("summary").filter({ hasText: "Free tools" })
  const learnMenu = desktopNav.locator("summary").filter({ hasText: "Learn" })
  const learnDropdown = learnMenu.locator("..")
  const label = learnMenu.getByText("Learn", { exact: true })
  const chevron = learnMenu.locator("[data-nav-chevron]")
  await expect(toolsMenu).toBeVisible()
  await expect(learnMenu).toBeVisible()

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
  // The header menu lists four tools plus "All free tools"; the remaining
  // tools are reachable from /tools (spec section 7).
  await expect(
    page.getByRole("link", { name: "Security Headers and CORS Checker", exact: true })
  ).toBeVisible()

  await learnMenu.click()
  await expect(learnDropdown.getByRole("link", { name: "Docs", exact: true })).toBeVisible()
  await expect(learnDropdown.getByRole("link", { name: "Guides", exact: true })).toBeVisible()
})

test("keeps desktop navigation labels on one line at the compact desktop width", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1159, height: 863 })
  await page.goto("/")

  const header = page.locator("header.sticky")
  const items = header.locator('nav[aria-label="Main"] > ul > li')
  await expect(items).toHaveCount(6)
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

test("left-aligns story-card bullet lists inside left-aligned chapters", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto("/")
  await page.locator("evidence-world").scrollIntoViewIfNeeded()

  // The bullet lists live on the supporting cards (index 1). Chapter 0
  // (gateway) is a left card and chapter 3 (evidence-state) is a right card.
  const leftRows = await page
    .locator('[data-chapter-index="0"] [data-story-card-index="1"] .evidence-world__points li')
    .evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).justifyContent))
  expect(leftRows.length).toBeGreaterThan(0)
  for (const justification of leftRows) {
    expect(justification).toBe("flex-start")
  }

  const rightRows = await page
    .locator('[data-chapter-index="3"] [data-story-card-index="1"] .evidence-world__points li')
    .evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).justifyContent))
  expect(rightRows.length).toBeGreaterThan(0)
  for (const justification of rightRows) {
    expect(justification).toBe("flex-end")
  }
})
