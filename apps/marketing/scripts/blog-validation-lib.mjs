import { existsSync, readFileSync, statSync } from "node:fs"
import { resolve, sep } from "node:path"

export const STABLE_TAGS = new Set([
  "vibe-coding-security",
  "access-control",
  "web-security",
  "supply-chain",
  "agent-security",
  "verification",
])

const PLACEHOLDERS = [
  ["TBD", /\bTBD\b/i],
  ["TODO", /\bTODO\b/i],
  ["TK", /\bTK\b/i],
  ["lorem ipsum", /\blorem\s+ipsum\b/i],
  ["example.com", /\bexample\.com\b/i],
  ["[citation needed]", /\[citation\s+needed\]/i],
  ["empty Markdown link", /\[[^\]]*\]\(\s*\)/],
]

const PROHIBITED_CLAIMS = [
  ["guarantee security", /\bguarantee(?:s|d|ing)?\s+security\b/i],
  ["fully secure", /\bfully\s+secure\b/i],
  ["automatic fixes", /\bautomatic(?:ally)?\s+fix(?:es|ed|ing)?\b/i],
  ["automatic PR", /\bautomatic(?:ally)?\s+(?:fix\s+)?PRs?\b/i],
  ["all 50", /\ball\s+50\b/i],
  ["zero false positives", /\bzero\s+false\s+positives\b/i],
  ["100% accurate", /\b100\s*%\s+accurate\b/i],
  ["customers include", /\bcustomers\s+include\b/i],
  ["starting at $", /\bstarting\s+at\s+\$/i],
]

const OFFICIAL_HOSTS = [
  "owasp.org",
  "mitre.org",
  "nist.gov",
  "ncsc.gov.uk",
  "cisa.gov",
  "developer.mozilla.org",
  "amazon.com",
  "modelcontextprotocol.io",
  "nextjs.org",
  "first.org",
  "bolt.new",
  "replit.com",
  "npmjs.com",
  "base44.com",
  "react.dev",
  "w3.org",
  "vite.dev",
  "v0.app",
  "v0.dev",
  "fastapi.tiangolo.com",
  "oasis-open.org",
  "lovable.dev",
  "docker.com",
  "devin.ai",
  "cursor.com",
  "claude.com",
  "threatmodelingmanifesto.org",
  "starlette.io",
  "slsa.dev",
  "osv.dev",
  "opentelemetry.io",
  "openid.net",
  "json-schema.org",
  "git-scm.com",
  "palletsprojects.com",
  "whatwg.org",
  "europa.eu",
  "pypi.org",
  "nestjs.com",
  "expressjs.com",
  "apple.com",
  "android.com",
]

const PRIMARY_HOSTS = [
  "datatracker.ietf.org",
  "rfc-editor.org",
  "docs.github.com",
  "github.com",
  "supabase.com",
  "stripe.com",
  "cloudflare.com",
  "vercel.com",
  "openai.com",
  "anthropic.com",
  "google.com",
  "microsoft.com",
  "postgresql.org",
  "nodejs.org",
  "python.org",
  "arxiv.org",
  "doi.org",
  "usenix.org",
  "aclanthology.org",
  "ossf.github.io",
]

const IMAGE_FIELDS = {
  avif: { file: "hero.avif", width: 1600, height: 900, maxBytes: 220 * 1024, format: "avif" },
  webp: { file: "hero.webp", width: 1600, height: 900, maxBytes: 320 * 1024, format: "webp" },
  jpeg: { file: "hero.jpg", width: 1600, height: 900, maxBytes: 320 * 1024, format: "jpeg" },
  og: { file: "og.jpg", width: 1200, height: 630, maxBytes: 350 * 1024, format: "jpeg" },
  socialPortrait: {
    file: "social-portrait.jpg",
    width: 1080,
    height: 1350,
    maxBytes: 350 * 1024,
    format: "jpeg",
  },
}

