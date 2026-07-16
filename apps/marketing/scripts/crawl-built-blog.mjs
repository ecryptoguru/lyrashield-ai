#!/usr/bin/env node

import { readFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"

const SITEMAP_PATH = "/sitemap-index.xml"
const RSS_PATH = "/rss.xml"

function decodeEntities(value) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, digits) => String.fromCodePoint(Number.parseInt(digits, 16)))
    .replace(/&#([0-9]+);/g, (_, digits) => String.fromCodePoint(Number.parseInt(digits, 10)))
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
}

function stripTags(value) {
  return decodeEntities(value.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim()
}

function openingTags(html, name) {
  const pattern = new RegExp(`<${name}\\b[^>]*>`, "gi")
  return html.match(pattern) ?? []
}

function pairedTagContents(html, name) {
  const pattern = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}\\s*>`, "gi")
  return [...html.matchAll(pattern)].map((match) => match[1] ?? "")
}

function attributes(tag) {
  const result = new Map()
  const pattern = /([^\s=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
  for (const match of tag.matchAll(pattern)) {
    const key = match[1]?.toLowerCase()
    if (!key || key.startsWith("<")) continue
    result.set(key, decodeEntities(match[2] ?? match[3] ?? match[4] ?? ""))
  }
  return result
}

function resolveHttpUrl(raw, base) {
  if (!raw || raw.startsWith("data:")) return null
  try {
    const url = new URL(raw, base)
    return url.protocol === "http:" || url.protocol === "https:" ? url : null
  } catch {
    return null
  }
}

function unique(values) {
  return [...new Set(values)]
}

function classIncludes(tag, className) {
  return (attributes(tag).get("class") ?? "").split(/\s+/).includes(className)
}

export function sanitizeReportUrl(rawUrl) {
  try {
    const url = new URL(rawUrl)
    return `${url.origin}${url.pathname}`
  } catch {
    return String(rawUrl).split(/[?#]/, 1)[0]
  }
}

export function extractSitemapLocations(xml) {
  return [...xml.matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc\s*>/gi)]
    .map((match) => stripTags(match[1] ?? ""))
    .filter(Boolean)
}

export function extractRssLinks(xml) {
  return [
    ...xml.matchAll(/<item\b[^>]*>[\s\S]*?<link\b[^>]*>([\s\S]*?)<\/link\s*>[\s\S]*?<\/item\s*>/gi),
  ]
    .map((match) => stripTags(match[1] ?? ""))
    .filter(Boolean)
}

export function inspectHtml(html, pageUrl) {
  const title = stripTags(pairedTagContents(html, "title")[0] ?? "")
  const metaTags = openingTags(html, "meta")
  const description = metaTags
    .map(attributes)
    .find((attrs) => attrs.get("name")?.toLowerCase() === "description")
    ?.get("content")
    ?.trim()
  const canonicalTags = openingTags(html, "link")
    .map(attributes)
    .filter((attrs) => (attrs.get("rel") ?? "").toLowerCase().split(/\s+/).includes("canonical"))
  const canonical = canonicalTags[0]?.get("href")?.trim() ?? ""
  const h1Count = openingTags(html, "h1").length
  const mainCount = openingTags(html, "main").length
  const ids = new Set()

  for (const tag of html.match(/<[a-z][^>]*>/gi) ?? []) {
    const attrs = attributes(tag)
    const id = attrs.get("id")
    if (id) ids.add(id)
    if (tag.toLowerCase().startsWith("<a")) {
      const name = attrs.get("name")
      if (name) ids.add(name)
    }
  }

  const hrefs = []
  const anchorTargets = []
  const anchorErrors = []
  for (const tag of openingTags(html, "a")) {
    const href = attributes(tag).get("href")
    if (!href) continue
    const resolved = resolveHttpUrl(href, pageUrl)
    if (resolved) hrefs.push(resolved.href)
    if (!resolved || !resolved.hash) continue

    const fragment = decodeURIComponent(resolved.hash.slice(1))
    const current = new URL(pageUrl)
    if (resolved.origin === current.origin && resolved.pathname === current.pathname) {
      if (fragment && !ids.has(fragment)) anchorErrors.push(`missing anchor #${fragment}`)
    } else if (resolved.origin === current.origin) {
      anchorTargets.push({ url: `${resolved.origin}${resolved.pathname}`, fragment })
    }
  }

  const imageUrls = []
  for (const tag of openingTags(html, "img")) {
    const src = attributes(tag).get("src")
    const resolved = resolveHttpUrl(src, pageUrl)
    if (resolved) imageUrls.push(resolved.href)
  }
  for (const tag of openingTags(html, "source")) {
    const srcset = attributes(tag).get("srcset")
    if (!srcset) continue
    for (const candidate of srcset.split(",")) {
      const src = candidate.trim().split(/\s+/, 1)[0]
      const resolved = resolveHttpUrl(src, pageUrl)
      if (resolved) imageUrls.push(resolved.href)
    }
  }

  const jsonLdErrors = []
  let jsonLdCount = 0
  const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi
  for (const match of html.matchAll(scriptPattern)) {
    const attrs = attributes(`<script ${match[1] ?? ""}>`)
    if (attrs.get("type")?.toLowerCase() !== "application/ld+json") continue
    jsonLdCount += 1
    try {
      JSON.parse(match[2]?.trim() ?? "")
    } catch {
      jsonLdErrors.push("invalid JSON-LD")
    }
  }

  const page = new URL(pageUrl)
  const localHrefs = unique(
    hrefs
      .filter((href) => new URL(href).origin === page.origin)
      .map((href) => new URL(href).pathname)
  )
  const tagUrls = unique(
    hrefs.filter((href) => {
      const url = new URL(href)
      return url.origin === page.origin && url.pathname.startsWith("/blog/tags/")
    })
  ).map((href) => sanitizeReportUrl(href))
  const hasDraftMarker =
    openingTags(html, "span").some((tag) => classIncludes(tag, "blog-post__draft")) ||
    /\bdata-draft\s*=\s*["']?true\b/i.test(html)

  return {
    title,
    description: description ?? "",
    canonical,
    canonicalCount: canonicalTags.length,
    h1Count,
    mainCount,
    ids,
    hrefs: unique(hrefs),
    localHrefs,
    tagUrls,
    anchorTargets,
    anchorErrors: unique(anchorErrors),
    imageUrls: unique(imageUrls),
    jsonLdCount,
    jsonLdErrors,
    hasDraftMarker,
  }
}

