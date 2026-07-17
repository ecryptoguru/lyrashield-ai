import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import program from "../content/blog-program.json"
import images from "../content/blog-images/images.json"
import authors from "../content/authors/authors.json"

type BlogProgramEntry = {
  index: number
  title: string
  slug: string
  query: string
  cluster: string
  targetWords: number
  batch: string
  cta: string
}

const BLOG_MAP_HEADING = "## 5. The 100-blog map"
const TOOLS_HEADING = "## 6. `/tools` product-led SEO surface"

function batchFor(index: number) {
  if (index === 1) return "authority"
  if (index <= 18) return "batch-1"
  if (index <= 35) return "batch-2"
  if (index <= 52) return "batch-3"
  if (index <= 68) return "batch-4"
  if (index <= 84) return "batch-5"
  return "batch-6"
}

function readApprovedBlogProgram(): BlogProgramEntry[] {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The URL is a fixed repository-owned editorial plan fixture.
  const plan = readFileSync(
    new URL(
      "../../../../docs/plans/2026-07-14-vibe-coder-security-seo-tools-plan.md",
      import.meta.url
    ),
    "utf8"
  )
  const sectionStart = plan.indexOf(BLOG_MAP_HEADING)
  const sectionEnd = plan.indexOf(TOOLS_HEADING, sectionStart)

  if (sectionStart === -1 || sectionEnd === -1) {
    throw new Error("Could not find the authoritative 100-blog map in the editorial plan")
  }

  return plan
    .slice(sectionStart, sectionEnd)
    .split("\n")
    .filter((line) => /^\|\s*\d+\s*\|/.test(line))
    .map((line, rowIndex) => {
      const cells = line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim())

      if (cells.length !== 6) {
        throw new Error(`Blog map row ${rowIndex + 1} has ${cells.length} columns instead of 6`)
      }

      const [indexValue, titleAndSlug, query, cluster, targetWordsValue, cta] = cells
      const index = Number(indexValue)
      const titleAndSlugMatch = /^(.*) \/ `([^`]+)`$/.exec(titleAndSlug)

      if (!Number.isInteger(index) || !titleAndSlugMatch) {
        throw new Error(`Could not parse authoritative blog map row ${rowIndex + 1}: ${line}`)
      }

      return {
        index,
        title: titleAndSlugMatch[1],
        slug: titleAndSlugMatch[2],
        query,
        cluster,
        targetWords: Number(targetWordsValue.replaceAll(",", "")),
        batch: batchFor(index),
        cta,
      }
    })
}

describe("blog program contracts", () => {
  it("contains the exact ordered 100-topic program", () => {
    const approvedProgram = readApprovedBlogProgram()

    expect(approvedProgram).toHaveLength(100)
    expect(program).toHaveLength(approvedProgram.length)
    approvedProgram.forEach((approvedEntry, position) => {
      expect(
        program[position],
        `Manifest position ${position + 1} must exactly match approved topic ${approvedEntry.index} (${approvedEntry.slug})`
      ).toEqual(approvedEntry)
    })
    expect(new Set(program.map((entry) => entry.slug)).size).toBe(100)
  })

  it("contains the reviewed 36-image catalog with every production rendition", () => {
    const entries = Object.entries(images)

    expect(entries).toHaveLength(36)
    expect(new Set(entries.map(([, image]) => image.cluster))).toEqual(
      new Set([
        "authority",
        "access-control",
        "web-execution",
        "supply-chain",
        "agent-security",
        "verification",
        "decision-operations",
      ])
    )
    for (const [id, image] of entries) {
      expect(image).toMatchObject({
        avif: `/images/blog/library/${id}/hero.avif`,
        webp: `/images/blog/library/${id}/hero.webp`,
        jpeg: `/images/blog/library/${id}/hero.jpg`,
        og: `/images/blog/library/${id}/og.jpg`,
        socialPortrait: `/images/blog/library/${id}/social-portrait.jpg`,
        width: 1600,
        height: 900,
      })
      expect(image.alt.length).toBeGreaterThanOrEqual(20)
    }
  })

  it("declares LyraShield Team as an organization", () => {
    expect(authors["lyrashield-team"].kind).toBe("Organization")
  })
})
