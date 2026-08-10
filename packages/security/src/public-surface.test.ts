import { describe, expect, it, vi } from "vitest"
import { getUrlScanProfile } from "@lyrashield/types"
import { collectPublicSurface, type SurfaceCollection } from "./public-surface"

type PendingFetch = { url: string; resolve: () => void }

function buildHtml(assets: string[]) {
  const tags = assets.map((asset) => `<script src="${asset}"></script>`).join("\n")
  return `<html><body>${tags}</body></html>`
}

function defaultResolver() {
  return vi.fn(async () => ["93.184.216.34"])
}

function defaultAssetBody(url: string) {
  return `// ${new URL(url).pathname}`
}

function immediateFetch(assets: string[], assetBody = defaultAssetBody) {
  const html = buildHtml(assets)
  const calls: string[] = []
  const fetchFn = vi.fn(async (url: string) => {
    calls.push(url)
    if (url === "https://example.com/") {
      return new Response(html, {
        status: 200,
        headers: { "content-type": "text/html" },
      })
    }
    return new Response(assetBody(url), {
      status: 200,
      headers: { "content-type": "application/javascript" },
    })
  })
  return { fetchFn, calls }
}

function documentFrom(collection: SurfaceCollection) {
  return collection.subjects.find((s) => s.kind === "document")
}

function assetsFrom(collection: SurfaceCollection) {
  return collection.subjects.filter((s) => s.kind === "asset").map((s) => s.requestedUrl)
}

function countIssues(collection: SurfaceCollection, code: string) {
  return collection.issues.filter((i) => i.code === code).length
}

function documentUrls(collection: SurfaceCollection) {
  return collection.subjects.filter((s) => s.kind === "document").map((s) => s.requestedUrl)
}

function sourceMaps(collection: SurfaceCollection) {
  return collection.subjects.filter((s) => s.kind === "source_map").map((s) => s.requestedUrl)
}

