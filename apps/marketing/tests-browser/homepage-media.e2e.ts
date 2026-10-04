import { expect, test } from "@playwright/test"

const productImage =
  /\/product\/console-(?:home|issues-thumb|coding-agents-thumb)(?:-light)?\.webp$/
const heroImage = /\/_astro\/premium-hero\.[^/]+\.(?:avif|webp|jpg)$/
const motionVideo = /assurance-world\.(?:mp4|webm)$/
const productImageDimensions = new Map([
  ["/product/console-home.webp", [1600, 1587]],
  ["/product/console-home-light.webp", [1600, 1584]],
  ["/product/console-issues-thumb.webp", [1133, 883]],
  ["/product/console-issues-thumb-light.webp", [1133, 878]],
  ["/product/console-coding-agents-thumb.webp", [1133, 883]],
  ["/product/console-coding-agents-thumb-light.webp", [1133, 878]],
])

test("homepage loads only the selected lazy product screenshots for either saved theme", async ({
  browser,
}) => {
  for (const theme of ["dark", "light"] as const) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    await context.addCookies([
      { name: "lyrashield-theme", value: theme, domain: "127.0.0.1", path: "/" },
    ])
    const page = await context.newPage()
    const requests: string[] = []
    const responseBytes: Array<{ path: string; bytes: number }> = []
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname
      if (productImage.test(path) || heroImage.test(path)) requests.push(path)
    })
    page.on("response", (response) => {
      const path = new URL(response.url()).pathname
      if (!productImage.test(path) && !heroImage.test(path)) return
      responseBytes.push({ path, bytes: Number(response.headers()["content-length"] ?? 0) })
    })

    const response = await page.goto("/", { waitUntil: "load" })
    expect(response?.status()).toBe(200)
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme)
    await expect(page.locator("#premium-hero-title")).toBeVisible()
    await expect(page.locator('img[fetchpriority="high"]')).toHaveCount(1)
    await expect(page.locator('img[fetchpriority="high"]')).toHaveAttribute("loading", "eager")
    const heroPoster = await page.locator('img[fetchpriority="high"]').evaluate((image) => ({
      alt: image.getAttribute("alt"),
      width: Number(image.getAttribute("width")),
      height: Number(image.getAttribute("height")),
    }))
    expect(heroPoster.alt).toContain("hero headline")
    expect(heroPoster.width).toBeGreaterThan(0)
    expect(heroPoster.height).toBeGreaterThan(0)
    await expect(
      page.locator(".hero-frame__img[loading='eager'], .hero-frame__img[fetchpriority='high']")
    ).toHaveCount(0)

    const screenshotContract = await page.locator(".hero-frame__img").evaluateAll((images) =>
      images.map((image) => ({
        src: new URL((image as HTMLImageElement).src).pathname,
        alt: image.getAttribute("alt"),
        width: Number(image.getAttribute("width")),
        height: Number(image.getAttribute("height")),
        loading: image.getAttribute("loading"),
      }))
    )
    expect(screenshotContract).toHaveLength(6)
    expect(
      screenshotContract.every(({ src, alt, width, height, loading }) => {
        const dimensions = productImageDimensions.get(src)
        return (
          Boolean(alt) &&
          dimensions?.[0] === width &&
          dimensions?.[1] === height &&
          loading === "lazy"
        )
      })
    ).toBe(true)

    // The collage is block 5 now, so it sits below the fold and the browser may
    // defer it past this point. Lazy loading is asserted on the attributes
    // above; here the point is that nothing eager was fetched and that the
    // theme selects exactly one file per frame, which is checked after the
    // scroll below where the images are guaranteed to have loaded.
    await page.waitForTimeout(500)
    const initialProductRequests = requests.filter((path) => productImage.test(path))
    expect(initialProductRequests.length).toBeLessThanOrEqual(3)
    // Nothing from the collage may be fetched eagerly at either theme.
    await expect(
      page.locator(".hero-frame__img[loading='eager'], .hero-frame__img[fetchpriority='high']")
    ).toHaveCount(0)

    console.log(
      JSON.stringify({
        theme,
        initialProductRequests: initialProductRequests.sort(),
        imageTransferBytes: responseBytes.reduce((total, item) => total + item.bytes, 0),
      })
    )

    await page.locator(".hero-frame").scrollIntoViewIfNeeded()
    await expect
      .poll(() =>
        page
          .locator(".hero-frame__img:visible")
          .evaluateAll(
            (images) =>
              images.filter((image) => (image as HTMLImageElement).naturalWidth > 0).length
          )
      )
      .toBe(3)

    // After the scroll the collage is loaded, so the theme contract is asserted
    // here: exactly one file per frame, and the right variant for the theme.
    const expectedSuffix = theme === "light" ? "-light.webp" : ".webp"
    const loaded = requests.filter((path) => productImage.test(path))
    for (const imageName of [
      "console-home",
      "console-issues-thumb",
      "console-coding-agents-thumb",
    ]) {
      const paths = loaded.filter((path) => path.includes(`/${imageName}`))
      expect(paths.length, `${imageName} must load exactly once`).toBe(1)
      expect(paths[0].endsWith(expectedSuffix), `${imageName} must match the theme`).toBe(true)
    }
    await context.close()
  }
})

