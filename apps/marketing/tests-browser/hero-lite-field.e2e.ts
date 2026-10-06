import { expect, test } from "@playwright/test"

/**
 * Hero URL field (handoff item 3.1b).
 *
 * The field hands the visitor's URL to /scan through sessionStorage. Consent
 * lives in the hero because /scan pre-checks its own box and auto-submits, so a
 * hero form without recorded consent would start a scan nobody agreed to.
 *
 * In this preview build PUBLIC_SCANNER_URL is a placeholder, so the field is
 * disabled and cannot be driven. The enabled path is covered by
 * src/tests/hero-lite-handoff.test.ts, which exercises the shared module
 * directly; these tests cover the render and the disabled contract.
 */
const FIELD = "#hero-lite-form"
const URL_INPUT = "#hero-scan-url"
const CONSENT = "#hero-scan-authorized"

test("renders the hero field with its own ids and a consent box", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/")

  await expect(page.locator(FIELD)).toBeVisible()
  await expect(page.locator(URL_INPUT)).toBeVisible()
  await expect(page.locator(CONSENT)).toBeAttached()
  await expect(page.locator("#hero-scan-error")).toBeAttached()

  // The field's ids must not collide with the Lite Check section lower down.
  for (const id of ["home-lite-scan-form", "home-scan-url", "home-scan-authorized"]) {
    await expect(page.locator(`#${id}`)).toHaveCount(1)
  }

  // No horizontal overflow at 390px with the field present.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  )
  expect(overflow).toBeLessThanOrEqual(1)
})

test("stacks the field and button at 390px with touch-sized targets", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/")

  const input = await page.locator(URL_INPUT).boundingBox()
  const button = await page.locator(".premium-hero__field-button").boundingBox()
  expect(input).not.toBeNull()
  expect(button).not.toBeNull()
  // 44px minimum touch target.
  expect(input!.height).toBeGreaterThanOrEqual(44)
  expect(button!.height).toBeGreaterThanOrEqual(44)
  // The button stacks under the field rather than sitting beside it.
  expect(button!.y, "the button stacks below the field").toBeGreaterThanOrEqual(
    input!.y + input!.height - 1
  )
  expect(button!.x, "the button is not pushed off the right edge").toBeGreaterThanOrEqual(0)
})

test("keeps the no-JavaScript fallback in the served markup", async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/")

  // A browser parses <noscript> children as text when scripting is on, so they
  // are absent from the live DOM and no locator can see them. The fallback is
  // therefore asserted from the served bytes.
  const html = await (await request.get("/")).text()
  expect(html).toContain("<noscript>")
  expect(html).toMatch(/<noscript>[\s\S]*?Open the free Lite Check[\s\S]*?<\/noscript>/)

  // The form posts natively to /scan, and the input carries no name, so a
  // native GET cannot put the typed URL into the query string.
  await expect(page.locator(FIELD)).toHaveAttribute("action", "/scan")
  await expect(page.locator(FIELD)).toHaveAttribute("method", "get")
  await expect(page.locator(URL_INPUT)).not.toHaveAttribute("name", /./)
})

test("carries no typed value in the page URL or the field's own attributes", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/")
  const before = page.url()

  // In this preview build the scanner is not connected, so the control is
  // disabled and cannot be typed into. The enabled handoff is covered by
  // src/tests/hero-lite-handoff.test.ts, which drives the shared module.
  const input = page.locator(URL_INPUT)
  if (!(await input.isDisabled())) await input.fill("https://example.com")

  // Either way the page URL must not gain the value, and the field must not
  // expose it through an attribute a native submit would send.
  expect(page.url()).toBe(before)
  expect(page.url()).not.toContain("example.com")
  await expect(input).not.toHaveAttribute("name", /./)
  expect(await input.getAttribute("value")).toBeNull()
})

/**
 * Light-theme contrast on the hero field and the sample verdict card.
 *
 * The field's colours were authored for the dark hero and had no light
 * override, so in the light theme the label and consent sentence sat near
 * 1.6:1 on #eef6fa and the two finding titles rendered near-white on the white
 * card. This measures the RENDERED colours (computed styles, not source text)
 * against the surface each element actually sits on and requires WCAG AA.
 */
const srgbToLinear = (channel: number) => {
  const c = channel / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

const relativeLuminance = ([r, g, b]: [number, number, number]) =>
  0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b)

const parseRgb = (value: string): [number, number, number] => {
  const match = value.match(/rgba?\(([^)]+)\)/)
  if (!match) throw new Error(`cannot parse colour: ${value}`)
  const parts = match[1]
    .split(/[\s,/]+/)
    .filter(Boolean)
    .map(Number)
  return [parts[0], parts[1], parts[2]]
}

const contrastRatio = (foreground: string, background: string) => {
  const [lighter, darker] = [
    relativeLuminance(parseRgb(foreground)),
    relativeLuminance(parseRgb(background)),
  ].sort((a, b) => b - a)
  return (lighter + 0.05) / (darker + 0.05)
}

test("keeps the hero field and sample card readable in the light theme", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.emulateMedia({ colorScheme: "light" })
  await page.goto("/")

  await expect(page.locator("html")).toHaveAttribute("data-theme", "light")

  // Each target is measured against the surface it renders on: the hero itself
  // for the field, and the artifact card for the finding rows.
  const measured = await page.evaluate(() => {
    const hero = document.querySelector(".premium-hero") as HTMLElement
    const card = document.querySelector(".premium-hero__artifact-card") as HTMLElement
    const rows: { selector: string; color: string; background: string }[] = []
    const pick = (selector: string, background: HTMLElement) => {
      const node = document.querySelector(selector) as HTMLElement | null
      // The status line only renders while the scanner is unconnected, so a
      // connected build has nothing to measure there.
      if (!node) return
      rows.push({
        selector,
        color: getComputedStyle(node).color,
        background: getComputedStyle(background).backgroundColor,
      })
    }
    pick(".premium-hero__field-label", hero)
    pick(".premium-hero__field-input", hero)
    pick(".premium-hero__field-consent", hero)
    pick(".premium-hero__field-status", hero)
    pick(".premium-hero__artifact-findings li", card)
    return rows
  })

  for (const { selector, color, background } of measured) {
    const ratio = contrastRatio(color, background)
    expect(ratio, `${selector} (${color} on ${background})`).toBeGreaterThanOrEqual(4.5)
  }

  // The input must actually read as a light control on the light hero rather
  // than a heavy dark box.
  await expect(page.locator(URL_INPUT)).toHaveCSS("background-color", "rgb(255, 255, 255)")

  // The error text is hidden until a validation failure, so its colour is read
  // from the stylesheet rather than a computed style.
  const errorRatio = await page.evaluate(() => {
    const hero = document.querySelector(".premium-hero") as HTMLElement
    const node = document.querySelector(".premium-hero__field-error") as HTMLElement
    return {
      color: getComputedStyle(node).color,
      background: getComputedStyle(hero).backgroundColor,
    }
  })
  expect(
    contrastRatio(errorRatio.color, errorRatio.background),
    `field error (${errorRatio.color} on ${errorRatio.background})`
  ).toBeGreaterThanOrEqual(4.5)
})