describe("collectPublicSurface", () => {
  it("collects the seed and at most six same-origin assets for Safe", async () => {
    const { fetchFn } = immediateFetch(["/a.js", "/b.js", "/c.js"])
    const collection = await collectPublicSurface({
      seedUrl: "https://example.com/",
      profile: getUrlScanProfile("WEB_APP", "SAFE"),
      userAgent: "LyraShield-Test/1.0",
      fetchFn,
      resolver: defaultResolver(),
    })

    expect(documentFrom(collection)?.requestedUrl).toBe("https://example.com/")
    expect(assetsFrom(collection)).toEqual([
      "https://example.com/a.js",
      "https://example.com/b.js",
      "https://example.com/c.js",
    ])
    expect(collection.issues).toHaveLength(0)
    expect(collection.totalBytes).toBeGreaterThan(0)
    expect(collection.truncated).toBe(false)
  })

  it("drops query and fragment data from discovered URLs", async () => {
    const { fetchFn } = immediateFetch(["/a.js?cache=1#inline", "/b.css?theme=dark", "/c.mjs"])

    const collection = await collectPublicSurface({
      seedUrl: "https://example.com/",
      profile: getUrlScanProfile("WEB_APP", "SAFE"),
      userAgent: "LyraShield-Test/1.0",
      fetchFn,
      resolver: defaultResolver(),
    })

    expect(assetsFrom(collection)).toEqual([
      "https://example.com/a.js",
      "https://example.com/b.css",
      "https://example.com/c.mjs",
    ])
    for (const subject of collection.subjects) {
      expect(subject.requestedUrl).not.toMatch(/[?#]/)
      expect(subject.finalUrl).not.toMatch(/[?#]/)
      for (const visited of subject.urlHistory) {
        expect(visited).not.toMatch(/[?#]/)
      }
    }
    for (const issue of collection.issues) {
      expect(issue.subject).not.toMatch(/[?#]/)
      expect(issue.reason).not.toMatch(/[?#]/)
    }
  })

  it("records a limit instead of claiming complete collection when an asset is oversized", async () => {
    const resolver = defaultResolver()
    const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
      if (url === "https://example.com/") {
        return new Response(buildHtml(["/big.js"]), {
          status: 200,
          headers: { "content-type": "text/html" },
        })
      }
      if (init.signal?.aborted) {
        throw new DOMException("aborted", "AbortError")
      }
      return new Response("x".repeat(4 * 1024 * 1024), {
        status: 200,
        headers: { "content-type": "application/javascript" },
      })
    })

    const profile = getUrlScanProfile("WEB_APP", "SAFE")
    const collection = await collectPublicSurface({
      seedUrl: "https://example.com/",
      profile,
      userAgent: "LyraShield-Test/1.0",
      fetchFn,
      resolver,
    })

    expect(collection.truncated).toBe(true)
    expect(countIssues(collection, "LIMIT_REACHED")).toBeGreaterThanOrEqual(1)
    const asset = collection.subjects.find((s) => s.kind === "asset")
    expect(asset?.bodyTruncated).toBe(true)
    expect(asset?.bodyBytes).toBeLessThanOrEqual(profile.maxResponseBytes)
  })

  it("records a fetch failure for a private or unreachable asset", async () => {
    const resolver = defaultResolver()
    const fetchFn = vi.fn(async (url: string) => {
      if (url === "https://example.com/") {
        return new Response(buildHtml(["/a.js", "/b.js"]), {
          status: 200,
          headers: { "content-type": "text/html" },
        })
      }
      if (url.includes("/b.js")) {
        throw new Error("connection refused")
      }
      return new Response(defaultAssetBody(url), {
        status: 200,
        headers: { "content-type": "application/javascript" },
      })
    })

    const collection = await collectPublicSurface({
      seedUrl: "https://example.com/",
      profile: getUrlScanProfile("WEB_APP", "SAFE"),
      userAgent: "LyraShield-Test/1.0",
      fetchFn,
      resolver,
    })

    expect(countIssues(collection, "FETCH_FAILED")).toBeGreaterThanOrEqual(1)
    expect(
      collection.issues.some((i) => i.code === "FETCH_FAILED" && i.subject.includes("b.js"))
    ).toBe(true)
    expect(collection.subjects.filter((s) => s.kind === "asset")).toHaveLength(1)
  })

  it("records an out-of-scope issue when an asset redirects to a different origin", async () => {
    const resolver = defaultResolver()
    const fetchFn = vi.fn(async (url: string) => {
      if (url === "https://example.com/") {
        return new Response(buildHtml(["/a.js"]), {
          status: 200,
          headers: { "content-type": "text/html" },
        })
      }
      if (url === "https://example.com/a.js") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://other.test/a.js" },
        })
      }
      if (url === "https://other.test/a.js") {
        return new Response("// other", {
          status: 200,
          headers: { "content-type": "application/javascript" },
        })
      }
      return new Response(defaultAssetBody(url), { status: 200 })
    })

    const collection = await collectPublicSurface({
      seedUrl: "https://example.com/",
      profile: getUrlScanProfile("WEB_APP", "SAFE"),
      userAgent: "LyraShield-Test/1.0",
      fetchFn,
      resolver,
    })

    expect(countIssues(collection, "OUT_OF_SCOPE")).toBeGreaterThanOrEqual(1)
    expect(collection.subjects.filter((s) => s.kind === "asset")).toHaveLength(0)
  })

  it("orders assets lexicographically", async () => {
    const { fetchFn } = immediateFetch(["/z.js", "/a.js", "/m.css", "/b.mjs"])

    const collection = await collectPublicSurface({
      seedUrl: "https://example.com/",
      profile: getUrlScanProfile("WEB_APP", "SAFE"),
      userAgent: "LyraShield-Test/1.0",
      fetchFn,
      resolver: defaultResolver(),
    })

    expect(assetsFrom(collection)).toEqual([
      "https://example.com/a.js",
      "https://example.com/b.mjs",
      "https://example.com/m.css",
      "https://example.com/z.js",
    ])
  })

  it("aborts when the caller signal is cancelled", async () => {
    const { fetchFn } = immediateFetch(["/a.js"])
    const controller = new AbortController()
    const promise = collectPublicSurface({
      seedUrl: "https://example.com/",
      profile: getUrlScanProfile("WEB_APP", "SAFE"),
      userAgent: "LyraShield-Test/1.0",
      fetchFn,
      resolver: defaultResolver(),
      signal: controller.signal,
    })

    controller.abort()
    const collection = await promise

    expect(collection.truncated).toBe(true)
    expect(countIssues(collection, "LIMIT_REACHED")).toBeGreaterThanOrEqual(1)
  })

  it("cancels when the wall-time budget expires", async () => {
    const resolver = defaultResolver()
    const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
      if (url === "https://example.com/") {
        return new Response(buildHtml(["/slow.js"]), {
          status: 200,
          headers: { "content-type": "text/html" },
        })
      }
      if (init.signal?.aborted) {
        throw new DOMException("aborted", "AbortError")
      }
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true }
        )
      })
    })

    const profile = getUrlScanProfile("WEB_APP", "SAFE")
    const collection = await collectPublicSurface({
      seedUrl: "https://example.com/",
      profile: { ...profile, maxWallTimeMs: 50 },
      userAgent: "LyraShield-Test/1.0",
      fetchFn,
      resolver,
    })

    expect(collection.truncated).toBe(true)
    expect(countIssues(collection, "LIMIT_REACHED")).toBeGreaterThanOrEqual(1)
  })

  it("bounds concurrency to the profile limit", async () => {
    const pending: PendingFetch[] = []
    let inFlight = 0
    let maxInFlight = 0
    const resolver = defaultResolver()

    const resolveOne = () => {
      const p = pending.shift()
      p?.resolve()
    }

    const assetFetch = vi.fn((url: string, init: RequestInit) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      if (init.signal?.aborted) {
        inFlight--
        throw new DOMException("aborted", "AbortError")
      }
      return new Promise<Response>((resolve, reject) => {
        const onAbort = () => {
          inFlight--
          reject(new DOMException("aborted", "AbortError"))
        }
        init.signal?.addEventListener("abort", onAbort, { once: true })
        pending.push({
          url,
          resolve: () => {
            init.signal?.removeEventListener("abort", onAbort)
            inFlight--
            resolve(
              new Response(`// ${new URL(url).pathname}`, {
                status: 200,
                headers: { "content-type": "application/javascript" },
              })
            )
          },
        })
      })
    })

    const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
      if (url === "https://example.com/") {
        return new Response(buildHtml(["/a.js", "/b.js", "/c.js"]), {
          status: 200,
          headers: { "content-type": "text/html" },
        })
      }
      return assetFetch(url, init)
    })

    const profile = getUrlScanProfile("WEB_APP", "SAFE")
    const promise = collectPublicSurface({
      seedUrl: "https://example.com/",
      profile: { ...profile, maxConcurrency: 2, maxAssets: 3 },
      userAgent: "LyraShield-Test/1.0",
      fetchFn,
      resolver,
    })

    // Wait for both concurrency slots to fill.
    while (pending.length < 2) {
      await new Promise((r) => setTimeout(r, 0))
    }
    expect(maxInFlight).toBe(2)

    resolveOne()
    // Wait for the third fetch to be scheduled.
    while (pending.length < 2) {
      await new Promise((r) => setTimeout(r, 0))
    }
    expect(maxInFlight).toBeLessThanOrEqual(2)

    while (pending.length > 0) {
      resolveOne()
    }
    const collection = await promise

    expect(maxInFlight).toBe(2)
    expect(collection.subjects.filter((s) => s.kind === "asset")).toHaveLength(3)
  })

  it("respects the total byte budget", async () => {
    const resolver = defaultResolver()
    const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
      if (url === "https://example.com/") {
        return new Response(buildHtml(["/a.js", "/b.js", "/c.js"]), {
          status: 200,
          headers: { "content-type": "text/html" },
        })
      }
      if (init.signal?.aborted) {
        throw new DOMException("aborted", "AbortError")
      }
      return new Response("x".repeat(1024), { status: 200 })
    })

    const profile = getUrlScanProfile("WEB_APP", "SAFE")
    const collection = await collectPublicSurface({
      seedUrl: "https://example.com/",
      profile: { ...profile, maxTotalBytes: 2000 },
      userAgent: "LyraShield-Test/1.0",
      fetchFn,
      resolver,
    })

    expect(collection.totalBytes).toBeLessThanOrEqual(2000)
    expect(countIssues(collection, "LIMIT_REACHED")).toBeGreaterThanOrEqual(1)
  })
})