test("motion video waits for approach and buffers before the story enters view", async ({
  browser,
}) => {
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1440, height: 900 },
  ]) {
    const context = await browser.newContext({ viewport, reducedMotion: "no-preference" })
    const page = await context.newPage()
    const motionRequests: string[] = []
    page.on("request", (request) => {
      if (motionVideo.test(new URL(request.url()).pathname)) motionRequests.push(request.url())
    })
    await page.goto("/", { waitUntil: "load" })
    // Give the former idle-after-load warm path time to run.
    await page.waitForTimeout(3000)
    expect(motionRequests).toEqual([])
    expect(await page.locator("#assurance-world video").getAttribute("src")).toBeNull()
    await page.evaluate(() => {
      const story = document.getElementById("assurance-world")!
      scrollTo(0, story.getBoundingClientRect().top + scrollY - innerHeight * 2)
    })
    await expect.poll(() => motionRequests.length).toBeGreaterThan(0)
    expect(
      await page.locator("#assurance-world").evaluate((story) => story.getBoundingClientRect().top)
    ).toBeGreaterThan(viewport.height)
    await page.locator("#assurance-world").scrollIntoViewIfNeeded()
    await expect(page.locator("#assurance-world")).toHaveClass(/is-enhanced/)
    await context.close()
  }
})

test("reduced motion and Save-Data keep the static evidence world without loading video", async ({
  browser,
}) => {
  for (const mode of ["reduced-motion", "save-data"] as const) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      reducedMotion: mode === "reduced-motion" ? "reduce" : "no-preference",
    })
    const page = await context.newPage()
    if (mode === "save-data") {
      await page.addInitScript(() => {
        Object.defineProperty(navigator, "connection", {
          configurable: true,
          value: { saveData: true, effectiveType: "4g" },
        })
      })
    }
    const motionRequests: string[] = []
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname
      if (motionVideo.test(path)) motionRequests.push(path)
    })

    const response = await page.goto("/", { waitUntil: "load" })
    expect(response?.status()).toBe(200)
    await page.waitForTimeout(1200)
    expect(motionRequests).toEqual([])
    await expect(page.locator("#assurance-world .evidence-world__poster.is-active")).toBeVisible()
    expect(await page.locator("#assurance-world video").getAttribute("src")).toBeNull()
    if (mode === "save-data") {
      expect(
        await page.evaluate(
          () =>
            (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData
        )
      ).toBe(true)
    }
    await context.close()
  }
})

