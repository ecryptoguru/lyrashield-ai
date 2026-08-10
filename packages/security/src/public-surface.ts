import {
  URL_SCAN_CONTRACT_VERSION,
  type UrlRequestMethod,
  type UrlScanProfile,
} from "@lyrashield/types"
import { redactUrlForLogs, type HostResolver } from "./ssrf"
import {
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_TIMEOUT_MS,
  safeFetchDetailed,
  type SafeFetchResult,
} from "./safe-fetch"

export type SurfaceSubjectKind =
  | "document"
  | "asset"
  | "robots"
  | "sitemap"
  | "source_map"
  | "api_spec"
  | "api_operation"
  | "probe"

export type SurfaceSubject = {
  kind: SurfaceSubjectKind
  requestedUrl: string
  finalUrl: string
  urlHistory: string[]
  method: UrlRequestMethod
  status: number
  headers: Record<string, string>
  body: string
  bodyBytes: number
  bodyTruncated: boolean
  depth: number
}

export type SurfaceCollectionIssue = {
  code:
    | "FETCH_FAILED"
    | "LIMIT_REACHED"
    | "OUT_OF_SCOPE"
    | "UNSUPPORTED_CONTENT"
    | "AUTHENTICATION_REQUIRED"
    | "PARAMETER_VALUE_UNAVAILABLE"
    | "SCHEMA_UNSUPPORTED"
  subject: string
  reason: string
}

export type SurfaceCollection = {
  seedUrl: string
  finalOrigin: string
  contractVersion: typeof URL_SCAN_CONTRACT_VERSION
  profile: UrlScanProfile
  subjects: SurfaceSubject[]
  issues: SurfaceCollectionIssue[]
  totalBytes: number
  truncated: boolean
}

function normalizeUrl(raw: string): string | null {
  try {
    const url = new URL(raw)
    if (!["http:", "https:"].includes(url.protocol)) return null
    url.username = ""
    url.password = ""
    url.search = ""
    url.hash = ""
    return url.toString()
  } catch {
    return null
  }
}

function normalizeDiscoveredUrl(raw: string, base: string, allowedOrigin: string): string | null {
  try {
    const url = new URL(raw, base)
    if (!["http:", "https:"].includes(url.protocol) || url.origin !== allowedOrigin) {
      return null
    }
    url.username = ""
    url.password = ""
    url.search = ""
    url.hash = ""
    return url.toString()
  } catch {
    return null
  }
}

function describeOutcome(result: { ok: false; reason: string; detail?: string }): string {
  const reasons: Record<string, string> = {
    ssrf_blocked: "blocked by the SSRF guard",
    dns_timeout: "DNS resolution timed out",
    request_failed: "the connection failed",
    invalid_response: "the server returned a malformed response",
    redirect_no_location: "the redirect had no Location header",
    redirect_invalid_url: "the redirect target was unparseable",
    too_many_redirects: "too many redirects",
    body_read_failed: "the response body could not be read",
    aborted: "the scan phase was cancelled",
  }
  const base = reasons[result.reason] ?? result.reason
  return result.detail ? `${base} (${result.detail})` : base
}

function issue(
  code: SurfaceCollectionIssue["code"],
  subject: string,
  reason: string
): SurfaceCollectionIssue {
  return {
    code,
    subject: redactUrlForLogs(subject),
    reason: reason.replace(/\?[^\s]*/g, "").replace(/#[^\s]*/g, ""),
  }
}

function toSubject(
  kind: SurfaceSubjectKind,
  requestedUrl: string,
  result: SafeFetchResult,
  depth: number
): SurfaceSubject {
  return {
    kind,
    requestedUrl: redactUrlForLogs(requestedUrl),
    finalUrl: redactUrlForLogs(result.finalUrl),
    urlHistory: result.urlHistory.map(redactUrlForLogs),
    method: "GET",
    status: result.status,
    headers: result.headers,
    body: result.html,
    bodyBytes: result.bodyBytes,
    bodyTruncated: result.bodyTruncated,
    depth,
  }
}

function contentType(headers: Record<string, string>): string {
  return (headers["content-type"] ?? "").toLowerCase().split(";")[0]!.trim()
}

function isHtml(headers: Record<string, string>): boolean {
  return contentType(headers) === "text/html"
}

function isXml(headers: Record<string, string>): boolean {
  return ["application/xml", "text/xml"].includes(contentType(headers))
}

function isPlainText(headers: Record<string, string>): boolean {
  return contentType(headers) === "text/plain"
}

function extractAssetUrls(html: string, base: string, allowedOrigin: string): string[] {
  const urls = new Set<string>()
  const attributes = html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)
  for (const match of attributes) {
    const raw = match[1]
    if (!raw) continue
    const normalized = normalizeDiscoveredUrl(raw, base, allowedOrigin)
    if (!normalized) continue
    const url = new URL(normalized)
    if (!/\.(?:m?js|css)$/i.test(url.pathname)) continue
    urls.add(normalized)
  }
  return [...urls].sort()
}

