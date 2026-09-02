import { describe, expect, it } from "vitest"

import program from "../content/compare-program.json"
import {
  COMPARE_REVIEW_MAX_AGE_DAYS,
  validateComparePage,
  validateCompareProgram,
} from "../../scripts/compare-validation-lib.mjs"

const BODY = [
  "## Core approach",
  "",
  "| Aspect | LyraShield AI | Rival |",
  "| --- | --- | --- |",
  "| Focus | Release assurance | Scanning |",
  "",
  "## Methodology and scope",
  "",
  "See [how LyraShield reports coverage](/methodology) for the assurance model.",
].join("\n")

const page = (overrides = {}) => ({
  slug: "rival",
  data: {
    title: "LyraShield AI vs Rival — Release Assurance vs Scanning",
    description:
      "How LyraShield AI compares to Rival for AI-built application security. Evidence states, coverage framework, and release assurance differences.",
    competitor: "Rival",
    heading: "LyraShield AI vs Rival",
    disclaimer:
      "Factual comparison. This page compares publicly documented capabilities of both platforms and neither replaces the other.",
    updatedDate: new Date().toISOString().slice(0, 10),
    draft: false,
    pricingLadder: true,
    faq: [
      { q: "Does it replace Rival?", a: "No." },
      { q: "Can they run together?", a: "Yes." },
    ],
  },
  body: BODY,
  programEntry: { index: 1, slug: "rival", competitor: "Rival" },
  ...overrides,
})

describe("compare governance", () => {
  it("accepts a well-formed comparison", () => {
    expect(validateComparePage(page())).toEqual([])
  })

  it("requires the page to be mapped in the program", () => {
    expect(validateComparePage(page({ programEntry: undefined }))).toContain(
      "page is not mapped in the compare program"
    )
  })

  it("requires the shared ladder and rejects copied LyraShield prices", () => {
    expect(validateComparePage(page({ data: { ...page().data, pricingLadder: false } }))).toContain(
      "comparison must render the shared pricing ladder"
    )
    expect(
      validateComparePage(
        page({
          body: BODY.replace(
            "| Focus | Release assurance | Scanning |",
            "| Pricing | Starter $29/month | Scanning |"
          ),
        })
      )
    ).toContain("comparison must not hardcode the LyraShield pricing ladder")
  })

  it("catches a competitor name that drifts from the program", () => {
    const entry = { index: 1, slug: "rival", competitor: "Rival Inc" }
    expect(validateComparePage(page({ programEntry: entry }))).toContain(
      "competitor does not match the program: Rival vs Rival Inc"
    )
  })

  it("inherits the blog prohibited-claim and placeholder rules", () => {
    const data = { ...page().data, disclaimer: page().data.disclaimer + " We guarantee security." }
    expect(validateComparePage(page({ data }))).toContain(
      "prohibited product claim: guarantee security"
    )
    const withPlaceholder = { ...page().data, description: page().data.description + " TBD" }
    expect(validateComparePage(page({ data: withPlaceholder }))).toContain(
      "unresolved placeholder: TBD"
    )
  })

  it("requires the methodology link", () => {
    const body = BODY.replace("(/methodology)", "(/methodology-missing)")
    expect(validateComparePage(page({ body }))).toContain("missing required /methodology link")
  })

  it("rejects unpublished internal blog dependencies", () => {
    const body = `${BODY}\n\nSee [the comparison](/blog/rival-vs-lyrashield).`
    const context = { publishedBlogSlugs: new Set(["something-else"]) }
    expect(validateComparePage({ ...page(), body, context })).toContain(
      "unpublished internal dependency: /blog/rival-vs-lyrashield"
    )
  })

  it("rejects non-HTTPS citations", () => {
    const body = `${BODY}\n\n[Rival](http://rival.example)`
    expect(validateComparePage(page({ body }))).toContain(
      "citation must use HTTPS: http://rival.example"
    )
  })

  it("does not inherit the blog dash ban", () => {
    expect(validateComparePage(page())).toEqual([])
    expect(page().data.title).toContain("—")
  })

  it("flags a stale review date", () => {
    const stale = new Date(Date.now() - (COMPARE_REVIEW_MAX_AGE_DAYS + 5) * 86_400_000)
    const data = { ...page().data, updatedDate: stale.toISOString().slice(0, 10) }
    const errors = validateComparePage(page({ data }))
    expect(errors.some((error) => error.startsWith("review is stale"))).toBe(true)
  })

  it("requires an H2 and a table, and forbids an H1", () => {
    expect(validateComparePage(page({ body: "# Heading\n\n" + BODY }))).toContain(
      "body must not contain an H1; the heading comes from frontmatter"
    )
    expect(validateComparePage(page({ body: "Just prose." }))).toEqual(
      expect.arrayContaining([
        "body must contain at least one H2",
        "comparison must include at least one table",
      ])
    )
  })

  it("validates the shipped program manifest", () => {
    expect(validateCompareProgram(program)).toEqual([])
    expect(program).toHaveLength(13)
  })
})
