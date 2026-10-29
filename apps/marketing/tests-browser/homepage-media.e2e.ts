import { expect, test } from "@playwright/test"

const productImage =
  /\/product\/current-(?:posture|findings|agents|readiness|scan)-(?:dark|light)\.webp$/
const heroImage = /assurance-world\/v3\/[^/]+\/posters\/gateway-(?:desktop|portrait)\.webp$/
const motionVideo = /assurance-world\.(?:mp4|webm)$/
const productImageDimensions = new Map([
  ["/product/current-posture-dark.webp", [1600, 597]],
  ["/product/current-posture-light.webp", [1600, 597]],
  ["/product/current-findings-dark.webp", [960, 834]],
  ["/product/current-findings-light.webp", [960, 834]],
  ["/product/current-agents-dark.webp", [1600, 690]],
  ["/product/current-agents-light.webp", [1600, 690]],
  ["/product/current-readiness-dark.webp", [1600, 604]],
  ["/product/current-readiness-light.webp", [1600, 604]],
  ["/product/current-scan-dark.webp", [1600, 640]],
  ["/product/current-scan-light.webp", [1600, 640]],
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
    expect(heroPoster.alt).toBe("") // Decorative world; the real headline and story are HTML.
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
    expect(screenshotContract).toHaveLength(10)
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

    // Unselected views and the opposite theme stay lazy even when the gallery
    // enters the viewport.
    await page.waitForTimeout(500)
    const initialProductRequests = requests.filter((path) => productImage.test(path))
    expect(initialProductRequests.length).toBeLessThanOrEqual(1)
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
      .toBe(1)

    const expectedSuffix = "-" + theme + ".webp"
    expect(requests.filter((path) => productImage.test(path))).toEqual([
      "/product/current-posture" + expectedSuffix,
    ])
    for (const [view, asset] of [
      ["overview", "posture"],
      ["findings", "findings"],
      ["scan", "scan"],
      ["readiness", "readiness"],
      ["agents", "agents"],
    ]) {
      await page.locator(`[data-product-select="${view}"]`).click()
      const image = page.locator(".hero-frame__img:visible")
      await expect(image).toHaveCount(1)
      await expect
        .poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth))
        .toBeGreaterThan(0)
      const imageName = "current-" + asset
      const loaded = requests.filter((path) => productImage.test(path))
      const paths = loaded.filter((path) => path.includes(`/${imageName}`))
      expect(paths.length, `${imageName} must load exactly once`).toBe(1)
      expect(paths[0].endsWith(expectedSuffix), `${imageName} must match the theme`).toBe(true)
    }
    await context.close()
  }
})

test("the evidence artifact adds no second decoder and reduced motion downloads no film", async ({
  browser,
}) => {
  for (const reducedMotion of ["reduce", "no-preference"] as const) {
    const context = await browser.newContext({ reducedMotion })
    const page = await context.newPage()
    const videos: string[] = []
    page.on("request", (request) => {
      if (motionVideo.test(request.url())) videos.push(request.url())
    })
    await page.goto("/")
    await page.locator("#assurance-world").scrollIntoViewIfNeeded()
    await expect(page.locator("#assurance-world video")).toHaveCount(0)
    await expect(page.locator(".journey__artifact")).toContainText("Finding EX-014")
    if (reducedMotion === "reduce") expect(videos).toEqual([])
    else {
      await expect(page.locator("scroll-world")).toHaveAttribute("data-world-state", "ready")
      expect(videos.length).toBeGreaterThan(0)
      expect(new Set(videos).size).toBe(1)
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
  await expect(page.locator(".hero-frame__caption").first()).toBeVisible()
  await expect(page.locator("[data-product-panel]:visible")).toHaveCount(5)
  await page.locator("#assurance-world").scrollIntoViewIfNeeded()
  await expect(page.locator(".journey__chapter h3").first()).toBeVisible()
  await expect(page.locator(".journey__report")).toBeVisible()
  await expect(page.locator("[data-product-expand]:visible")).toHaveCount(0)
  await expect(page.locator("#assurance-world video")).toHaveCount(0)
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
    journeyNav: (() => {
      const nav = document.querySelector(".journey__nav")
      if (!nav) return undefined
      const rect = nav.getBoundingClientRect()
      return { left: rect.left, right: rect.right, width: rect.width }
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
  expect(zoomedLayout.journeyNav).toBeDefined()
  expect(zoomedLayout.journeyNav!.left).toBeGreaterThanOrEqual(0)
  expect(zoomedLayout.journeyNav!.right).toBeLessThanOrEqual(320)
  expect(zoomedLayout.journeyNav!.width).toBeGreaterThan(200)
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