function extractAnchorUrls(html: string, base: string, allowedOrigin: string): string[] {
  const urls = new Set<string>()
  const attributes = html.matchAll(/\b(?:href)\s*=\s*["']([^"']+)["']/gi)
  for (const match of attributes) {
    const raw = match[1]
    if (!raw) continue
    const normalized = normalizeDiscoveredUrl(raw, base, allowedOrigin)
    if (!normalized) continue
    const url = new URL(normalized)
    // Drop non-HTML assets and fragments/queries already stripped.
    if (
      /\.(?:m?js|css|png|jpe?g|gif|svg|webp|ico|pdf|zip|tar\.gz|mp4|webm|ogg|woff2?|ttf|eot)$/i.test(
        url.pathname
      )
    ) {
      continue
    }
    urls.add(normalized)
  }
  return [...urls].sort()
}

function extractRobotsSitemaps(text: string, allowedOrigin: string): string[] {
  const urls = new Set<string>()
  const lines = text.matchAll(/^Sitemap:\s*(.+)$/gim)
  for (const match of lines) {
    const raw = match[1]?.trim()
    if (!raw) continue
    const normalized = normalizeDiscoveredUrl(raw, "https://placeholder.test/", allowedOrigin)
    if (normalized) urls.add(normalized)
  }
  return [...urls].sort()
}

function extractSitemapUrls(xml: string, allowedOrigin: string): string[] {
  const urls = new Set<string>()
  const locs = xml.matchAll(/<loc>([^<]+)<\/loc>/gi)
  for (const match of locs) {
    const raw = match[1]?.trim()
    if (!raw) continue
    const normalized = normalizeDiscoveredUrl(raw, "https://placeholder.test/", allowedOrigin)
    if (normalized) urls.add(normalized)
  }
  return [...urls].sort()
}

function extractSourceMapReferences(body: string, base: string, allowedOrigin: string): string[] {
  const urls = new Set<string>()
  const patterns = [/sourceMappingURL\s*=\s*([^\s"'<>]+)/gi, /sourceMap\s*=\s*["']([^"']+)["']/gi]
  for (const pattern of patterns) {
    for (const match of body.matchAll(pattern)) {
      const raw = match[1]?.trim()
      if (!raw) continue
      const normalized = normalizeDiscoveredUrl(raw, base, allowedOrigin)
      if (normalized) urls.add(normalized)
    }
  }
  return [...urls].sort()
}

function combineSignal(
  wallTimeMs: number,
  externalSignal?: AbortSignal
): { controller: AbortController; signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), wallTimeMs)

  const onExternalAbort = () => controller.abort()
  externalSignal?.addEventListener("abort", onExternalAbort, { once: true })

  const cleanup = () => {
    clearTimeout(timer)
    externalSignal?.removeEventListener("abort", onExternalAbort)
  }

  return { controller, signal: controller.signal, cleanup }
}

