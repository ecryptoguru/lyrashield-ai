#!/usr/bin/env node

/**
 * Site-wide built-HTML SEO/AEO gate.
 *
 * `crawl-built-blog.mjs` validates the /blog surface only, and it is a manual
 * pre-release crawl. This script covers every URL in the built sitemap —
 * metadata limits, canonical agreement, structured-data presence, social-card
 * coverage, internal links, and the machine-readable surfaces (robots.txt,
 * llms.txt, rss.xml, security.txt) — and runs in CI through
 * `tests-browser/seo.e2e.ts`, which reuses the Playwright webServer that
 * already boots `pnpm preview`.
 *
 * Known violations are pinned in `seo-baseline.json` so the gate can land
 * before the fixes that drain it: the gate fails on anything NOT baselined,
 * reports baselined items separately, and warns about stale entries so the
 * baseline cannot rot silently.
 *
 * Usage:
 *   node scripts/crawl-built-site.mjs --origin http://localhost:8787
 *   node scripts/crawl-built-site.mjs --origin http://localhost:8787 --write-baseline
 */

import { readFile, writeFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"
import { extractSitemapLocations, inspectHtml } from "./crawl-built-blog.mjs"
import { allRoutes } from "./redirects-lib.mjs"

const SITEMAP_PATH = "/sitemap-index.xml"
const DEFAULT_BASELINE_PATH = new URL("./seo-baseline.json", import.meta.url)
const FETCH_CONCURRENCY = 8
const FETCH_TIMEOUT_MS = 15_000

/** Rendered-title budget. Blog posts carry a longer brand suffix than static pages. */
export const TITLE_LIMIT_DEFAULT = 60
export const TITLE_LIMIT_BLOG_POST = 65
export const DESCRIPTION_LIMIT = 160

/**
 * Retrieval and search agents that must be named explicitly. Relying on the
 * permissive wildcard means a future tightening of `*` silently revokes the
 * citation access this list exists to protect.
 */
export const REQUIRED_ROBOTS_AGENTS = [
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "ClaudeBot",
  "Claude-User",
  "Claude-SearchBot",
  "PerplexityBot",
  "Perplexity-User",
  "Google-Extended",
  "GoogleOther",
  "Applebot",
  "Applebot-Extended",
  "DuckAssistBot",
  "meta-externalagent",
  "Amazonbot",
  "YouBot",
  "cohere-ai",
  "MistralAI-User",
  "AI2Bot",
  "Diffbot",
  "Timpibot",
  "Bytespider",
  "CCBot",
]

/**
 * Sitemap URLs that deliberately stay out of llms.txt: scanner-gated, legal
 * noindex, and the 404 route. Everything else in the sitemap must be listed.
 */
export const LLMS_EXCLUDED_PATHS = new Set(["/scan", "/terms", "/terms-of-sale"])

const SITE_GRAPH_TYPES = new Set(["Organization", "WebSite"])

const BLOG_POST_PATH = /^\/blog\/[^/]+$/
const BLOG_PAGINATION_PATH = /^\/blog\/[1-9]\d*$/
const RFC3339_DATE_TIME =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/

/**
 * Routes the astro.config.mjs sitemap filter deliberately excludes (noindex
 * or canonicalized elsewhere). Mirrored here so the route-inventory check
 * below only demands routes the sitemap is supposed to carry; adding an
 * exclusion there without updating this set fails the gate loudly.
 * `/scan` is filtered conditionally upstream, so it stays out of the
 * required set either way.
 */
export const SITEMAP_FILTER_EXCLUSIONS = new Set(["/terms", "/terms-of-sale", "/docs", "/scan"])

export function isBlogPostPath(path) {
  return (
    BLOG_POST_PATH.test(path) &&
    path !== "/blog/editorial-policy" &&
    !BLOG_PAGINATION_PATH.test(path)
  )
}

export function titleLimitFor(path) {
  return isBlogPostPath(path) ? TITLE_LIMIT_BLOG_POST : TITLE_LIMIT_DEFAULT
}

/** Canonical form of a sitemap path: slash-less everywhere except the homepage. */
export function expectedCanonical(origin, path) {
  return path === "/" ? `${origin}/` : `${origin}${path}`
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  async function run() {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await worker(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run))
  return results
}

async function fetchText(fetchImpl, url, { follow = false } = {}) {
  try {
    const response = await fetchImpl(url, {
      redirect: follow ? "follow" : "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (response.status !== 200) return { status: response.status, text: null }
    return { status: response.status, text: await response.text() }
  } catch {
    return { status: 0, text: null }
  }
}

/**
 * The canonical site origin comes from the sitemap, not from the origin the
 * gate fetches: a local `pnpm preview` serves the same build whose canonicals,
 * llms.txt links and sitemap `<loc>`s all carry the configured
 * `PUBLIC_SITE_URL` (production), so comparing them against the fetch origin
 * would flag every page.
 *
 * `entries` carries `{ path, lastmod }` from each child sitemap — the index
 * itself contains `<sitemap>` blocks, not `<url>` blocks, so a parser pointed at
 * the index finds nothing and any rule built on it silently never fires.
 */
async function sitemapPaths(origin, fetchImpl) {
  const pending = [new URL(SITEMAP_PATH, origin).href]
  const visited = new Set()
  const paths = new Set()
  const entries = []
  const failures = []
  let siteOrigin = null

  while (pending.length > 0) {
    const requestUrl = pending.shift()
    if (!requestUrl || visited.has(requestUrl)) continue
    visited.add(requestUrl)
    const { status, text } = await fetchText(fetchImpl, requestUrl)
    if (text === null) {
      // A child sitemap that cannot be fetched silently shrinks the crawl —
      // as long as another child covers enough pages the gate would pass on
      // partial discovery. Every advertised sitemap must account for itself.
      failures.push({ rule: "sitemap-fetch", url: requestUrl, status })
      continue
    }
    const locations = extractSitemapLocations(text)
    if (locations.length === 0) {
      // A reachable-but-empty or malformed sitemap contributes no discovery
      // at all while still looking healthy to a page-count check.
      failures.push({ rule: "sitemap-no-locations", url: requestUrl, status })
      continue
    }
    for (const location of locations) {
      let parsed
      try {
        parsed = new URL(location, origin)
      } catch {
        failures.push({ rule: "sitemap-bad-location", url: requestUrl, status: location })
        continue
      }
      if (siteOrigin === null) siteOrigin = parsed.origin
      if (/<sitemapindex\b/i.test(text)) {
        pending.push(new URL(parsed.pathname, origin).href)
      } else {
        paths.add(parsed.pathname)
      }
    }
    if (!/<sitemapindex\b/i.test(text)) entries.push(...sitemapEntries(text))
  }

  return { paths, entries, failures, siteOrigin: siteOrigin ?? new URL(origin).origin }
}

/**
 * `{ path, lastmod }` per sitemap URL, so the gate can require a real freshness
 * signal without re-fetching every sitemap.
 */
export function sitemapEntries(xml) {
  return [...xml.matchAll(/<url\b[^>]*>([\s\S]*?)<\/url\s*>/gi)].map((match) => {
    const block = match[1] ?? ""
    const loc = block.match(/<loc\b[^>]*>([\s\S]*?)<\/loc\s*>/i)?.[1]?.trim() ?? ""
    const lastmod = block.match(/<lastmod\b[^>]*>([\s\S]*?)<\/lastmod\s*>/i)?.[1]?.trim() ?? ""
    let path = loc
    try {
      path = new URL(loc).pathname
    } catch {
      // keep the raw loc when it is not a URL
    }
    return { path, lastmod }
  })
}

/** Page-level violations for one already-fetched document. */
export function pageViolations({ path, facts, origin }) {
  const violations = []
  const add = (rule, detail) => violations.push({ rule, path, detail })

  if (!facts.title) add("title-missing", "")
  else if (facts.title.length > titleLimitFor(path)) {
    add("title-too-long", `${facts.title.length} > ${titleLimitFor(path)}: ${facts.title}`)
  }

  if (!facts.description) add("description-missing", "")
  else if (facts.description.length > DESCRIPTION_LIMIT) {
    add("description-too-long", `${facts.description.length} > ${DESCRIPTION_LIMIT}`)
  }

  if (facts.h1Count !== 1) add("h1-count", String(facts.h1Count))
  if (facts.mainCount !== 1) add("main-count", String(facts.mainCount))
  if (!facts.htmlLang) add("html-lang-missing", "")
  if (facts.imagesMissingAlt > 0) {
    add("img-alt-missing", `${facts.imagesMissingAlt} image(s) without an alt attribute`)
  }

  const expected = expectedCanonical(origin, path)
  if (facts.canonicalCount !== 1) add("canonical-count", String(facts.canonicalCount))
  else if (facts.canonical !== expected) {
    add("canonical-mismatch", `${facts.canonical} != ${expected}`)
  }

  if (facts.noindex) add("noindex-in-sitemap", "")

  if (facts.jsonLdCount === 0) add("jsonld-missing", "")
  for (const error of facts.jsonLdErrors) add("jsonld-invalid", error)
  if (!facts.jsonLdTypes.some((type) => !SITE_GRAPH_TYPES.has(type))) {
    add("jsonld-page-entity-missing", facts.jsonLdTypes.join(", "))
  }
  // Every page except the root sits somewhere in a hierarchy, so the trail is
  // part of the page contract rather than an optional extra.
  if (path !== "/" && !facts.jsonLdTypes.includes("BreadcrumbList")) {
    add("jsonld-breadcrumb-missing", facts.jsonLdTypes.join(", "))
  }

  if (!facts.ogImage) add("og-image-missing", "")
  else {
    if (!facts.ogImage.startsWith("http")) add("og-image-relative", facts.ogImage)
    if (!facts.ogImageWidth || !facts.ogImageHeight) {
      add("og-image-dimensions-missing", `${facts.ogImageWidth}x${facts.ogImageHeight}`)
    }
    if (facts.ogImage.endsWith("/og/og-default.png") && !isBlogPostPath(path)) {
      add("og-image-default", facts.ogImage)
    }
  }

  for (const error of facts.anchorErrors) add("anchor-missing", error)

  return violations
}

/** Site-level violations: uniqueness, internal links, machine-readable surfaces. */
export function siteViolations({
  pageFacts,
  origin,
  robots,
  llms,
  rss,
  securityTxt,
  now = Date.now(),
}) {
  const violations = []
  const add = (rule, path, detail) => violations.push({ rule, path, detail })

  const seen = { title: new Map(), description: new Map(), canonical: new Map() }
  for (const [path, facts] of pageFacts) {
    for (const [key, value] of [
      ["title", facts.title],
      ["description", facts.description],
      ["canonical", facts.canonical],
    ]) {
      if (!value) continue
      const previous = seen[key].get(value)
      if (previous) add(`duplicate-${key}`, path, `also on ${previous}`)
      else seen[key].set(value, path)
    }
  }

  const sitemapPagePaths = new Set(pageFacts.keys())
  const externalPaths = new Set()
  for (const [path, facts] of pageFacts) {
    for (const href of facts.localHrefs) {
      const target = href.length > 1 ? href.replace(/\/+$/, "") : href
      if (target !== path && !sitemapPagePaths.has(target)) externalPaths.add(target)
    }
  }

  // Cross-page fragments: a same-site link into another page's #id fails only
  // when the target was fetched and the id is absent. Targets outside the
  // sitemap still get their link-status check below.
  for (const [path, facts] of pageFacts) {
    for (const target of facts.anchorTargets ?? []) {
      const targetPath = new URL(target.url).pathname
      const normalized = targetPath.length > 1 ? targetPath.replace(/\/+$/, "") : targetPath
      const targetFacts = pageFacts.get(normalized)
      if (target.fragment && targetFacts && !targetFacts.ids.has(target.fragment)) {
        add("anchor-missing", path, `#${target.fragment} on ${normalized}`)
      }
    }
  }

  if (robots === null) {
    // Without this, an unreachable robots.txt silently skips the whole agent
    // check below — the gate would pass on a site crawlers cannot read.
    add("robots-missing", "/robots.txt", "did not return 200")
  } else {
    for (const agent of REQUIRED_ROBOTS_AGENTS) {
      if (!new RegExp(`^User-agent:\\s*${agent}\\s*$`, "im").test(robots)) {
        add("robots-agent-missing", "/robots.txt", agent)
      }
    }
    // Naming the agent is necessary but not sufficient: a group that names a
    // required agent and then disallows everything still passes the name
    // check while revoking the access the list exists to protect.
    for (const group of robots.split(/\n[ \t]*\n/)) {
      if (!/^Disallow:\s*\/+(?:\s*#.*)?$/im.test(group)) continue
      for (const match of group.matchAll(/^User-agent:\s*(.+?)\s*$/gim)) {
        const agent = match[1] ?? ""
        if (REQUIRED_ROBOTS_AGENTS.includes(agent)) {
          add("robots-agent-disallowed", "/robots.txt", agent)
        }
      }
    }
  }

  if (llms === null) {
    add("llms-missing", "/llms.txt", "llms.txt did not return 200")
  } else {
    for (const path of [...sitemapPagePaths].sort()) {
      if (LLMS_EXCLUDED_PATHS.has(path)) continue
      const url = expectedCanonical(origin, path)
      if (!llms.includes(url)) add("llms-url-missing", "/llms.txt", path)
    }
  }

  if (rss === null) {
    add("rss-missing", "/rss.xml", "rss.xml did not return 200")
  } else {
    const itemLinks = [...rss.matchAll(/<item\b[^>]*>[\s\S]*?<link\b[^>]*>([\s\S]*?)<\/link\s*>/gi)]
      .map((match) => match[1]?.trim() ?? "")
      .filter(Boolean)
    for (const link of itemLinks) {
      if (link.endsWith("/")) add("rss-trailing-slash", "/rss.xml", link)
    }
  }

  if (securityTxt === null) {
    add("security-txt-missing", "/.well-known/security.txt", "did not return 200")
  } else {
    const contacts = [...securityTxt.matchAll(/^Contact:\s*(\S+)\s*$/gim)].map(
      (match) => match[1] ?? ""
    )
    const validContact = contacts.some((contact) => {
      try {
        const protocol = new URL(contact).protocol
        return protocol === "mailto:" || protocol === "tel:" || protocol === "https:"
      } catch {
        return false
      }
    })
    if (!validContact) {
      add("security-txt-contact", "/.well-known/security.txt", "missing valid Contact URI")
    }

    // RFC 9116 requires exactly one RFC 3339 date-time Expires field.
    const expiresFields = [...securityTxt.matchAll(/^Expires:\s*(\S+)\s*$/gim)].map(
      (match) => match[1] ?? ""
    )
    const expires = expiresFields[0]
    if (expiresFields.length !== 1 || !expires) {
      add(
        "security-txt-expires",
        "/.well-known/security.txt",
        `expected one Expires field, found ${expiresFields.length}`
      )
    } else if (!RFC3339_DATE_TIME.test(expires)) {
      add("security-txt-expires", "/.well-known/security.txt", `not RFC 3339 date-time: ${expires}`)
    } else {
      const parsed = Date.parse(expires)
      if (Number.isNaN(parsed)) {
        add("security-txt-expires", "/.well-known/security.txt", `unparseable Expires: ${expires}`)
      } else if (parsed <= now) {
        add("security-txt-expires", "/.well-known/security.txt", `expired ${expires}`)
      }
    }
  }

  return { violations, externalPaths: [...externalPaths].sort() }
}

export async function crawlBuiltSite({ origin, fetchImpl = globalThis.fetch }) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetch implementation is required")
  const localOrigin = new URL(origin).origin
  const violations = []

  const {
    paths: discovered,
    entries,
    failures: sitemapFailures,
    siteOrigin,
  } = await sitemapPaths(localOrigin, fetchImpl)
  const paths = [...discovered].sort()

  // Discovery failures are reported separately from page violations: a
  // sitemap that never answered means the page set itself is incomplete, no
  // matter how clean the fetched pages are.
  for (const failure of sitemapFailures) {
    violations.push({
      rule: failure.rule,
      path: new URL(failure.url).pathname,
      detail: String(failure.status),
    })
  }

  // The route inventory is the same filesystem walk the trailing-slash rules
  // use, so a page that exists but never reaches the sitemap is caught here
  // instead of relying on a page-count threshold.
  for (const route of allRoutes()) {
    if (SITEMAP_FILTER_EXCLUSIONS.has(route) || BLOG_PAGINATION_PATH.test(route)) continue
    if (!discovered.has(route)) {
      violations.push({ rule: "route-not-in-sitemap", path: route, detail: "" })
    }
  }
  if (!discovered.has("/")) violations.push({ rule: "route-not-in-sitemap", path: "/", detail: "" })

  // lastmod is the only freshness signal a crawler gets from the sitemap, and
  // it is derived per-route from git — so a page added without registering its
  // source loses it silently. /demo was the one route in that state. The
  // entries come from the child sitemap(s), not the index.
  if (entries.length === 0) {
    violations.push({ rule: "sitemap-entries-missing", path: SITEMAP_PATH, detail: "" })
  }
  for (const entry of entries) {
    if (!entry.lastmod) {
      violations.push({ rule: "sitemap-lastmod-missing", path: entry.path, detail: "" })
    }
  }

  // Probe machine-readable surfaces before crawling every page. llms.txt and
  // rss.xml load Astro content collections in the Worker; keeping them on the
  // cold path avoids a late request timing out after the page crawl has already
  // consumed the local preview's budget.
  const machineTexts = []
  for (const path of ["/robots.txt", "/llms.txt", "/rss.xml", "/.well-known/security.txt"]) {
    const { text } = await fetchText(fetchImpl, new URL(path, localOrigin).href)
    machineTexts.push(text)
  }
  const [robots, llms, rss, securityTxt] = machineTexts

  const pages = await mapWithConcurrency(paths, FETCH_CONCURRENCY, async (path) => {
    const url = new URL(path, localOrigin).href
    const { status, text } = await fetchText(fetchImpl, url)
    if (text === null) {
      violations.push({ rule: "page-status", path, detail: `returned ${status}` })
      return [path, null]
    }
    return [path, inspectHtml(text, url, { siteOrigin })]
  })

  const pageFacts = new Map(pages.filter(([, facts]) => facts !== null))
  for (const [path, facts] of pageFacts) {
    violations.push(...pageViolations({ path, facts, origin: siteOrigin }))
  }

  const site = siteViolations({
    pageFacts,
    origin: siteOrigin,
    robots,
    llms,
    rss,
    securityTxt,
  })
  violations.push(...site.violations)

  // /.well-known/security.txt is a static file, so it cannot read
  // PUBLIC_SECURITY_EMAIL the way the pages do. That makes it the one surface
  // that goes stale silently when the published disclosure address changes —
  // exactly what happened when another branch switched the reporting page to
  // support@. Tie the file to the page it is the policy for.
  if (securityTxt !== null) {
    const contact = securityTxt.match(/^Contact:\s*mailto:([^\s]+)/im)?.[1]?.toLowerCase()
    const policyFacts = pageFacts.get("/security-reporting")
    if (contact && policyFacts && !policyFacts.mailtoLinks.includes(contact)) {
      violations.push({
        rule: "security-txt-contact-mismatch",
        path: "/.well-known/security.txt",
        detail: `${contact} is not published on /security-reporting`,
      })
    }
  }

  const machinePaths = new Set(["/robots.txt", "/llms.txt", "/rss.xml", "/.well-known/security.txt"])
  const linkResults = await mapWithConcurrency(
    site.externalPaths.filter((path) => !machinePaths.has(path)),
    FETCH_CONCURRENCY,
    async (path) => {
      // A followed redirect to a 200 is fine: /docs/integrations/windsurf and
      // /rss.xml are intentional 301s, not broken links.
      const { status } = await fetchText(fetchImpl, new URL(path, localOrigin).href, {
        follow: true,
      })
      return status === 200 ? null : { rule: "internal-link-broken", path, detail: String(status) }
    }
  )
  violations.push(...linkResults.filter(Boolean))

  // og:image metadata claims a card exists; same-origin cards get one
  // deduplicated fetch to prove the file is actually retrievable — hundreds
  // of pages sharing a handful of cards cost a handful of requests.
  // Off-origin cards stay metadata-only: they are outside this gate's reach.
  const ogReferrers = new Map()
  for (const [path, facts] of pageFacts) {
    if (!facts.ogImage.startsWith("http")) continue
    let imageUrl
    try {
      imageUrl = new URL(facts.ogImage)
    } catch {
      continue
    }
    if (imageUrl.origin !== siteOrigin) continue
    const refs = ogReferrers.get(imageUrl.href) ?? []
    refs.push(path)
    ogReferrers.set(imageUrl.href, refs)
  }
  const ogResults = await mapWithConcurrency(
    [...ogReferrers],
    FETCH_CONCURRENCY,
    async ([href, refs]) => {
      const { status } = await fetchText(
        fetchImpl,
        new URL(new URL(href).pathname, localOrigin).href,
        { follow: true }
      )
      return status === 200
        ? null
        : {
            rule: "og-image-unreachable",
            path: refs[0],
            detail: `${new URL(href).pathname} returned ${status} (referenced by ${refs.length} page(s))`,
          }
    }
  )
  violations.push(...ogResults.filter(Boolean))

  return {
    siteOrigin,
    pageCount: pageFacts.size,
    checkedLinkCount: site.externalPaths.length,
    violations: dedupeViolations(violations),
  }
}

export function dedupeViolations(violations) {
  const seen = new Set()
  const unique = []
  for (const violation of violations) {
    const key = `${violation.rule}\u0000${violation.path}\u0000${violation.detail}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(violation)
  }
  return unique.sort((a, b) =>
    a.rule === b.rule ? a.path.localeCompare(b.path) : a.rule.localeCompare(b.rule)
  )
}

export function applyBaseline(violations, baseline) {
  const entries = new Set(
    (baseline?.entries ?? []).map((entry) => `${entry.rule}\u0000${entry.path}`)
  )
  const fresh = []
  const baselined = []
  for (const violation of violations) {
    const key = `${violation.rule}\u0000${violation.path}`
    if (entries.has(key)) {
      baselined.push(violation)
      entries.delete(key)
    } else {
      fresh.push(violation)
    }
  }
  return { fresh, baselined, stale: [...entries].map((key) => key.split("\u0000")) }
}

export function buildBaseline(violations, { date, notes = {} }) {
  const entries = [...new Set(violations.map((v) => `${v.rule}\u0000${v.path}`))]
    .map((key) => {
      const [rule, path] = key.split("\u0000")
      return { rule, path }
    })
    .sort((a, b) =>
      a.rule === b.rule ? a.path.localeCompare(b.path) : a.rule.localeCompare(b.rule)
    )
  return { generatedAt: date, notes, entries }
}

/**
 * What each rule means, so a future entry is easy to judge. The allowlist
 * itself is empty as of the Wave 3 close-out — every rule below is enforced
 * strictly, and an entry should only ever be added with a wave that removes it.
 */
export const BASELINE_NOTES = {
  "title-too-long": {
    reason:
      "Rendered title above the budget: 60 characters for static pages, 65 for blog posts (they carry a longer brand suffix).",
    wave: null,
  },
  "description-too-long": {
    reason: "Meta description above 160 characters.",
    wave: null,
  },
  "og-image-default": {
    reason:
      "A sitemap page fell back to /og/og-default.png instead of a section card from src/lib/og-images.ts.",
    wave: null,
  },
  "jsonld-page-entity-missing": {
    reason: "Page emitted only the site graph (Organization + WebSite) and no page-level entity.",
    wave: null,
  },
  "jsonld-breadcrumb-missing": {
    reason: "A non-root page emitted no BreadcrumbList.",
    wave: null,
  },
  "html-lang-missing": {
    reason: "The <html> element carries no lang attribute.",
    wave: null,
  },
  "img-alt-missing": {
    reason:
      'An <img> has no alt attribute at all. Decorative images must use alt="" explicitly; a missing attribute is what screen readers and image crawlers cannot interpret.',
    wave: null,
  },
  "sitemap-lastmod-missing": {
    reason:
      "A sitemap URL carries no lastmod. Every indexable route must map to a source file in astro.config.mjs's contentLastmod() so its real git date can be emitted.",
    wave: null,
  },
  "sitemap-entries-missing": {
    reason:
      "No <url> entries were found in any child sitemap, so the lastmod rule had nothing to check.",
    wave: null,
  },
  "sitemap-fetch": {
    reason:
      "A sitemap advertised by the index could not be fetched, so discovery from it is missing — the page set this run covers is incomplete no matter how clean the fetched pages are.",
    wave: null,
  },
  "sitemap-no-locations": {
    reason:
      "A fetched sitemap contained no <loc> entries — empty or malformed, so it silently contributed nothing to discovery.",
    wave: null,
  },
  "sitemap-bad-location": {
    reason: "A sitemap <loc> could not be parsed as a URL.",
    wave: null,
  },
  "route-not-in-sitemap": {
    reason:
      "A route from the filesystem inventory (redirects-lib.mjs allRoutes) is missing from the sitemap. Intended exclusions live in SITEMAP_FILTER_EXCLUSIONS, mirroring the astro.config.mjs sitemap filter.",
    wave: null,
  },
  "anchor-missing": {
    reason:
      "A same-page or cross-page fragment points at an id that does not exist on the target page.",
    wave: null,
  },
  "robots-missing": {
    reason:
      "robots.txt did not return 200. The agent-coverage check cannot run without it, and a missing robots.txt is itself a crawl-access problem.",
    wave: null,
  },
  "robots-agent-disallowed": {
    reason:
      "A required retrieval/search agent is named in robots.txt but its group disallows every path — named presence without actual access.",
    wave: null,
  },
  "security-txt-expires": {
    reason:
      "/.well-known/security.txt must have exactly one future RFC 3339 date-time Expires field. A missing, malformed, duplicate or expired value makes the disclosure policy stale or invalid.",
    wave: null,
  },
  "security-txt-contact": {
    reason:
      "/.well-known/security.txt has no valid Contact URI. RFC 9116 requires at least one usable reporting method.",
    wave: null,
  },
  "og-image-unreachable": {
    reason:
      "A page advertises a same-origin og:image whose file does not return 200 — the card metadata is not proof the image exists.",
    wave: null,
  },
  "security-txt-contact-mismatch": {
    reason:
      "The Contact address in /.well-known/security.txt is not published on /security-reporting. The file is static and cannot follow PUBLIC_SECURITY_EMAIL, so it must be updated whenever the published disclosure address changes.",
    wave: null,
  },
}

async function readBaseline(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"))
  } catch {
    return { entries: [] }
  }
}

function argumentValue(args, name) {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

export async function runSiteGate({ origin, fetchImpl = globalThis.fetch, baseline }) {
  const result = await crawlBuiltSite({ origin, fetchImpl })
  return { ...result, ...applyBaseline(result.violations, baseline) }
}

async function main() {
  const args = process.argv.slice(2)
  const origin = argumentValue(args, "--origin")
  if (!origin) {
    console.error("Usage: node scripts/crawl-built-site.mjs --origin http://localhost:8787")
    process.exitCode = 1
    return
  }

  const baselinePath = argumentValue(args, "--baseline") ?? DEFAULT_BASELINE_PATH
  const result = await crawlBuiltSite({ origin })

  if (args.includes("--write-baseline")) {
    const baseline = buildBaseline(result.violations, {
      date: new Date().toISOString().slice(0, 10),
      notes: BASELINE_NOTES,
    })
    await writeFile(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, "utf8")
    console.log(`Wrote ${baseline.entries.length} baseline entr(ies) to seo-baseline.json.`)
    return
  }

  const baseline = await readBaseline(baselinePath)
  const { fresh, baselined, stale } = applyBaseline(result.violations, baseline)

  for (const violation of fresh) {
    console.error(
      `${violation.rule}: ${violation.path}${violation.detail ? ` — ${violation.detail}` : ""}`
    )
  }
  for (const [rule, path] of stale) {
    console.warn(`stale baseline entry (no longer violated): ${rule}: ${path}`)
  }

  console.log(
    `Site SEO gate: ${result.pageCount} pages on ${result.siteOrigin}, ` +
      `${result.checkedLinkCount} internal links checked, ${baselined.length} baselined, ` +
      `${stale.length} stale, ${fresh.length} new violation(s).`
  )
  if (fresh.length > 0) process.exitCode = 1
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : ""
if (import.meta.url === invokedPath) {
  await main()
}