test("hero copy and product-image caption remain available without JavaScript", async ({
  browser,
}) => {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: 390, height: 844 },
  })
  const page = await context.newPage()
  const response = await page.goto("/", { waitUntil: "load" })
  expect(response?.status()).toBe(200)
  await expect(page.locator("#premium-hero-title")).toBeVisible()
  await expect(page.locator(".premium-hero__primary")).toBeVisible()
  await expect(page.locator(".hero-frame__caption")).toBeVisible()
  await page.locator("#assurance-world").scrollIntoViewIfNeeded()
  await expect(page.locator("#assurance-world .evidence-world__poster.is-active")).toBeVisible()
  await expect(
    page.locator('#assurance-world [data-story-card-index="0"] h2').first()
  ).toBeVisible()
  expect(await page.locator("#assurance-world video").getAttribute("src")).toBeNull()
  await context.close()
})

test("homepage canonical, social and structured metadata use the marketing origin", async ({
  page,
}) => {
  await page.goto("/")

  const metadata = await page.evaluate(() => ({
    canonical: document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href,
    alternates: Array.from(
      document.querySelectorAll<HTMLLinkElement>('link[rel="alternate"][hreflang]')
    ).map((link) => ({ language: link.hreflang, href: link.href })),
    ogUrl: document.querySelector<HTMLMetaElement>('meta[property="og:url"]')?.content,
    ogImage: document.querySelector<HTMLMetaElement>('meta[property="og:image"]')?.content,
    twitterImage: document.querySelector<HTMLMetaElement>('meta[name="twitter:image"]')?.content,
    title: document.querySelector<HTMLMetaElement>('meta[property="og:title"]')?.content,
    description: document.querySelector<HTMLMetaElement>("meta[name=description]")?.content,
    robots: document.querySelector<HTMLMetaElement>('meta[name="robots"]')?.content,
    structuredData: Array.from(
      document.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]')
    ).map((script) => script.textContent ?? ""),
  }))

  const publicOrigin = "https://lyrashieldai.com"
  expect(metadata.canonical).toBe(`${publicOrigin}/`)
  expect(metadata.ogUrl).toBe(`${publicOrigin}/`)
  expect(metadata.ogImage).toBeTruthy()
  if (metadata.ogImage) expect(new URL(metadata.ogImage).origin).toBe(publicOrigin)
  expect(metadata.twitterImage).toBe(metadata.ogImage)
  expect(metadata.title).toBeTruthy()
  expect(metadata.description).toBeTruthy()
  expect(metadata.robots).toMatch(/index,\s*follow/)
  expect(metadata.alternates).toEqual([
    { language: "en", href: `${publicOrigin}/` },
    { language: "x-default", href: `${publicOrigin}/` },
  ])

  const schemaUrls: string[] = []
  const collectSchemaUrls = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(collectSchemaUrls)
      return
    }
    if (typeof value !== "object" || value === null) return
    for (const [key, child] of Object.entries(value)) {
      if (["@id", "url"].includes(key) && typeof child === "string") schemaUrls.push(child)
      collectSchemaUrls(child)
    }
  }

  for (const json of metadata.structuredData) collectSchemaUrls(JSON.parse(json) as unknown)
  expect(schemaUrls.length).toBeGreaterThan(0)
  for (const url of schemaUrls) expect(new URL(url).origin).toBe(publicOrigin)
})