export async function collectPublicSurface(options: {
  seedUrl: string
  profile: UrlScanProfile
  userAgent?: string
  fetchFn?: typeof fetch
  resolver?: HostResolver
  signal?: AbortSignal
}): Promise<SurfaceCollection> {
  const { seedUrl, profile, userAgent, fetchFn, resolver, signal: externalSignal } = options

  const seed = normalizeUrl(seedUrl)
  const issues: SurfaceCollectionIssue[] = []
  const subjects: SurfaceSubject[] = []
  let totalBytes = 0
  let truncated = false

  if (!seed) {
    issues.push(issue("FETCH_FAILED", seedUrl, "The seed URL was not a valid HTTP/HTTPS URL."))
    return {
      seedUrl: redactUrlForLogs(seedUrl),
      finalOrigin: "",
      contractVersion: URL_SCAN_CONTRACT_VERSION,
      profile,
      subjects,
      issues,
      totalBytes,
      truncated,
    }
  }

  const { signal, cleanup } = combineSignal(profile.maxWallTimeMs, externalSignal)

  try {
    const seedOutcome = await safeFetchDetailed(seed, {
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxRedirects: DEFAULT_MAX_REDIRECTS,
      maxBytes: Math.min(profile.maxResponseBytes, profile.maxTotalBytes),
      userAgent,
      fetchFn,
      resolver,
      signal,
    })

    if (!seedOutcome.ok) {
      if (signal.aborted) {
        truncated = true
        issues.push(issue("LIMIT_REACHED", seed, "Scan wall-time budget was exhausted."))
      } else {
        issues.push(issue("FETCH_FAILED", seed, describeOutcome(seedOutcome)))
      }
      return {
        seedUrl: redactUrlForLogs(seed),
        finalOrigin: "",
        contractVersion: URL_SCAN_CONTRACT_VERSION,
        profile,
        subjects,
        issues,
        totalBytes,
        truncated,
      }
    }

    const seedResult = seedOutcome.result
    const finalOrigin = new URL(seedResult.finalUrl).origin
    subjects.push(toSubject("document", seed, seedResult, 0))
    totalBytes += seedResult.bodyBytes
    if (seedResult.bodyTruncated) {
      truncated = true
      issues.push(
        issue(
          "LIMIT_REACHED",
          seedResult.finalUrl,
          `Response body truncated at ${seedResult.bodyBytes} bytes.`
        )
      )
    }

    if (profile.mode === "SAFE" && profile.targetType === "WEB_APP") {
      const { totalBytes: updated, truncated: isTruncated } = await collectSafeAssets({
        seed,
        seedResult,
        finalOrigin,
        profile,
        subjects,
        issues,
        totalBytes,
        truncated,
        userAgent,
        fetchFn,
        resolver,
        signal,
      })
      totalBytes = updated
      truncated = isTruncated
    } else if (profile.mode !== "SAFE" || profile.targetType !== "WEB_APP") {
      const { totalBytes: updated, truncated: isTruncated } = await collectExpandedSurface({
        seed,
        seedResult,
        finalOrigin,
        profile,
        subjects,
        issues,
        totalBytes,
        truncated,
        userAgent,
        fetchFn,
        resolver,
        signal,
      })
      totalBytes = updated
      truncated = isTruncated
    }

    return {
      seedUrl: redactUrlForLogs(seed),
      finalOrigin,
      contractVersion: URL_SCAN_CONTRACT_VERSION,
      profile,
      subjects,
      issues,
      totalBytes,
      truncated,
    }
  } finally {
    cleanup()
  }
}

async function collectSafeAssets(ctx: {
  seed: string
  seedResult: SafeFetchResult
  finalOrigin: string
  profile: UrlScanProfile
  subjects: SurfaceSubject[]
  issues: SurfaceCollectionIssue[]
  totalBytes: number
  truncated: boolean
  userAgent?: string
  fetchFn?: typeof fetch
  resolver?: HostResolver
  signal: AbortSignal
}) {
  let truncated = ctx.truncated
  const assetUrls = extractAssetUrls(ctx.seedResult.html, ctx.seedResult.finalUrl, ctx.finalOrigin)
  const cappedAssets = assetUrls.slice(0, ctx.profile.maxAssets)
  if (cappedAssets.length < assetUrls.length) {
    truncated = true
    ctx.issues.push(
      issue(
        "LIMIT_REACHED",
        ctx.seedResult.finalUrl,
        `Asset limit of ${ctx.profile.maxAssets} reached.`
      )
    )
  }

  let reservedBytes = 0
  const executing = new Set<Promise<void>>()

  for (const assetUrl of cappedAssets) {
    if (ctx.signal.aborted) {
      truncated = true
      ctx.issues.push(issue("LIMIT_REACHED", assetUrl, "Scan wall-time budget was exhausted."))
      break
    }

    const remaining = ctx.profile.maxTotalBytes - ctx.totalBytes - reservedBytes
    if (remaining <= 0) {
      truncated = true
      ctx.issues.push(
        issue(
          "LIMIT_REACHED",
          ctx.seedResult.finalUrl,
          `Total byte budget of ${ctx.profile.maxTotalBytes} bytes reached.`
        )
      )
      break
    }

    const maxSpend = Math.min(ctx.profile.maxResponseBytes, remaining)
    reservedBytes += maxSpend

    const task = (async () => {
      try {
        const outcome = await safeFetchDetailed(assetUrl, {
          timeoutMs: DEFAULT_TIMEOUT_MS,
          maxRedirects: DEFAULT_MAX_REDIRECTS,
          maxBytes: maxSpend,
          userAgent: ctx.userAgent,
          fetchFn: ctx.fetchFn,
          resolver: ctx.resolver,
          signal: ctx.signal,
        })

        if (!outcome.ok) {
          if (ctx.signal.aborted) {
            truncated = true
            ctx.issues.push(
              issue("LIMIT_REACHED", assetUrl, "Scan wall-time budget was exhausted.")
            )
          } else {
            ctx.issues.push(issue("FETCH_FAILED", assetUrl, describeOutcome(outcome)))
          }
          return
        }

        const result = outcome.result
        if (new URL(result.finalUrl).origin !== ctx.finalOrigin) {
          ctx.issues.push(
            issue("OUT_OF_SCOPE", result.finalUrl, "Asset redirected out of the target origin.")
          )
          return
        }

        ctx.subjects.push(toSubject("asset", assetUrl, result, 1))
        ctx.totalBytes += result.bodyBytes
        if (result.bodyTruncated) {
          truncated = true
          ctx.issues.push(
            issue(
              "LIMIT_REACHED",
              result.finalUrl,
              `Response body truncated at ${result.bodyBytes} bytes.`
            )
          )
        }
      } finally {
        reservedBytes -= maxSpend
      }
    })()

    executing.add(task)
    task.finally(() => executing.delete(task))

    if (executing.size >= ctx.profile.maxConcurrency) {
      await Promise.race(executing)
    }
  }

  await Promise.all(executing)

  ctx.truncated = truncated
  return { totalBytes: ctx.totalBytes, truncated }
}

