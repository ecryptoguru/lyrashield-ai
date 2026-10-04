/**
 * Governance for the /compare surface.
 *
 * These pages make public claims about named competitors, so they get the same
 * evidence discipline as the blog: a program manifest is the source of truth for
 * which comparisons exist, prohibited product claims and placeholders are shared
 * with the blog rules, internal links must resolve, and every page carries a
 * review date that has to stay fresh.
 *
 * One blog rule is deliberately NOT inherited: the dash ban is a blog prose
 * convention and the live compare pages have always used em dashes.
 *
 * The external-source floor IS inherited as of the Wave 8 consolidation
 * (decision D9). The compare pages became the canonical home for competitor
 * facts when the 13 long-form `-vs-lyrashield` posts were retired and 301
 * redirected here, so a page that carries competitor claims must now cite them.
 *
 * The floor is conditional and declared rather than inferred (merge sheet
 * section D2). A page declares `competitorClaims: true` and names the
 * competitor's own domain in `competitorDomain`, and is then required to carry a
 * `## Sources` block of at least COMPARE_SOURCE_MINIMUM HTTPS citations with at
 * least one on that domain. On a comparison page the authoritative source for
 * "what the competitor does" is the competitor's own documentation, which is a
 * stronger and more checkable rule than the blog's primary-or-official host
 * table (that table was built for technical standards rather than vendors).
 *
 * D2 sketched `competitorSources` as a list of {label, url} objects. This file
 * reads frontmatter with the shared hand-rolled parser, which handles scalars
 * and flat lists but not nested object lists, so the same obligation is
 * expressed with two scalars. The substance is unchanged: the obligation is
 * declared, it is conditional, and it demands a vendor-domain citation.
 */

import { PROHIBITED_CLAIMS, PLACEHOLDERS } from "./blog-validation-lib.mjs"

export const COMPARE_REVIEW_MAX_AGE_DAYS = 180

/** Minimum competitor-source links every compare page must carry. */
export const COMPARE_SOURCE_MINIMUM = 3

/** A compare page must carry competitor claims, so every page must cite sources. */
export const COMPARE_SOURCES_REQUIRED = true

const extractLinks = (body) => [...body.matchAll(/\]\(([^)\s]+)/g)].map((match) => match[1])

/**
 * Host of a citation URL, lowercased and without a leading `www.`, or null when
 * the URL does not parse. Used for the competitor-own-domain half of the floor.
 */
export function citationHost(rawUrl) {
  try {
    return new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, "")
  } catch {
    return null
  }
}

/** True when a citation host belongs to the competitor's own site. */
export function isCompetitorHost(host, competitorHost) {
  if (!host || !competitorHost) return false
  const vendor = competitorHost.toLowerCase().replace(/^www\./, "")
  return host === vendor || host.endsWith(`.${vendor}`)
}

/**
 * The citations in a page's declared `## Sources` block. Only this block counts
 * toward the floor, so a link that happens to sit in a comparison table cannot
 * satisfy it.
 */
export function collectCompetitorSources({ body }) {
  const sources = []
  const seen = new Set()
  const lines = String(body ?? "").split("\n")
  const start = lines.findIndex((line) => /^##\s+Sources\s*$/.test(line))
  if (start === -1) return sources
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line)) break
    for (const link of extractLinks(line)) {
      if (link && !seen.has(link)) {
        seen.add(link)
        sources.push(link)
      }
    }
  }
  return sources
}

/** Competitor anchors already published in the page's disclaimer. */
export function collectDisclaimerAnchors(data = {}) {
  return extractHrefs(String(data.disclaimer ?? ""))
}

/**
 * Host of the competitor's own site, derived from the anchors the disclaimer
 * already carries. Null when the disclaimer names the competitor without
 * linking it, in which case only the citation-count half of the floor applies.
 */
export function competitorHostFromDisclaimer(data = {}) {
  const internal = new Set(["lyrashieldai.com", "lyrashield.ai"])
  for (const href of collectDisclaimerAnchors(data)) {
    const host = citationHost(href)
    if (host && !internal.has(host) && !host.endsWith("lyrashieldai.com")) return host
  }
  return null
}

/**
 * The floor: at least COMPARE_SOURCE_MINIMUM HTTPS citations in the `## Sources`
 * block, and at least one vendor-domain citation, which may sit either in that
 * block or as an anchor in the disclaimer.
 *
 * `declared` is the page's `competitorClaims` frontmatter value. `false` means
 * the page states it carries no competitor claims, and the floor is skipped;
 * any other value keeps the floor on, so silence is never an exemption.
 */
