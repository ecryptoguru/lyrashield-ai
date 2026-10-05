import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * Every surface that renders Markdown needs a typography layer.
 *
 * The compare body was the one that lacked it, and it was fixed in this change
 * (see the wrapper assertion in compare-validation.test.ts). This file keeps the
 * inventory: it enumerates the templates that render Markdown and fails if a new
 * one appears, so a third surface cannot ship unstyled the way the compare body
 * did.
 *
 * The two shapes in play are different and both are legitimate:
 *
 *  - pages/compare/[slug].astro wraps `<Content />` directly in a div, so the
 *    wrapper is the element immediately before the render.
 *  - pages/blog/[slug].astro passes `<Content />` into BlogPost.astro's slot, so
 *    the typography lives on the slot's wrapper inside the layout.
 */

const MARKETING_SRC = join(import.meta.dirname, "..")
const COMPARE = readFileSync(new URL("../pages/compare/[slug].astro", import.meta.url), "utf8")
const BLOG_POST = readFileSync(new URL("../layouts/BlogPost.astro", import.meta.url), "utf8")

/** The opening tag of the div that wraps a `<Content />` render. */
function directWrapper(source: string): string {
  const index = source.indexOf("<Content />")
  expect(index, "<Content /> render").toBeGreaterThan(-1)
  const before = source.slice(0, index)
  const open = before.lastIndexOf("<div")
  expect(open, "a div wrapper around <Content />").toBeGreaterThan(-1)
  return before.slice(open, before.indexOf(">", open) + 1)
}

/** Every .astro file under pages/layouts that renders Markdown. */
function markdownRenderers(): string[] {
  const found: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) {
        if (name === "content") continue
        walk(full)
        continue
      }
      if (!name.endsWith(".astro")) continue
      if (readFileSync(full, "utf8").includes("<Content />")) {
        found.push(full.slice(MARKETING_SRC.length + 1))
      }
    }
  }
  for (const root of ["pages", "layouts"]) walk(join(MARKETING_SRC, root))
  return found.sort()
}

describe("Markdown render surfaces", () => {
  it("wraps the compare body in a typography layer", () => {
    const wrapper = directWrapper(COMPARE)
    expect(wrapper).toContain("prose")
    // Keeps the page container's own measure rather than prose's 65ch cap.
    expect(wrapper).toContain("max-w-none")
    expect(wrapper).toContain("prose-a:text-accent")
    expect(wrapper).toContain("prose-headings:text-text")
  })

  it("keeps the blog post's typography on the slot wrapper", () => {
    // BlogPost.astro owns the styling for the slot a post renders into.
    expect(BLOG_POST).toContain('class="blog-post__content prose')
    expect(BLOG_POST).toContain("<slot />")
  })

  it("lists every surface that renders Markdown, so a new one cannot skip the layer", () => {
    expect(markdownRenderers()).toEqual(["pages/blog/[slug].astro", "pages/compare/[slug].astro"])
  })
})
