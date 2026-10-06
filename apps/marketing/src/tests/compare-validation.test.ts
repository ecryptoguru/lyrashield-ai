import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import program from "../content/compare-program.json"
import { parseArticle } from "../../scripts/blog-validation-lib.mjs"
import {
  COMPARE_REVIEW_MAX_AGE_DAYS,
  COMPARE_SOURCE_MINIMUM,
  citationHost,
  collectCompetitorSources,
  collectDisclaimerAnchors,
  competitorHostFromDisclaimer,
  isCompetitorHost,
  validateComparePage,
  validateCompareProgram,
} from "../../scripts/compare-validation-lib.mjs"

const SOURCES = [
  "## Sources",
  "",
  "- [Rival platform](https://rival.example/platform)",
  "- [Rival docs](https://docs.rival.example/)",
  "- [Rival pricing](https://rival.example/pricing)",
].join("\n")

const BODY = [
  "## Core approach",
  "",
  "| Aspect | LyraShield AI | Rival |",
  "| --- | --- | --- |",
  "| Focus | Release assurance | Scanning |",
  "",
  SOURCES,
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
      'Factual comparison. <a href="https://rival.example/">Rival</a> is a scanning platform. <a href="https://lyrashieldai.com/">LyraShield AI</a> is release assurance. Neither replaces the other.',
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

  it("rejects Markdown link syntax in the disclaimer the template renders as HTML", () => {
    // The compare template renders `disclaimer` with set:html, so Markdown link
    // syntax prints literally. Five pages shipped that way before this guard.
    const markdown = {
      ...page().data,
      disclaimer: "Factual comparison. [Rival](https://rival.example/) is a scanner.",
    }
    expect(validateComparePage(page({ data: markdown }))).toContain(
      "disclaimer must use HTML anchors, not Markdown link syntax"
    )
    const html = {
      ...page().data,
      disclaimer: 'Factual comparison. <a href="https://rival.example/">Rival</a> is a scanner.',
    }
    expect(validateComparePage(page({ data: html }))).toEqual([])
  })

  it("rejects a plain-HTTP citation inside the disclaimer", () => {
    const data = {
      ...page().data,
      disclaimer: 'Factual comparison. <a href="http://rival.example/">Rival</a> is a scanner.',
    }
    expect(validateComparePage(page({ data }))).toContain(
      "citation must use HTTPS: http://rival.example/"
    )
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

  it("requires a competitor-source floor on every page (Wave 8)", () => {
    const body = BODY.replace(SOURCES, "")
    expect(validateComparePage(page({ body }))).toContain(
      `comparison requires at least ${COMPARE_SOURCE_MINIMUM} competitor sources in a "## Sources" block (found 0)`
    )
  })

  it("requires at least one source on the competitor's own domain", () => {
    const body = BODY.replace(
      "- [Rival platform](https://rival.example/platform)\n- [Rival docs](https://docs.rival.example/)\n- [Rival pricing](https://rival.example/pricing)",
      "- [Analysis one](https://one.example/a)\n- [Analysis two](https://two.example/b)\n- [Analysis three](https://three.example/c)"
    )
    // Neither the Sources block nor the disclaimer carries a vendor-domain link.
    const data = {
      ...page().data,
      disclaimer:
        'Factual comparison. Rival is a scanning platform. <a href="https://lyrashieldai.com/">LyraShield AI</a> is release assurance. Neither replaces the other.',
      competitorDomain: "rival.example",
    }
    expect(validateComparePage(page({ body, data }))).toContain(
      "comparison requires at least one source on the competitor's own domain (rival.example)"
    )
  })

  it("accepts a vendor-domain citation in the Sources block", () => {
    const body = BODY.replace(
      "- [Rival platform](https://rival.example/platform)\n- [Rival docs](https://docs.rival.example/)\n- [Rival pricing](https://rival.example/pricing)",
      "- [Analysis one](https://one.example/a)\n- [Analysis two](https://two.example/b)\n- [Rival platform](https://rival.example/platform)"
    )
    const sources = collectCompetitorSources({ body })
    expect(sources).toContain("https://rival.example/platform")
    expect(validateComparePage(page({ body }))).toEqual([])
  })

  it("honours an explicit competitorClaims: false declaration", () => {
    const body = BODY.replace(SOURCES, "")
    const data = { ...page().data, competitorClaims: false, competitorDomain: undefined }
    expect(validateComparePage(page({ body, data }))).toEqual([])
  })

  it("rejects a non-boolean competitorClaims declaration", () => {
    const data = { ...page().data, competitorClaims: "yes" }
    expect(validateComparePage(page({ data }))).toContain("competitorClaims must be a boolean")
  })

  it("derives the competitor host from the disclaimer when none is declared", () => {
    expect(competitorHostFromDisclaimer(page().data)).toBe("rival.example")
    const data = { ...page().data, competitorDomain: undefined }
    expect(validateComparePage(page({ data }))).toEqual([])
  })

  it("skips the vendor-domain half when the disclaimer does not link the competitor", () => {
    const data = {
      ...page().data,
      disclaimer:
        'Factual comparison. Rival is a scanning platform. <a href="https://lyrashieldai.com/">LyraShield AI</a> is release assurance. Neither replaces the other.',
    }
    expect(competitorHostFromDisclaimer(data)).toBeNull()
    expect(isCompetitorHost("rival.example", null)).toBe(false)
    expect(validateComparePage(page({ data }))).toEqual([])
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

  it("every shipped compare page declares claims and cites the vendor", () => {
    const compareRoot = join(dirname(fileURLToPath(import.meta.url)), "../content/compare")
    const files = readdirSync(compareRoot).filter((name) => /\.mdx?$/.test(name))
    expect(files).toHaveLength(13)
    for (const name of files) {
      const parsed = parseArticle(readFileSync(join(compareRoot, name), "utf8"))
      const data = parsed.data as { competitorClaims?: boolean; competitorDomain?: string }
      const body: string = parsed.body
      const slug = name.replace(/\.mdx?$/, "")
      expect(data.competitorClaims, `${slug} must declare competitorClaims`).toBe(true)
      expect(typeof data.competitorDomain, `${slug} must declare competitorDomain`).toBe("string")
      const sources = collectCompetitorSources({ body }).filter((url: string) =>
        /^https:\/\//i.test(url)
      )
      expect(
        sources.length,
        `${slug} needs at least ${COMPARE_SOURCE_MINIMUM} sources`
      ).toBeGreaterThanOrEqual(COMPARE_SOURCE_MINIMUM)
      const citable = [...sources, ...collectDisclaimerAnchors(data)]
      expect(
        citable.some((url: string) => isCompetitorHost(citationHost(url), data.competitorDomain)),
        `${slug} needs a source on ${data.competitorDomain}`
      ).toBe(true)
    }
  })

  it("gives the rendered comparison body real typography", () => {
    // Without a typography class the markdown below the tables rendered as
    // plain 16px text: no heading sizes, no list markers, no link styling.
    const template = readFileSync(new URL("../pages/compare/[slug].astro", import.meta.url), "utf8")
    const wrapper = template.match(/class="([^"]*compare-body[^"]*)"/)
    expect(wrapper, "compare-body wrapper present").not.toBeNull()
    const classes = wrapper![1].split(/\s+/)
    expect(classes, "compare-body carries the prose class").toContain("prose")
    expect(classes).toContain("max-w-none")
    expect(classes.some((name) => name.startsWith("prose-a:"))).toBe(true)
    expect(classes.some((name) => name.startsWith("prose-headings:"))).toBe(true)

    // The site switches theme with :root[data-theme], but Tailwind emits
    // `dark:` inside prefers-color-scheme, so a dark: prose variant follows the
    // OS rather than the theme. global.css maps the prose variables to the site
    // tokens instead, and no prose surface should carry a dark: variant.
    const styles = readFileSync(new URL("../styles/global.css", import.meta.url), "utf8")
    for (const token of [
      "--tw-prose-body: var(--text-muted)",
      "--tw-prose-headings: var(--text)",
      "--tw-prose-links: var(--accent)",
    ]) {
      expect(styles, `global.css maps ${token}`).toContain(token)
    }

    // The headings that sit directly above a table ("Core approach",
    // "Capability comparison") read as that table's caption. Markdown emits no
    // <caption>, so the heading carries the role.
    expect(styles).toContain(".compare-body h2:has(+ table)")

    // The existing table scroll container must survive the typography change.
    expect(styles).toContain(".compare-body table")
    expect(styles).toContain("overflow-x: auto")
  })

  it("shows the review date in the site's day-month-year format", () => {
    const template = readFileSync(new URL("../pages/compare/[slug].astro", import.meta.url), "utf8")
    expect(template).toContain('toLocaleDateString("en-GB"')
    // The machine-readable value stays ISO.
    expect(template).toContain("<time datetime={reviewed}>{reviewedLabel}</time>")
    expect(template).toContain("dateModified: reviewed")
  })
})