function unquote(value) {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).replace(/\\([\\"'])/g, "$1")
  }
  return trimmed
}

function parseScalar(value) {
  const unquoted = unquote(value)
  if (unquoted === "true") return true
  if (unquoted === "false") return false
  if (unquoted === "null" || unquoted === "~") return null
  if (/^-?\d+(?:\.\d+)?$/.test(unquoted)) return Number(unquoted)
  if (unquoted.startsWith("[") && unquoted.endsWith("]")) {
    const inner = unquoted.slice(1, -1).trim()
    return inner ? inner.split(",").map((item) => unquote(item)) : []
  }
  return unquoted
}

export function parseArticle(source) {
  if (!source.startsWith("---\n") && !source.startsWith("---\r\n")) {
    throw new Error("article is missing YAML frontmatter")
  }

  const normalized = source.replace(/\r\n/g, "\n")
  const closing = normalized.indexOf("\n---\n", 4)
  if (closing === -1) throw new Error("article frontmatter is not closed")

  const lines = normalized.slice(4, closing).split("\n")
  const data = {}
  let listKey = null
  let faqEntry = null

  for (const line of lines) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue
    const keyMatch = line.match(/^([A-Za-z][\w-]*):(?:\s*(.*))?$/)
    if (keyMatch) {
      const [, key, raw = ""] = keyMatch
      if (raw.trim()) {
        data[key] = parseScalar(raw)
        listKey = null
      } else {
        data[key] = []
        listKey = key
      }
      faqEntry = null
      continue
    }

    if (listKey === "tags") {
      const item = line.match(/^\s+-\s+(.+)$/)
      if (item) data.tags.push(unquote(item[1]))
      continue
    }

    if (listKey === "faq") {
      const newEntry = line.match(/^\s+-\s+(q|a):\s*(.*)$/)
      if (newEntry) {
        faqEntry = { [newEntry[1]]: unquote(newEntry[2]) }
        data.faq.push(faqEntry)
        continue
      }
      const property = line.match(/^\s+(q|a):\s*(.*)$/)
      if (property && faqEntry) faqEntry[property[1]] = unquote(property[2])
    }
  }

  return { data, body: normalized.slice(closing + 5).trim() }
}

export function validateArticleText(text) {
  const errors = []
  if (text.includes("—")) errors.push("prohibited em dash")
  if (text.includes("–")) errors.push("prohibited en dash")

  for (const [label, pattern] of PLACEHOLDERS) {
    if (pattern.test(text)) errors.push(`unresolved placeholder: ${label}`)
  }
  for (const [label, pattern] of PROHIBITED_CLAIMS) {
    if (pattern.test(text)) errors.push(`prohibited product claim: ${label}`)
  }
  return errors
}

function withoutCode(text) {
  return text.replace(/```[\s\S]*?```/g, " ").replace(/~~~[\s\S]*?~~~/g, " ")
}