export function validatePageFacts(url, facts, { requireImage = false } = {}) {
  const safeUrl = sanitizeReportUrl(url)
  const errors = []
  if (!facts.title) errors.push(`${safeUrl}: missing title`)
  if (!facts.description) errors.push(`${safeUrl}: missing meta description`)
  if (facts.canonicalCount !== 1 || !facts.canonical) {
    errors.push(`${safeUrl}: expected exactly one canonical link`)
  }
  if (facts.h1Count !== 1) errors.push(`${safeUrl}: expected one H1; found ${facts.h1Count}`)
  if (facts.mainCount !== 1) errors.push(`${safeUrl}: expected one main; found ${facts.mainCount}`)
  for (const error of facts.anchorErrors) errors.push(`${safeUrl}: ${error}`)
  if (facts.jsonLdCount === 0) errors.push(`${safeUrl}: missing JSON-LD`)
  for (const error of facts.jsonLdErrors) errors.push(`${safeUrl}: ${error}`)
  if (facts.hasDraftMarker) errors.push(`${safeUrl}: draft marker discovered in built output`)
  if (requireImage && facts.imageUrls.length === 0) {
    errors.push(`${safeUrl}: article has no images`)
  }
  return errors
}

async function fetchText(fetchImpl, url, label, errors) {
  let response
  try {
    response = await fetchImpl(url, { redirect: "manual" })
  } catch {
    errors.push(`${sanitizeReportUrl(url)}: ${label} request failed`)
    return null
  }
  if (response.status !== 200) {
    errors.push(`${sanitizeReportUrl(url)}: ${label} returned ${response.status}`)
    return null
  }
  return response.text()
}

async function sitemapPaths(origin, fetchImpl, errors) {
  const pending = [new URL(SITEMAP_PATH, origin).href]
  const visited = new Set()
  const pagePaths = new Set()

  while (pending.length > 0) {
    const requestUrl = pending.shift()
    if (!requestUrl || visited.has(requestUrl)) continue
    visited.add(requestUrl)
    const xml = await fetchText(fetchImpl, requestUrl, "sitemap", errors)
    if (xml === null) continue
    const locations = extractSitemapLocations(xml)
    if (/<sitemapindex\b/i.test(xml)) {
      for (const location of locations) {
        const path = new URL(location, origin).pathname
        pending.push(new URL(path, origin).href)
      }
    } else {
      for (const location of locations) pagePaths.add(new URL(location, origin).pathname)
    }
  }

  return pagePaths
}

function expectedArticlePaths(slugs) {
  return new Set(slugs.map((slug) => `/blog/${slug}`))
}

function checkCanonicalUniqueness(pageFacts, errors) {
  const byCanonical = new Map()
  for (const [url, facts] of pageFacts) {
    if (!facts.canonical) continue
    const pages = byCanonical.get(facts.canonical) ?? []
    pages.push(url)
    byCanonical.set(facts.canonical, pages)
  }
  for (const [canonical, pages] of byCanonical) {
    if (pages.length > 1) {
      errors.push(
        `${sanitizeReportUrl(canonical)}: duplicate canonical on ${pages
          .map(sanitizeReportUrl)
          .join(", ")}`
      )
    }
  }
}

