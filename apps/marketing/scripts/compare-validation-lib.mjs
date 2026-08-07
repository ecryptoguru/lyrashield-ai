/**
 * Governance for the /compare surface.
 *
 * These pages make public claims about named competitors, so they get the same
 * evidence discipline as the blog: a program manifest is the source of truth for
 * which comparisons exist, prohibited product claims and placeholders are shared
 * with the blog rules, internal links must resolve, and every page carries a
 * review date that has to stay fresh.
 *
 * Two blog rules are deliberately NOT inherited. The dash ban is a blog prose
 * convention and the live compare pages have always used em dashes. And there is
 * no external-source floor: the four migrated pages cite nothing inline while the
 * newer ones cite up to nine, so citations are validated for shape rather than
 * counted.
 */

import { PROHIBITED_CLAIMS, PLACEHOLDERS } from "./blog-validation-lib.mjs"

export const COMPARE_REVIEW_MAX_AGE_DAYS = 180

const extractLinks = (body) => [...body.matchAll(/\]\(([^)\s]+)/g)].map((match) => match[1])

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

  for (const [label, pattern] of PROHIBITED_CLAIMS) {
    if (pattern.test(text)) errors.push(`prohibited product claim: ${label}`)
  }
  for (const [label, pattern] of PLACEHOLDERS) {
    if (pattern.test(text)) errors.push(`unresolved placeholder: ${label}`)
  }

  if (context.titles && context.titles.get(data.title) > 1) errors.push("duplicate title")
  if (context.descriptions && context.descriptions.get(data.description) > 1) {
    errors.push("duplicate description")
  }

  // A comparison that cites nothing is allowed; a citation that is not HTTPS is not.
  for (const link of extractLinks(body).concat(extractLinks(data.disclaimer ?? ""))) {
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