type WorkItem =
  | { kind: "document"; url: string; depth: number }
  | { kind: "robots"; url: string }
  | { kind: "sitemap"; url: string }
  | { kind: "asset"; url: string; sourceMap: boolean }

async function collectExpandedSurface(ctx: {
  seed: string
  seedResult: SafeFetchResult
  finalOrigin: string
  profile: UrlScanProfile
  subjects: SurfaceSubject[]
  issues: SurfaceCollectionIssue[]
  totalBytes: number
  truncated: boolean
  userAgent?: string
  fetchFn?: typeof fetch
  resolver?: HostResolver
  signal: AbortSignal
}) {
  let truncated = ctx.truncated
  const queue: { url: string; depth: number }[] = []
  const seen = new Set<string>([ctx.seed])
  const pendingAssets: WorkItem[] = []
  const pendingSitemaps: WorkItem[] = []
  const executing = new Set<Promise<void>>()
  let reservedBytes = 0
  let documentCount = 1 // seed is already recorded
  let assetCount = 0
  let sourceMapCount = 0

  const addDocumentToQueue = (url: string, depth: number) => {
    if (seen.has(url)) return
    if (depth > ctx.profile.maxDepth) return
    if (documentCount >= ctx.profile.maxDocuments) {
      if (!seen.has(url)) {
        truncated = true
        seen.add(url)
        ctx.issues.push(
          issue(
            "LIMIT_REACHED",
            ctx.seedResult.finalUrl,
            `Document limit of ${ctx.profile.maxDocuments} reached.`
          )
        )
      }
      return
    }
    seen.add(url)
    queue.push({ url, depth })
  }

  const addAssets = (urls: string[]) => {
    for (const url of urls) {
      if (assetCount + pendingAssets.length >= ctx.profile.maxAssets) {
        truncated = true
        ctx.issues.push(
          issue(
            "LIMIT_REACHED",
            ctx.seedResult.finalUrl,
            `Asset limit of ${ctx.profile.maxAssets} reached.`
          )
        )
        break
      }
      pendingAssets.push({ kind: "asset", url, sourceMap: false })
    }
  }

  const addSourceMap = (url: string) => {
    if (sourceMapCount >= 5) return
    if (assetCount + pendingAssets.length >= ctx.profile.maxAssets) return
    sourceMapCount++
    pendingAssets.push({ kind: "asset", url, sourceMap: true })
  }

  const addSitemapUrls = (urls: string[]) => {
    for (const url of urls) {
      if (!seen.has(url)) {
        seen.add(url)
        pendingSitemaps.push({ kind: "sitemap", url })
      }
    }
  }

  const addRobotsSitemaps = (urls: string[]) => {
    for (const url of urls) {
      if (!seen.has(url)) {
        seen.add(url)
        pendingSitemaps.push({ kind: "sitemap", url })
      }
    }
  }

  // The seed was already fetched and recorded. Start BFS from its links and
  // assets, then fetch the common discovery endpoints.
  const seedAnchors = extractAnchorUrls(
    ctx.seedResult.html,
    ctx.seedResult.finalUrl,
    ctx.finalOrigin
  )
    .filter((url) => !seen.has(url))
    .sort((a, b) => a.localeCompare(b))
  for (const url of seedAnchors) {
    addDocumentToQueue(url, 1)
  }

  const seedAssets = extractAssetUrls(ctx.seedResult.html, ctx.seedResult.finalUrl, ctx.finalOrigin)
  addAssets(seedAssets)

  // Seed common discovery endpoints once, at the start of the crawl.
  if (ctx.profile.maxDepth > 0) {
    const robotsUrl = normalizeDiscoveredUrl(
      "/robots.txt",
      ctx.seedResult.finalUrl,
      ctx.finalOrigin
    )
    if (robotsUrl) pendingSitemaps.push({ kind: "robots", url: robotsUrl })

    const rootSitemapUrl = normalizeDiscoveredUrl(
      "/sitemap.xml",
      ctx.seedResult.finalUrl,
      ctx.finalOrigin
    )
    if (rootSitemapUrl && !seen.has(rootSitemapUrl)) {
      seen.add(rootSitemapUrl)
      pendingSitemaps.push({ kind: "sitemap", url: rootSitemapUrl })
    }
  }

  const nextWorkItem = (): WorkItem | undefined => {
    const doc = queue.shift()
    if (doc) return { kind: "document", url: doc.url, depth: doc.depth }
    const sitemap = pendingSitemaps.shift()
    if (sitemap) return sitemap
    const asset = pendingAssets.shift()
    if (asset) return asset
    return undefined
  }

  const reserve = (maxSpend: number): boolean => {
    const remaining = ctx.profile.maxTotalBytes - ctx.totalBytes - reservedBytes
    if (remaining <= 0) {
      ctx.issues.push(
        issue(
          "LIMIT_REACHED",
          ctx.seedResult.finalUrl,
          `Total byte budget of ${ctx.profile.maxTotalBytes} bytes reached.`
        )
      )
      return false
    }
    reservedBytes += Math.min(maxSpend, remaining)
    return true
  }

  const processWorkItem = async (item: WorkItem, reserved: number) => {
    try {
      if (ctx.signal.aborted) {
        ctx.issues.push(issue("LIMIT_REACHED", item.url, "Scan wall-time budget was exhausted."))
        return
      }

      const outcome = await safeFetchDetailed(item.url, {
        timeoutMs: DEFAULT_TIMEOUT_MS,
        maxRedirects: DEFAULT_MAX_REDIRECTS,
        maxBytes: Math.min(ctx.profile.maxResponseBytes, reserved),
        userAgent: ctx.userAgent,
        fetchFn: ctx.fetchFn,
        resolver: ctx.resolver,
        signal: ctx.signal,
      })

      if (!outcome.ok) {
        if (ctx.signal.aborted) {
          ctx.issues.push(issue("LIMIT_REACHED", item.url, "Scan wall-time budget was exhausted."))
        } else {
          ctx.issues.push(issue("FETCH_FAILED", item.url, describeOutcome(outcome)))
        }
        return
      }

      const result = outcome.result
      if (new URL(result.finalUrl).origin !== ctx.finalOrigin) {
        ctx.issues.push(
          issue("OUT_OF_SCOPE", result.finalUrl, "Resource redirected out of the target origin.")
        )
        return
      }

      ctx.totalBytes += result.bodyBytes
      if (result.bodyTruncated) {
        ctx.issues.push(
          issue(
            "LIMIT_REACHED",
            result.finalUrl,
            `Response body truncated at ${result.bodyBytes} bytes.`
          )
        )
      }

      if (item.kind === "document") {
        const subject = toSubject("document", item.url, result, item.depth)
        ctx.subjects.push(subject)
        documentCount++

        if (isHtml(result.headers)) {
          const anchors = extractAnchorUrls(result.html, result.finalUrl, ctx.finalOrigin)
          const sortedAnchors = anchors
            .filter((url) => !seen.has(url))
            .sort((a, b) => a.localeCompare(b))
          for (const url of sortedAnchors) {
            addDocumentToQueue(url, item.depth + 1)
          }

          const assets = extractAssetUrls(result.html, result.finalUrl, ctx.finalOrigin)
          addAssets(assets)
        } else if (item.url === ctx.seed) {
          // The seed should be HTML. If not, it is still recorded as a
          // document subject, but we do not attempt to extract anchors.
        } else if (isXml(result.headers) || /\.xml$/i.test(new URL(item.url).pathname)) {
          const urls = extractSitemapUrls(result.html, ctx.finalOrigin)
          addSitemapUrls(urls)
        }

        if (ctx.profile.maxDepth === 0 && item.depth === 0) {
          // Safe-style single-page mode was already handled above; this branch
          // is only reached for non-WEB_APP profiles or API targets.
        }
      } else if (item.kind === "robots") {
        const subject = toSubject("robots", item.url, result, 0)
        ctx.subjects.push(subject)
        if (isPlainText(result.headers) || /\/robots\.txt$/i.test(new URL(item.url).pathname)) {
          const sitemaps = extractRobotsSitemaps(result.html, ctx.finalOrigin)
          addRobotsSitemaps(sitemaps)
        }
      } else if (item.kind === "sitemap") {
        const subject = toSubject("sitemap", item.url, result, 0)
        ctx.subjects.push(subject)
        if (isXml(result.headers) || /\.xml$/i.test(new URL(item.url).pathname)) {
          const urls = extractSitemapUrls(result.html, ctx.finalOrigin)
          // Sitemap entries are treated as depth-1 documents so they still
          // honour the configured maxDepth.
          for (const url of urls) {
            addDocumentToQueue(url, 1)
          }
        }
      } else if (item.kind === "asset") {
        const kind: SurfaceSubjectKind = item.sourceMap ? "source_map" : "asset"
        const subject = toSubject(kind, item.url, result, 1)
        ctx.subjects.push(subject)
        assetCount++

        if (!item.sourceMap) {
          const maps = extractSourceMapReferences(result.html, result.finalUrl, ctx.finalOrigin)
          for (const mapUrl of maps.slice(0, 1)) {
            addSourceMap(mapUrl)
          }
        }
      }
    } finally {
      reservedBytes -= reserved
    }
  }

  // The seed is already recorded as a document. For Safe web mode the asset
  // loop above already ran; for expanded modes we run the BFS scheduler.
  while (
    queue.length > 0 ||
    pendingSitemaps.length > 0 ||
    pendingAssets.length > 0 ||
    executing.size > 0
  ) {
    if (ctx.signal.aborted) {
      truncated = true
      ctx.issues.push(issue("LIMIT_REACHED", ctx.seed, "Scan wall-time budget was exhausted."))
      break
    }

    while (executing.size < ctx.profile.maxConcurrency) {
      const item = nextWorkItem()
      if (!item) break

      if (item.kind === "document") {
        if (documentCount >= ctx.profile.maxDocuments) {
          truncated = true
          ctx.issues.push(
            issue(
              "LIMIT_REACHED",
              ctx.seedResult.finalUrl,
              `Document limit of ${ctx.profile.maxDocuments} reached.`
            )
          )
          continue
        }
      } else if (item.kind === "asset") {
        if (assetCount + pendingAssets.length >= ctx.profile.maxAssets) {
          truncated = true
          ctx.issues.push(
            issue(
              "LIMIT_REACHED",
              ctx.seedResult.finalUrl,
              `Asset limit of ${ctx.profile.maxAssets} reached.`
            )
          )
          continue
        }
      }

      const maxSpend = Math.min(
        ctx.profile.maxResponseBytes,
        ctx.profile.maxTotalBytes - ctx.totalBytes - reservedBytes
      )
      if (maxSpend <= 0) {
        truncated = true
        ctx.issues.push(
          issue(
            "LIMIT_REACHED",
            ctx.seedResult.finalUrl,
            `Total byte budget of ${ctx.profile.maxTotalBytes} bytes reached.`
          )
        )
        break
      }

      if (!reserve(maxSpend)) break

      const task = processWorkItem(item, maxSpend).finally(() => executing.delete(task))
      executing.add(task)
    }

    if (executing.size === 0) break
    await Promise.race(executing)
  }

  // totalBytes is mutated in ctx and returned to the caller
  ctx.truncated = truncated
  return { totalBytes: ctx.totalBytes, truncated }
}