export async function crawlBuiltBlog({
  origin,
  fetchImpl = globalThis.fetch,
  expectedArticleSlugs,
}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetch implementation is required")
  const localOrigin = new URL(origin).origin
  const errors = []
  const expectedPaths = expectedArticlePaths(expectedArticleSlugs)
  const discoveredPaths = await sitemapPaths(localOrigin, fetchImpl, errors)
  const blogPaths = [...discoveredPaths].filter(
    (path) => path === "/blog" || path.startsWith("/blog/")
  )
  const discoveredArticlePaths = new Set(
    blogPaths.filter((path) => /^\/blog\/[^/]+$/.test(path) && path !== "/blog/editorial-policy")
  )

  for (const path of expectedPaths) {
    if (!discoveredArticlePaths.has(path)) {
      errors.push(`${new URL(path, localOrigin).href}: mapped article missing from sitemap`)
    }
  }
  for (const path of discoveredArticlePaths) {
    if (!expectedPaths.has(path)) {
      errors.push(`${new URL(path, localOrigin).href}: unexpected article in sitemap`)
    }
  }

  const pageFacts = new Map()
  for (const path of blogPaths.sort()) {
    const url = new URL(path, localOrigin).href
    const html = await fetchText(fetchImpl, url, "blog page", errors)
    if (html === null) continue
    const facts = inspectHtml(html, url)
    pageFacts.set(url, facts)
    errors.push(...validatePageFacts(url, facts, { requireImage: expectedPaths.has(path) }))
  }
  checkCanonicalUniqueness(pageFacts, errors)

  for (const [url, facts] of pageFacts) {
    for (const target of facts.anchorTargets) {
      const targetUrl = new URL(target.url, localOrigin).href
      let targetFacts = pageFacts.get(targetUrl)
      if (!targetFacts) {
        const targetHtml = await fetchText(fetchImpl, targetUrl, "anchor target", errors)
        if (targetHtml !== null) {
          targetFacts = inspectHtml(targetHtml, targetUrl)
          pageFacts.set(targetUrl, targetFacts)
        }
      }
      if (target.fragment && targetFacts && !targetFacts.ids.has(target.fragment)) {
        errors.push(
          `${sanitizeReportUrl(url)}: missing anchor #${target.fragment} on ${sanitizeReportUrl(targetUrl)}`
        )
      }
    }
  }

  const imageUrls = unique(
    [...pageFacts.values()]
      .flatMap((facts) => facts.imageUrls)
      .filter((url) => new URL(url).origin === localOrigin)
  )
  for (const imageUrl of imageUrls) {
    let response
    try {
      response = await fetchImpl(imageUrl, { redirect: "manual" })
    } catch {
      errors.push(`${sanitizeReportUrl(imageUrl)}: image request failed`)
      continue
    }
    if (response.status !== 200) {
      errors.push(`${sanitizeReportUrl(imageUrl)}: image returned ${response.status}`)
    }
  }

  const rssUrl = new URL(RSS_PATH, localOrigin).href
  const rss = await fetchText(fetchImpl, rssUrl, "RSS", errors)
  const rssPaths = new Set(
    (rss === null ? [] : extractRssLinks(rss)).map((url) => new URL(url, localOrigin).pathname)
  )
  for (const articlePath of expectedPaths) {
    if (!rssPaths.has(articlePath)) {
      errors.push(`${new URL(articlePath, localOrigin).href}: article missing from RSS`)
    }
  }

  for (const articlePath of expectedPaths) {
    const articleUrl = new URL(articlePath, localOrigin).href
    const facts = pageFacts.get(articleUrl)
    if (!facts) continue
    if (facts.tagUrls.length === 0) {
      errors.push(`${articleUrl}: article has no tag archive links`)
      continue
    }
    for (const tagUrl of facts.tagUrls) {
      const tagFacts = pageFacts.get(tagUrl)
      if (!tagFacts) {
        errors.push(`${sanitizeReportUrl(tagUrl)}: tag archive missing from sitemap`)
      } else if (!tagFacts.localHrefs.includes(articlePath)) {
        errors.push(`${sanitizeReportUrl(tagUrl)}: tag archive is missing ${articlePath}`)
      }
    }
  }

  return {
    articleCount: discoveredArticlePaths.size,
    tagCount: blogPaths.filter((path) => path.startsWith("/blog/tags/")).length,
    imageCount: imageUrls.length,
    errors: unique(errors),
  }
}

function argumentValue(args, name) {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

async function expectedProgramSlugs() {
  const source = await readFile(
    new URL("../src/content/blog-program.json", import.meta.url),
    "utf8"
  )
  const program = JSON.parse(source)
  return program.map((entry) => entry.slug)
}

async function main() {
  const origin = argumentValue(process.argv.slice(2), "--origin")
  if (!origin) {
    console.error("Usage: node scripts/crawl-built-blog.mjs --origin http://localhost:8787")
    process.exitCode = 1
    return
  }

  const result = await crawlBuiltBlog({
    origin,
    expectedArticleSlugs: await expectedProgramSlugs(),
  })
  if (result.errors.length > 0) {
    for (const error of result.errors) console.error(error)
    console.error(`Built blog crawl failed with ${result.errors.length} error(s).`)
    process.exitCode = 1
    return
  }

  console.log(
    `Built blog crawl passed: ${result.articleCount} articles, ${result.tagCount} tag archives, ${result.imageCount} images.`
  )
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : ""
if (import.meta.url === invokedPath) {
  await main()
}