describe("Standard web discovery", () => {
  function buildStandardFetch(
    pages: Record<
      string,
      { html?: string; status?: number; headers?: Record<string, string>; redirect?: string }
    >
  ) {
    return vi.fn(async (url: string, init: RequestInit) => {
      if (init.signal?.aborted) {
        throw new DOMException("aborted", "AbortError")
      }
      const page = pages[url]
      if (!page) {
        return new Response("not found", { status: 404 })
      }
      if (page.redirect) {
        return new Response(null, {
          status: 302,
          headers: { location: page.redirect, "content-type": "text/html" },
        })
      }
      return new Response(page.html ?? "", {
        status: page.status ?? 200,
        headers: { "content-type": "text/html", ...(page.headers ?? {}) },
      })
    })
  }

  const graphBase = {
    "https://example.com/": {
      html: `<html><body>
        <a href="/about">about</a>
        <a href="/account">account</a>
        <a href="/docs">docs</a>
        <a href="https://outside.example/path">outside</a>
        <script src="/a.js"></script>
      </body></html>`,
    },
    "https://example.com/about": {
      html: `<html><body>
        <a href="/contact">contact</a>
        <script src="/about.js"></script>
      </body></html>`,
    },
    "https://example.com/account": { html: "<html><body>account</body></html>" },
    "https://example.com/docs": { html: "<html><body>docs</body></html>" },
    "https://example.com/contact": { html: "<html><body>contact</body></html>" },
    "https://example.com/a.js": {
      html: "// a",
      headers: { "content-type": "application/javascript" },
    },
    "https://example.com/about.js": {
      html: "// about",
      headers: { "content-type": "application/javascript" },
    },
  }

  it("performs bounded BFS, drops cross-origin links, and reports truncation", async () => {
    const fetchFn = buildStandardFetch(graphBase)
    const profile = getUrlScanProfile("WEB_APP", "STANDARD")
    const collection = await collectPublicSurface({
      seedUrl: "https://example.com/",
      profile: { ...profile, maxDocuments: 4 },
      userAgent: "LyraShield-Test/1.0",
      fetchFn,
      resolver: defaultResolver(),
    })

    expect(documentUrls(collection)).toEqual([
      "https://example.com/",
      "https://example.com/about",
      "https://example.com/account",
      "https://example.com/docs",
    ])
    expect(documentUrls(collection)).not.toContain("https://outside.example/path")
    expect(documentUrls(collection)).not.toContain("https://example.com/contact")
    expect(collection.subjects.filter((s) => s.kind === "document").length).toBeLessThanOrEqual(4)
    expect(collection.truncated).toBe(true)
    expect(countIssues(collection, "LIMIT_REACHED")).toBeGreaterThanOrEqual(1)
  })

  it("reaches depth 2 when the document limit allows", async () => {
    const fetchFn = buildStandardFetch(graphBase)
    const profile = getUrlScanProfile("WEB_APP", "STANDARD")
    const collection = await collectPublicSurface({
      seedUrl: "https://example.com/",
      profile: { ...profile, maxDocuments: 5 },
      userAgent: "LyraShield-Test/1.0",
      fetchFn,
      resolver: defaultResolver(),
    })

    expect(documentUrls(collection)).toContain("https://example.com/contact")
    expect(collection.subjects.filter((s) => s.kind === "document").length).toBe(5)
  })

  it("orders discovered documents deterministically regardless of HTML link order", async () => {
    const fetchFn = buildStandardFetch({
      ...graphBase,
      "https://example.com/": {
        html: `<html><body>
          <a href="/docs">docs</a>
          <a href="/account">account</a>
          <a href="/about">about</a>
          <a href="https://outside.example/path">outside</a>
          <script src="/a.js"></script>
        </body></html>`,
      },
    })
    const profile = getUrlScanProfile("WEB_APP", "STANDARD")
    const collection = await collectPublicSurface({
      seedUrl: "https://example.com/",
      profile: { ...profile, maxDocuments: 4 },
      userAgent: "LyraShield-Test/1.0",
      fetchFn,
      resolver: defaultResolver(),
    })

    expect(documentUrls(collection)).toEqual([
      "https://example.com/",
      "https://example.com/about",
      "https://example.com/account",
      "https://example.com/docs",
    ])
  })

  it("collects robots and sitemap declarations and turns <loc> entries into documents", async () => {
    const fetchFn = buildStandardFetch({
      ...graphBase,
      "https://example.com/robots.txt": {
        html: "Sitemap: https://example.com/sitemap-robots.xml",
        headers: { "content-type": "text/plain" },
      },
      "https://example.com/sitemap.xml": {
        html: "<urlset></urlset>",
        headers: { "content-type": "application/xml" },
      },
      "https://example.com/sitemap-robots.xml": {
        html: `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.com/sitemap-page</loc></url></urlset>`,
        headers: { "content-type": "application/xml" },
      },
      "https://example.com/sitemap-page": { html: "<html><body>sitemap page</body></html>" },
    })
    const profile = getUrlScanProfile("WEB_APP", "STANDARD")
    const collection = await collectPublicSurface({
      seedUrl: "https://example.com/",
      profile: { ...profile, maxDocuments: 10 },
      userAgent: "LyraShield-Test/1.0",
      fetchFn,
      resolver: defaultResolver(),
    })

    expect(collection.subjects.some((s) => s.kind === "robots")).toBe(true)
    expect(collection.subjects.some((s) => s.kind === "sitemap")).toBe(true)
    expect(documentUrls(collection)).toContain("https://example.com/sitemap-page")
  })

  it("records an out-of-scope issue when a sitemap entry redirects off-origin", async () => {
    const fetchFn = buildStandardFetch({
      ...graphBase,
      "https://example.com/sitemap.xml": {
        html: `<urlset><url><loc>https://example.com/redirect-to-private</loc></url></urlset>`,
        headers: { "content-type": "application/xml" },
      },
      "https://example.com/redirect-to-private": {
        redirect: "https://other.test/page",
      },
      "https://other.test/page": { html: "<html><body>other</body></html>" },
    })
    const profile = getUrlScanProfile("WEB_APP", "STANDARD")
    const collection = await collectPublicSurface({
      seedUrl: "https://example.com/",
      profile,
      userAgent: "LyraShield-Test/1.0",
      fetchFn,
      resolver: defaultResolver(),
    })

    expect(documentUrls(collection)).not.toContain("https://other.test/page")
    expect(countIssues(collection, "OUT_OF_SCOPE")).toBeGreaterThanOrEqual(1)
  })

  it("records the asset limit and keeps asset count within the profile", async () => {
    const fetchFn = buildStandardFetch(graphBase)
    const profile = getUrlScanProfile("WEB_APP", "STANDARD")
    const collection = await collectPublicSurface({
      seedUrl: "https://example.com/",
      profile: { ...profile, maxAssets: 1 },
      userAgent: "LyraShield-Test/1.0",
      fetchFn,
      resolver: defaultResolver(),
    })

    expect(collection.subjects.filter((s) => s.kind === "asset").length).toBeLessThanOrEqual(1)
    expect(countIssues(collection, "LIMIT_REACHED")).toBeGreaterThanOrEqual(1)
  })

  it("fetches same-origin source maps referenced by collected assets", async () => {
    const fetchFn = buildStandardFetch({
      ...graphBase,
      "https://example.com/about.js": {
        html: "// about\n//# sourceMappingURL=/about.js.map",
        headers: { "content-type": "application/javascript" },
      },
      "https://example.com/about.js.map": {
        html: '{"version":3,"sources":["about.js"]}',
        headers: { "content-type": "application/json" },
      },
    })
    const profile = getUrlScanProfile("WEB_APP", "STANDARD")
    const collection = await collectPublicSurface({
      seedUrl: "https://example.com/",
      profile,
      userAgent: "LyraShield-Test/1.0",
      fetchFn,
      resolver: defaultResolver(),
    })

    expect(sourceMaps(collection)).toContain("https://example.com/about.js.map")
    expect(collection.subjects.some((s) => s.kind === "source_map")).toBe(true)
  })

  it("aborts when the caller signal is cancelled", async () => {
    const fetchFn = buildStandardFetch(graphBase)
    const controller = new AbortController()
    const profile = getUrlScanProfile("WEB_APP", "STANDARD")
    const promise = collectPublicSurface({
      seedUrl: "https://example.com/",
      profile: { ...profile, maxDocuments: 100 },
      userAgent: "LyraShield-Test/1.0",
      fetchFn,
      resolver: defaultResolver(),
      signal: controller.signal,
    })

    controller.abort()
    const collection = await promise

    expect(collection.truncated).toBe(true)
    expect(countIssues(collection, "LIMIT_REACHED")).toBeGreaterThanOrEqual(1)
  })
})