export function validateCompetitorSources({
  data,
  body,
  competitorHost,
  minimum,
  required,
  declared,
}) {
  const errors = []
  if (required === false || declared === false) return errors
  if (declared !== undefined && typeof declared !== "boolean") {
    errors.push("competitorClaims must be a boolean")
  }

  const sources = collectCompetitorSources({ body })
  const https = sources.filter((url) => /^https:\/\//i.test(url))
  for (const url of sources) {
    if (!/^https:\/\//i.test(url)) errors.push(`citation must use HTTPS: ${url}`)
  }

  if (https.length < minimum) {
    errors.push(
      `comparison requires at least ${minimum} competitor sources in a "## Sources" block (found ${https.length})`
    )
  }
  if (competitorHost) {
    const citable = [...https, ...collectDisclaimerAnchors(data)]
    const onVendorDomain = citable.some((url) =>
      isCompetitorHost(citationHost(url), competitorHost)
    )
    if (!onVendorDomain) {
      errors.push(
        `comparison requires at least one source on the competitor's own domain (${competitorHost})`
      )
    }
  }
  return errors
}

/**
 * Anchor targets from HTML markup. The `disclaimer` field is rendered with
 * set:html, so its links are real `<a href>` markup rather than Markdown and
 * `extractLinks` never sees them. Without this the HTTPS rule silently skipped
 * the one field that is most likely to carry a competitor citation.
 */
const extractHrefs = (text) => [...text.matchAll(/<a\s[^>]*href="([^"]+)"/gi)].map((m) => m[1])

export function validateCompareProgram(program) {
  const errors = []
  if (!Array.isArray(program)) return ["compare program must be a top-level array"]

  const slugs = new Set()
  for (const [position, entry] of program.entries()) {
    const at = position + 1
    if (!entry || typeof entry !== "object") {
      errors.push(`compare program entry ${at} must be an object`)
      continue
    }
    if (!Number.isInteger(entry.index) || entry.index !== at) {
      errors.push(`compare program entry ${at} has an invalid or out-of-order index`)
    }
    if (typeof entry.slug !== "string" || !/^[a-z0-9-]+$/.test(entry.slug)) {
      errors.push(`compare program entry ${at} has an invalid slug`)
    } else if (slugs.has(entry.slug)) {
      errors.push(`compare program contains duplicate slug: ${entry.slug}`)
    } else {
      slugs.add(entry.slug)
    }
    if (typeof entry.competitor !== "string" || !entry.competitor.trim()) {
      errors.push(`compare program entry ${at} is missing a competitor name`)
    }
  }
  return errors
}

export function validateComparePage({ slug, data, body, programEntry, context = {} }) {
  const errors = []
  const text = `${data.title ?? ""}\n${data.description ?? ""}\n${data.disclaimer ?? ""}\n${body}`

  if (!programEntry) errors.push("page is not mapped in the compare program")
  else if (programEntry.competitor !== data.competitor) {
    errors.push(
      `competitor does not match the program: ${data.competitor} vs ${programEntry.competitor}`
    )
  }

  if (data.draft !== false) errors.push("released comparison must set draft: false")
  if (data.pricingLadder !== true) errors.push("comparison must render the shared pricing ladder")
  if (/\|\s*Pricing\s*\|[^|\n]*(?:\$29|\$99|\$499|\$1,500)/.test(body)) {
    errors.push("comparison must not hardcode the LyraShield pricing ladder")
  }

  for (const [label, pattern] of PROHIBITED_CLAIMS) {
    if (pattern.test(text)) errors.push(`prohibited product claim: ${label}`)
  }
  for (const [label, pattern] of PLACEHOLDERS) {
    if (pattern.test(text)) errors.push(`unresolved placeholder: ${label}`)
  }

  // The template renders `disclaimer` with set:html, so Markdown link syntax is
  // printed literally instead of becoming an anchor. Five pages shipped that
  // way and the raw `[Name](url)` text was visible in the callout. The field is
  // HTML, so require HTML anchors and reject Markdown ones.
  const disclaimer = data.disclaimer ?? ""
  if (/\[[^\]]*\]\([^)]*\)/.test(disclaimer)) {
    errors.push("disclaimer must use HTML anchors, not Markdown link syntax")
  }
  for (const link of extractHrefs(disclaimer)) {
    if (/^http:\/\//i.test(link)) errors.push(`citation must use HTTPS: ${link}`)
  }

  if (context.titles && context.titles.get(data.title) > 1) errors.push("duplicate title")
  if (context.descriptions && context.descriptions.get(data.description) > 1) {
    errors.push("duplicate description")
  }

  // A comparison that cites nothing is allowed; a citation that is not HTTPS is
  // not. The body is Markdown; the disclaimer is HTML.
  for (const link of extractLinks(body)) {
    if (/^http:\/\//i.test(link)) errors.push(`citation must use HTTPS: ${link}`)
  }

  // Internal links have to resolve, and the methodology link is mandatory: these
  // pages assert a testing model and must point at where that model is described.
  const internal = extractLinks(body).filter((link) => link.startsWith("/"))
  if (!internal.some((link) => link === "/methodology")) {
    errors.push("missing required /methodology link")
  }
  if (context.publishedBlogSlugs) {
    for (const link of internal.filter((link) => link.startsWith("/blog/"))) {
      const dependency = link.slice(6).split(/[?#]/, 1)[0].replace(/\/$/, "")
      if (dependency && !context.publishedBlogSlugs.has(dependency)) {
        errors.push(`unpublished internal dependency: ${link}`)
      }
    }
  }

  // The competitor-source floor (Wave 8). A compare page is the canonical home
  // for competitor facts, so it has to cite them.
  errors.push(
    ...validateCompetitorSources({
      data,
      body,
      competitorHost:
        context.competitorHost ?? data.competitorDomain ?? competitorHostFromDisclaimer(data),
      minimum: COMPARE_SOURCE_MINIMUM,
      required: COMPARE_SOURCES_REQUIRED,
      declared: data.competitorClaims,
    })
  )

  if (/^#\s/m.test(body))
    errors.push("body must not contain an H1; the heading comes from frontmatter")
  if (!/^##\s/m.test(body)) errors.push("body must contain at least one H2")
  if (!/^\|.*\|$/m.test(body)) errors.push("comparison must include at least one table")

  const reviewed = new Date(data.updatedDate)
  if (Number.isNaN(reviewed.getTime())) errors.push("updatedDate is not a valid date")
  else {
    const now = Number.isFinite(context.now) ? context.now : Date.now()
    const age = Math.floor((now - reviewed.getTime()) / 86_400_000)
    if (age > COMPARE_REVIEW_MAX_AGE_DAYS) {
      errors.push(`review is stale: ${age} days old, limit ${COMPARE_REVIEW_MAX_AGE_DAYS}`)
    }
  }

  return [...new Set(errors)]
}