test("homepage reflows at common widths and with 200 percent root text sizing", async ({
  page,
}) => {
  for (const viewport of [
    { width: 320, height: 640 },
    { width: 390, height: 844 },
    { width: 768, height: 1024 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport)
    await page.goto("/")
    const layout = await page.evaluate(() => {
      const bounds = (selector: string) => {
        const element = document.querySelector(selector)
        if (!element) return null
        const rect = element.getBoundingClientRect()
        return { left: rect.left, right: rect.right }
      }
      return {
        documentWidth: document.documentElement.scrollWidth,
        bodyWidth: document.body.scrollWidth,
        title: bounds("#premium-hero-title"),
        primaryCta: bounds(".premium-hero__primary"),
        secondaryCta: bounds(".premium-hero__secondary"),
      }
    })

    expect(layout.documentWidth, `document overflow at ${viewport.width}px`).toBeLessThanOrEqual(
      viewport.width
    )
    expect(layout.bodyWidth, `body overflow at ${viewport.width}px`).toBeLessThanOrEqual(
      viewport.width
    )
    for (const bounds of [layout.title, layout.primaryCta, layout.secondaryCta]) {
      expect(bounds).not.toBeNull()
      expect(bounds!.left, `left clipping at ${viewport.width}px`).toBeGreaterThanOrEqual(0)
      expect(bounds!.right, `right clipping at ${viewport.width}px`).toBeLessThanOrEqual(
        viewport.width
      )
    }
    await expect(page.locator("#premium-hero-title")).toBeVisible()
    await expect(page.locator(".premium-hero__primary")).toBeVisible()
    await expect(page.locator(".premium-hero__secondary")).toBeVisible()
  }

  await page.setViewportSize({ width: 320, height: 800 })
  await page.goto("/")
  await page.addStyleTag({ content: "html { font-size: 200% !important; }" })
  await expect(page.locator("#premium-hero-title")).toBeVisible()
  const zoomedLayout = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    overflowingElements: Array.from(document.querySelectorAll<HTMLElement>("body *"))
      .map((element) => {
        const rect = element.getBoundingClientRect()
        const className = typeof element.className === "string" ? element.className : ""
        return {
          element: `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}${className ? `.${className.trim().replaceAll(" ", ".")}` : ""}`,
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          text: element.textContent?.trim().replaceAll(/\s+/g, " ").slice(0, 80) ?? "",
        }
      })
      .filter(({ right }) => right > innerWidth + 1)
      .sort((left, right) => right.right - left.right)
      .slice(0, 12),
    heroClip: (() => {
      const hero = document.querySelector(".premium-hero")
      if (!hero) return undefined
      const rect = hero.getBoundingClientRect()
      return {
        left: rect.left,
        right: rect.right,
        overflowX: getComputedStyle(hero).overflowX,
      }
    })(),
    menuTargets: Array.from(
      document.querySelectorAll<HTMLButtonElement>("#menu-toggle, #theme-toggle")
    ).map((button) => {
      const rect = button.getBoundingClientRect()
      return {
        label: button.getAttribute("aria-label"),
        width: rect.width,
        height: rect.height,
      }
    }),
    title: (() => {
      const rect = document.querySelector("#premium-hero-title")?.getBoundingClientRect()
      return rect ? { left: rect.left, right: rect.right } : undefined
    })(),
    primaryCta: (() => {
      const rect = document.querySelector(".premium-hero__primary")?.getBoundingClientRect()
      return rect ? { left: rect.left, right: rect.right } : undefined
    })(),
    secondaryCta: (() => {
      const rect = document.querySelector(".premium-hero__secondary")?.getBoundingClientRect()
      return rect ? { left: rect.left, right: rect.right } : undefined
    })(),
  }))
  expect(
    zoomedLayout.documentWidth,
    `document overflow at 200% text: ${JSON.stringify(zoomedLayout.overflowingElements)}`
  ).toBeLessThanOrEqual(320)
  expect(zoomedLayout.heroClip).toBeDefined()
  expect(zoomedLayout.heroClip!.overflowX).toBe("hidden")
  expect(
    zoomedLayout.heroClip!.left,
    "hero clip box begins inside the viewport"
  ).toBeGreaterThanOrEqual(0)
  expect(
    zoomedLayout.heroClip!.right,
    "hero clip box ends inside the viewport"
  ).toBeLessThanOrEqual(320)
  expect(zoomedLayout.menuTargets).toHaveLength(2)
  for (const target of zoomedLayout.menuTargets) {
    expect(target.label).toBeTruthy()
    expect(target.width).toBeGreaterThanOrEqual(44)
    expect(target.height).toBeGreaterThanOrEqual(44)
  }
  for (const bounds of [zoomedLayout.title, zoomedLayout.primaryCta, zoomedLayout.secondaryCta]) {
    expect(bounds).toBeDefined()
    expect(bounds!.left, "text clips on the left at 200% text").toBeGreaterThanOrEqual(0)
    expect(bounds!.right, "text clips on the right at 200% text").toBeLessThanOrEqual(320)
  }
})