export function markdownWordCount(markdown) {
  const prose = withoutCode(markdown)
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/[`*_>{}|]/g, " ")
  return prose.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)?.length ?? 0
}

function firstProseParagraph(body) {
  const clean = withoutCode(body)
  for (const block of clean.split(/\n\s*\n/)) {
    const value = block.trim()
    if (
      !value ||
      /^#{1,6}\s/.test(value) ||
      /^<(?:import|script|style|[A-Z][\w.]*)\b/.test(value)
    ) {
      continue
    }
    if (/^!\[/.test(value)) continue
    return value
  }
  return ""
}

export function extractLinks(markdown) {
  const links = []
  const pattern = /(?<!!)\[[^\]]*\]\(\s*([^\s)]+)(?:\s+["'][^"']*["'])?\s*\)/g
  for (const match of markdown.matchAll(pattern)) links.push(match[1])
  return links
}

function headingErrors(body) {
  const errors = []
  const headings = []
  const anchors = new Set()
  for (const line of withoutCode(body).split("\n")) {
    const match = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/)
    if (!match) continue
    const level = match[1].length
    headings.push(level)
    if (level === 1) errors.push("article body must not contain an H1")
    const anchor = match[2]
      .toLowerCase()
      .replace(/<[^>]+>/g, "")
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .trim()
      .replace(/\s+/g, "-")
    if (anchor && anchors.has(anchor)) errors.push(`duplicate heading anchor: ${anchor}`)
    anchors.add(anchor)
  }

  let previous = 1
  for (const level of headings) {
    if (level > previous + 1) {
      errors.push(`heading hierarchy skips from H${previous} to H${level}`)
      break
    }
    previous = level
  }
  if (!headings.some((level) => level === 2)) errors.push("article must contain an H2")
  return errors
}

function duplicateIn(map, value) {
  if (!map || !value) return false
  const matches = map.get(value)
  if (Array.isArray(matches) || matches instanceof Set)
    return matches.size > 1 || matches.length > 1
  return Number(matches ?? 0) > 1
}

function hostnameMatches(hostname, domains) {
  return domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))
}

export function classifySource(rawUrl) {
  try {
    const url = new URL(rawUrl)
    if (url.protocol !== "https:") return "invalid"
    const hostname = url.hostname.toLowerCase()
    if (hostnameMatches(hostname, PRIMARY_HOSTS)) return "primary"
    if (hostnameMatches(hostname, OFFICIAL_HOSTS)) return "official"
    if (hostname.endsWith(".gov") || hostname.endsWith(".gov.uk") || hostname.endsWith(".edu")) {
      return "official"
    }
    return "other"
  } catch {
    return "invalid"
  }
}

export function validateArticle(article, programEntry, context = {}) {
  const errors = [...validateArticleText(`${JSON.stringify(article.data)}\n${article.body}`)]
  const { data = {}, body = "", slug = programEntry?.slug ?? "unknown" } = article

  if (programEntry?.slug && slug !== programEntry.slug)
    errors.push("article slug does not match program")
  if (typeof data.title !== "string" || !data.title.trim()) errors.push("article title is required")
  else if (data.title.length > 70) errors.push("article title must be at most 70 characters")
  if (
    typeof data.description !== "string" ||
    data.description.length < 70 ||
    data.description.length > 160
  ) {
    errors.push("article description must be between 70 and 160 characters")
  }
  if (duplicateIn(context.titles, data.title)) errors.push("duplicate article title")
  if (duplicateIn(context.descriptions, data.description))
    errors.push("duplicate article description")
  if (data.draft !== false) errors.push("release article must set draft: false")

  if (!Array.isArray(data.tags) || data.tags.length < 1 || data.tags.length > 5) {
    errors.push("article must use between 1 and 5 stable tags")
  } else {
    for (const tag of data.tags) {
      if (!STABLE_TAGS.has(tag)) errors.push(`invalid or unstable tag: ${tag}`)
    }
  }

  if (
    data.faq !== undefined &&
    (!Array.isArray(data.faq) || data.faq.length < 2 || data.faq.length > 4)
  ) {
    errors.push("FAQ count must be between 2 and 4")
  }
  if (Array.isArray(data.faq)) {
    for (const [index, item] of data.faq.entries()) {
      if (!item?.q?.trim() || !item?.a?.trim())
        errors.push(`FAQ ${index + 1} requires a question and answer`)
    }
  }

  errors.push(...headingErrors(body))

  const isAuthority = programEntry?.index === 1 || slug === "vibe-coding-security-guide"
  const words = markdownWordCount(body)
  const [minimum, maximum] = isAuthority ? [2500, 3000] : [1200, 1500]
  if (words < minimum || words > maximum) {
    errors.push(`article word count must be between ${minimum} and ${maximum}; found ${words}`)
  }

  const answerWords = markdownWordCount(firstProseParagraph(body))
  if (answerWords < 40 || answerWords > 80) {
    errors.push(`direct answer must be between 40 and 80 words; found ${answerWords}`)
  }

  const links = extractLinks(body)
  const authorityPath = "/blog/vibe-coding-security-guide"
  if (!isAuthority) {
    const authorityPosition = body.indexOf(authorityPath)
    if (authorityPosition === -1) errors.push("missing contextual authority link")
    else if (authorityPosition > body.length / 3)
      errors.push("authority link must appear in the first third")
  }

  const toolLinks = links.filter((link) => link.startsWith("/tools/"))
  if (toolLinks.length === 0) errors.push("missing relevant free-tool link")
  const relatedLinks = links.filter((link) => {
    if (!link.startsWith("/blog/")) return false
    const linkedSlug = link.slice(6).split(/[?#]/, 1)[0].replace(/\/$/, "")
    return (
      linkedSlug &&
      linkedSlug !== slug &&
      linkedSlug !== "vibe-coding-security-guide" &&
      linkedSlug !== "editorial-policy"
    )
  })
  if (!isAuthority && relatedLinks.length === 0) errors.push("missing related-article link")

  const externalSources = [...new Set(links.filter((link) => /^https?:\/\//i.test(link)))]
  const classified = externalSources.map(classifySource)
  const authoritativeCount = classified.filter(
    (kind) => kind === "primary" || kind === "official"
  ).length
  const primaryOrOfficialMinimum = isAuthority ? 8 : 2
  const sourceMinimum = isAuthority ? 8 : 3
  if (externalSources.length < sourceMinimum) {
    errors.push(`article requires at least ${sourceMinimum} external sources`)
  }
  if (authoritativeCount < primaryOrOfficialMinimum) {
    errors.push(`article requires at least ${primaryOrOfficialMinimum} primary or official sources`)
  }
  for (const [index, kind] of classified.entries()) {
    if (kind === "invalid")
      errors.push(`external source must use HTTPS: ${redactUrl(externalSources[index])}`)
  }

  const availableSlugs = context.availableSlugs
  if (availableSlugs) {
    for (const link of links.filter((value) => value.startsWith("/blog/"))) {
      const dependency = link.slice(6).split(/[?#]/, 1)[0].replace(/\/$/, "")
      if (
        dependency &&
        dependency !== slug &&
        dependency !== "editorial-policy" &&
        !availableSlugs.has(dependency)
      ) {
        errors.push(`unpublished internal dependency: ${dependency}`)
      }
    }
  }

  if (context.catalog) {
    if (!data.heroImage) errors.push("article heroImage is required")
    else if (!context.catalog[data.heroImage]) errors.push(`unknown heroImage: ${data.heroImage}`)
  }
  if (context.manifestEntry && data.heroImage !== context.manifestEntry.imageId) {
    errors.push("article heroImage does not match release manifest")
  }

  return [...new Set(errors)]
}

export function validateUsageCounts(counts, finalDistribution = false) {
  const errors = []
  if (counts.some((count) => count > 3)) errors.push("shared image usage must not exceed 3")
  if (counts.some((count) => count < 1)) errors.push("shared image usage must be at least 1")
  if (finalDistribution) {
    const twos = counts.filter((count) => count === 2).length
    const threes = counts.filter((count) => count === 3).length
    if (counts.length !== 35 || threes !== 29 || twos !== 6) {
      errors.push("shared image distribution must be 29x3 and 6x2")
    }
  }
  return errors
}

function detectImage(buffer) {
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    const chunk = buffer.subarray(12, 16).toString("ascii")
    if (chunk === "VP8X" && buffer.length >= 30) {
      return {
        format: "webp",
        width: 1 + buffer.readUIntLE(24, 3),
        height: 1 + buffer.readUIntLE(27, 3),
      }
    }
    if (chunk === "VP8 " && buffer.length >= 30) {
      return {
        format: "webp",
        width: buffer.readUInt16LE(26) & 0x3fff,
        height: buffer.readUInt16LE(28) & 0x3fff,
      }
    }
    if (chunk === "VP8L" && buffer.length >= 25) {
      const bits = buffer.readUInt32LE(21)
      return { format: "webp", width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
    }
    return { format: "webp" }
  }

  if (buffer.length >= 12 && buffer.subarray(4, 8).toString("ascii") === "ftyp") {
    const brands = buffer.subarray(8, Math.min(buffer.length, 32)).toString("ascii")
    if (brands.includes("avif") || brands.includes("avis")) {
      const marker = buffer.indexOf(Buffer.from("ispe"))
      if (marker >= 4 && marker + 16 <= buffer.length) {
        return {
          format: "avif",
          width: buffer.readUInt32BE(marker + 8),
          height: buffer.readUInt32BE(marker + 12),
        }
      }
      return { format: "avif" }
    }
  }

  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2
    while (offset + 8 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1
        continue
      }
      const marker = buffer[offset + 1]
      if (marker === 0xd8 || marker === 0xd9) {
        offset += 2
        continue
      }
      if (offset + 4 > buffer.length) break
      const length = buffer.readUInt16BE(offset + 2)
      if (
        [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
          marker
        )
      ) {
        return {
          format: "jpeg",
          height: buffer.readUInt16BE(offset + 5),
          width: buffer.readUInt16BE(offset + 7),
        }
      }
      if (length < 2) break
      offset += 2 + length
    }
    return { format: "jpeg" }
  }

  return { format: "unknown" }
}

function normalizeManifests(manifests) {
  return manifests.map((manifest, index) => {
    if (Array.isArray(manifest)) return { release: `manifest-${index + 1}`, entries: manifest }
    return { release: manifest.release ?? `manifest-${index + 1}`, entries: manifest.entries ?? [] }
  })
}

export function validateImageLibrary(catalog, manifests, root, options = {}) {
  const errors = []
  const normalized = normalizeManifests(manifests)
  const usage = new Map()
  const hashes = new Map()
  const clusters = new Map()

  for (const { release, entries } of normalized) {
    if (!Array.isArray(entries)) {
      errors.push(`${release}: image manifest must be a top-level array`)
      continue
    }
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]
      if (!entry?.slug) {
        errors.push(`${release}: image manifest entry ${index + 1} is missing slug`)
        continue
      }
      if (!entry.imageId) {
        errors.push(`${entry.slug}: imageId is required`)
        continue
      }
      if (index > 0 && entries[index - 1]?.imageId === entry.imageId) {
        errors.push(`${release}: adjacent articles reuse image ${entry.imageId}`)
      }
      usage.set(entry.imageId, (usage.get(entry.imageId) ?? 0) + 1)
      if (!/^[a-f0-9]{64}$/.test(entry.sourceHash ?? "")) {
        errors.push(`${entry.slug}: sourceHash must be a SHA-256 hex digest`)
      } else if (hashes.has(entry.imageId) && hashes.get(entry.imageId) !== entry.sourceHash) {
        errors.push(`${entry.slug}: sourceHash differs for reused image ${entry.imageId}`)
      } else {
        hashes.set(entry.imageId, entry.sourceHash)
      }
      if (clusters.has(entry.imageId) && clusters.get(entry.imageId) !== entry.cluster) {
        errors.push(`${entry.slug}: cluster differs for reused image ${entry.imageId}`)
      } else {
        clusters.set(entry.imageId, entry.cluster)
      }
      if (entry.approved !== true) errors.push(`${entry.slug}: image approval is required`)
      if (!catalog[entry.imageId])
        errors.push(`${entry.slug}: missing image catalog entry ${entry.imageId}`)
    }
  }

  for (const { entries } of normalized) {
    for (const entry of entries) {
      if (!entry?.imageId) continue
      const actual = usage.get(entry.imageId)
      if (
        options.validateDeclaredUsage !== false &&
        (!Number.isInteger(entry.usageCount) || entry.usageCount !== actual)
      ) {
        errors.push(`${entry.slug}: usageCount must equal ${actual}`)
      }
      const item = catalog[entry.imageId]
      if (item && item.cluster !== entry.cluster) {
        errors.push(`${entry.slug}: manifest cluster does not match catalog for ${entry.imageId}`)
      }
    }
  }

  const authorityIds = new Set(
    normalized
      .filter(({ release }) => release === "authority")
      .flatMap(({ entries }) => entries.map((entry) => entry.imageId))
  )
  for (const imageId of authorityIds) {
    if ((usage.get(imageId) ?? 0) !== 1) errors.push(`authority image ${imageId} must be exclusive`)
  }
  const sharedCounts = [...usage.entries()]
    .filter(([imageId]) => !authorityIds.has(imageId))
    .map(([, count]) => count)
  errors.push(...validateUsageCounts(sharedCounts, options.finalDistribution === true))

  const publicRoot = resolve(root, "public")
  for (const imageId of usage.keys()) {
    const item = catalog[imageId]
    if (!item) continue
    if (item.width !== 1600 || item.height !== 900) {
      errors.push(`${imageId}: catalog dimensions must be 1600x900`)
    }
    if (typeof item.alt !== "string" || item.alt.length < 20 || item.alt.length > 180) {
      errors.push(`${imageId}: alt text must be between 20 and 180 characters`)
    }

    for (const [field, contract] of Object.entries(IMAGE_FIELDS)) {
      const expectedPath = `/images/blog/library/${imageId}/${contract.file}`
      if (item[field] !== expectedPath) {
        errors.push(`${imageId} ${field} path must be ${expectedPath}`)
        continue
      }
      const absolute = resolve(publicRoot, `.${item[field]}`)
      if (!absolute.startsWith(`${publicRoot}${sep}`)) {
        errors.push(`${imageId} ${field} path escapes the public directory`)
        continue
      }
      if (!existsSync(absolute)) {
        errors.push(`${imageId} ${field} file is missing`)
        continue
      }
      const size = statSync(absolute).size
      if (size > contract.maxBytes)
        errors.push(`${imageId} ${contract.file} exceeds ${contract.maxBytes} bytes`)
      const detected = detectImage(readFileSync(absolute))
      if (detected.format !== contract.format) {
        const label =
          contract.format === "jpeg" ? "JPEG" : contract.format === "webp" ? "WebP" : "AVIF"
        const article = contract.format === "webp" ? "a" : "an"
        errors.push(`${imageId} ${contract.file} must be ${article} ${label} image`)
      } else if (detected.width !== contract.width || detected.height !== contract.height) {
        errors.push(
          `${imageId} ${contract.file} dimensions must be ${contract.width}x${contract.height}`
        )
      }
    }
  }

  return [...new Set(errors)]
}

export function redactUrl(rawUrl) {
  try {
    const url = new URL(rawUrl)
    url.search = ""
    url.hash = ""
    return url.toString()
  } catch {
    return String(rawUrl).split(/[?#]/, 1)[0]
  }
}

async function fetchWithTimeout(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetchImpl(url, { ...init, redirect: "follow", signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

export async function checkExternalLinks(articles, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 10_000
  const cache = new Map()
  const errors = []

  for (const article of articles) {
    for (const rawUrl of [...new Set(article.urls ?? [])]) {
      let url
      try {
        url = new URL(rawUrl)
      } catch {
        errors.push(`${article.slug}: invalid external source URL: ${redactUrl(rawUrl)}`)
        continue
      }
      if (url.protocol !== "https:") {
        errors.push(`${article.slug}: external source must use HTTPS: ${redactUrl(rawUrl)}`)
        continue
      }

      if (!cache.has(url.href)) {
        const result = (async () => {
          try {
            let response = await fetchWithTimeout(
              fetchImpl,
              url.href,
              { method: "HEAD" },
              timeoutMs
            )
            if (response.status === 405 || response.status === 501) {
              response = await fetchWithTimeout(
                fetchImpl,
                url.href,
                { method: "GET", headers: { Range: "bytes=0-0" } },
                timeoutMs
              )
            }
            return response.status >= 200 && response.status < 400
              ? null
              : `external source returned ${response.status}`
          } catch (error) {
            return error?.name === "AbortError"
              ? "external source timed out"
              : "external source request failed"
          }
        })()
        cache.set(url.href, result)
      }

      const failure = await cache.get(url.href)
      if (failure) errors.push(`${article.slug}: ${failure}: ${redactUrl(rawUrl)}`)
    }
  }

  return errors
}
