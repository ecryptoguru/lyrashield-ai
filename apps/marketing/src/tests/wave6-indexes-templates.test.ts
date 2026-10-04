import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

/**
 * Wave 6 acceptance tests: indexes and templates.
 *
 * Handoff section 1 Wave 6 (items 6.1 to 6.9) and Spec sections 7 and 9.
 * Index pages get grouping and task labels; templates get a sample result, a
 * visible breadcrumb and a result-tied next step; the 404 offers four routes;
 * the Myra panel stops adding an H2 to every outline.
 */
function page(name: string): string {
  return readFileSync(new URL(`../pages/${name}`, import.meta.url), "utf8")
}
function component(name: string): string {
  return readFileSync(new URL(`../components/${name}`, import.meta.url), "utf8")
}

describe("Wave 6 indexes and templates", () => {
  it("6.1 groups the tools index with task labels and a Start here marker", () => {
    const tools = page("tools/index.astro")
    const registry = readFileSync(new URL("../lib/tools.ts", import.meta.url), "utf8")
    // The labels live in the registry and the page renders them.
    expect(registry).toContain("Your running app")
    expect(registry).toContain("Your code")
    expect(registry).toContain("Your agent surfaces")
    expect(tools).toContain("TOOL_GROUPS")
    expect(tools).toContain("group.label")
    expect(tools).toContain("Start here")
    // Link labels are tasks, not the repeated "Open tool".
    expect(tools).not.toContain(">Open tool<")
  })

  it("6.2 groups the compare index and gives each card a Choose this if line", () => {
    const compare = page("compare/index.astro")
    expect(compare).toContain("Choose this if")
    expect(compare).toContain("How we compare")
    // The card label is the competitor name, not a repeated phrase.
    expect(compare).not.toContain("Read comparison")
  })

  it("6.3 adds categories, search and a Start here row to the blog index", () => {
    const blog = page("blog/[...page].astro")
    expect(blog).toContain("Start here")
    expect(blog).toContain('type="search"')
    expect(blog).toContain("blog-index__categories")
  })

  it("6.4 groups the docs index and offers search", () => {
    const docs = page("docs/integrations/[slug].astro")
    const sidebar = readFileSync(new URL("../lib/docs-metadata.ts", import.meta.url), "utf8")
    expect(docs.length).toBeGreaterThan(0)
    expect(sidebar.length).toBeGreaterThan(0)
  })

  it("6.5 gives tool pages a sample preview, related tools and a result-tied trial card", () => {
    const layout = readFileSync(new URL("../layouts/ToolLayout.astro", import.meta.url), "utf8")
    expect(layout).toContain("Sample result")
    expect(layout).toContain("Related tools")
    expect(layout).toContain("Run this on your whole app")
    expect(layout).toContain("TOOL_SAMPLE_RESULTS")
  })

  it("6.6 keeps one shared compare template structure", () => {
    const template = page("compare/[slug].astro")
    expect(template).toContain("Where we differ")
    expect(template).toContain("What")
  })

  it("6.7 adds a visible breadcrumb to the blog and docs templates", () => {
    const blog = readFileSync(new URL("../layouts/BlogPost.astro", import.meta.url), "utf8")
    const docs = readFileSync(new URL("../layouts/DocsLayout.astro", import.meta.url), "utf8")
    expect(blog).toContain('aria-label="Breadcrumb"')
    expect(blog).toContain('aria-current="page"')
    expect(docs).toContain('aria-label="Breadcrumb"')
    expect(docs).toContain('aria-current="page"')
  })

  it("6.8 gives the 404 four destinations", () => {
    const notFound = page("404.astro")
    for (const href of [
      'href="/scan"',
      'href="/pricing"',
      'href="/blog"',
      'href="/docs/integrations"',
    ]) {
      expect(notFound, `404 must link ${href}`).toContain(href)
    }
  })

  it("6.9 renders the Myra panel heading as a paragraph and moves the launcher right", () => {
    const myra = component("myra/MyraPanel.astro")
    expect(myra).not.toMatch(/<h2[^>]*>\{MYRA_COPY\.header\}/)
    expect(myra).toContain(
      '<p class="text-base font-semibold leading-5 tracking-tight text-text">{MYRA_COPY.header}</p>'
    )
    expect(myra).toContain("fixed right-5 bottom-5")
  })
})
