import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

import {
  BUILD_DATE,
  clampToBuildDate,
  isFutureDated,
  isNotAfterBuildDate,
  isPublished,
} from "../lib/blog-publishing"

function source(relativePath: string): string {
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  return readFileSync(new URL(relativePath, import.meta.url), "utf8")
}

const buildDate = new Date("2026-09-24T12:00:00.000Z")
const futurePost = { data: { pubDate: new Date("2026-09-25T00:00:00.000Z"), draft: false } }
const todayPost = { data: { pubDate: new Date("2026-09-24T00:00:00.000Z"), draft: false } }
const pastPost = { data: { pubDate: new Date("2026-09-21T00:00:00.000Z"), draft: false } }
const draftPost = { data: { pubDate: new Date("2026-09-20T00:00:00.000Z"), draft: true } }

describe("blog publication gate", () => {
  it("holds a future-dated post back and releases it on or after its pubDate", () => {
    // The regression: draft: false was the only gate, so Batch-11 posts dated
    // 2026-09-21 to 2026-09-25 all went live on the 2026-09-24 deploy.
    expect(isNotAfterBuildDate(futurePost.data, buildDate)).toBe(false)
    expect(isFutureDated(futurePost.data, buildDate)).toBe(true)
    expect(isPublished(futurePost, buildDate)).toBe(false)

    // Same post, build one day later: pubDate is no longer after the build.
    const laterBuild = new Date("2026-09-25T09:00:00.000Z")
    expect(isNotAfterBuildDate(futurePost.data, laterBuild)).toBe(true)
    expect(isPublished(futurePost, laterBuild)).toBe(true)
  })

  it("admits posts dated today or earlier and still excludes drafts", () => {
    expect(isPublished(todayPost, buildDate)).toBe(true)
    expect(isPublished(pastPost, buildDate)).toBe(true)
    expect(isPublished(draftPost, buildDate)).toBe(false)
  })

  it("never lets a derived content date exceed the build date", () => {
    // The live llms.txt said 2026-09-25 on 2026-09-24 because a future-dated
    // post bumped "Last updated" with no upper bound.
    expect(clampToBuildDate(new Date("2026-09-25T00:00:00.000Z"), buildDate).toISOString()).toBe(
      buildDate.toISOString()
    )
    expect(clampToBuildDate(new Date("2026-09-20T00:00:00.000Z"), buildDate).toISOString()).toBe(
      "2026-09-20T00:00:00.000Z"
    )
  })

  it("uses one shared build date for the whole build", () => {
    expect(BUILD_DATE).toBeInstanceOf(Date)
    expect(Number.isNaN(BUILD_DATE.valueOf())).toBe(false)
  })
})

describe("every blog collection consumer applies the shared gate", () => {
  // Each of these reads the blog collection and must exclude future-dated
  // posts through the one shared predicate (isNotAfterBuildDate /
  // isFutureDated). A missing gate silently ships a future-dated post, so the
  // assertion pins the exact filter expression per consumer rather than a copy
  // of the date logic.
  const consumers: Array<[string, string, string]> = [
    [
      "../lib/blog-categories.ts",
      "blog category counts",
      "!entry.data.draft && isNotAfterBuildDate(entry.data)",
    ],
    [
      "../pages/blog/[...page].astro",
      "blog listing and pagination",
      "!entry.data.draft && isNotAfterBuildDate(entry.data)",
    ],
    [
      "../pages/blog/[slug].astro",
      "article static paths",
      "isNotAfterBuildDate(post.data) && (includeDrafts || !post.data.draft)",
    ],
    [
      "../pages/blog/[slug].astro",
      "related posts",
      "!entry.data.draft && isNotAfterBuildDate(entry.data)",
    ],
    [
      "../pages/blog/tags/[tag].astro",
      "category hubs",
      "!entry.data.draft && isNotAfterBuildDate(entry.data)",
    ],
    [
      "../pages/llms.txt.ts",
      "llms.txt post links",
      "!entry.data.draft && isNotAfterBuildDate(entry.data)",
    ],
    [
      "../pages/llms.txt.ts",
      "llms.txt date source",
      "!e.data.draft && isNotAfterBuildDate(e.data)",
    ],
    ["../pages/rss.xml.ts", "RSS feed", "!entry.data.draft && isNotAfterBuildDate(entry.data)"],
  ]

  it.each(consumers)("%s gates %s", (path, _label, gate) => {
    const file = source(path)

    expect(file).toContain("blog-publishing")
    expect(file).toContain(gate)
  })

  it("clamps the llms.txt content date to the build date", () => {
    const llms = source("../pages/llms.txt.ts")

    expect(llms).toContain("clampToBuildDate(latest, BUILD_DATE)")
  })

  it("indexes no future-dated post from the sitemap", () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- repository-owned config file.
    const config = readFileSync(new URL("../../astro.config.mjs", import.meta.url), "utf8")

    expect(config).toContain("isFutureDated")
    expect(config).toContain('FUTURE_DATED_BLOG_PATHS.has(pathname.replace(/\\/$/, ""))')
  })

  it("adds no scheduled workflow to release future-dated posts", () => {
    // Founder ruling: gate future-dated posts in the build, never a cron. No
    // workflow may both run on a schedule and touch the marketing deploy,
    // which is what a fallback "publish the backlog" job would look like.
    const workflowRoot = fileURLToPath(new URL("../../../../.github/workflows/", import.meta.url))
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- repository-owned workflow directory.
    const files = readdirSync(workflowRoot).filter((name) => name.endsWith(".yml"))
    const scheduledMarketingDeploys = files.filter((name) => {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- repository-owned workflow file.
      const body = readFileSync(join(workflowRoot, name), "utf8")
      return /^\s*schedule:/m.test(body) && /marketing/i.test(body)
    })

    expect(scheduledMarketingDeploys).toEqual([])
  })
})
