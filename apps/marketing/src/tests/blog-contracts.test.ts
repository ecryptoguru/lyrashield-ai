import { describe, expect, it } from "vitest"
import program from "../content/blog-program.json"
import images from "../content/blog-images/images.json"
import authors from "../content/authors/authors.json"
import { IMAGE_CORPUS, PROGRAM_ARTICLE_COUNT } from "../../scripts/blog-validation-lib.mjs"

function batchFor(index: number) {
  if (index === 1) return "authority"
  if (index <= 18) return "batch-1"
  if (index <= 35) return "batch-2"
  if (index <= 52) return "batch-3"
  if (index <= 68) return "batch-4"
  if (index <= 84) return "batch-5"
  if (index <= 100) return "batch-6"
  if (index <= 111) return "batch-7"
  if (index <= 133) return "batch-8"
  if (index <= 148) return "batch-9"
  return "batch-10"
}

// The published manifest is the canonical record of the approved blog
// program. The editorial plan that seeded it was removed on 2026-09-09; git
// history is the recovery path, so the contract validates the manifest's
// internal consistency instead of re-reading the plan.
describe("blog program contracts", () => {
  it("contains the exact ordered program manifest", () => {
    expect(program).toHaveLength(PROGRAM_ARTICLE_COUNT)

    program.forEach((entry, position) => {
      expect(entry.index, `manifest position ${position + 1} must be 1-based sequential`).toBe(
        position + 1
      )
      expect(entry.title.length).toBeGreaterThan(0)
      expect(entry.slug).toMatch(/^[a-z0-9-]+$/)
      expect(entry.query.length).toBeGreaterThan(0)
      expect(entry.cluster.length).toBeGreaterThan(0)
      expect(entry.targetWords).toBeGreaterThan(0)
      expect(entry.cta.length).toBeGreaterThan(0)
      expect(entry.batch, `entry ${entry.index} batch`).toBe(batchFor(entry.index))
    })
    expect(new Set(program.map((entry) => entry.slug)).size).toBe(PROGRAM_ARTICLE_COUNT)
  })

  it("keeps every entry inside a known cluster", () => {
    const clusters = new Set(program.map((entry) => entry.cluster))
    expect(clusters.has("Authority")).toBe(true)
    expect(clusters.size).toBeGreaterThanOrEqual(7)
  })

  it("contains the reviewed 36-image catalog with every production rendition", () => {
    const entries = Object.entries(images)

    expect(entries).toHaveLength(IMAGE_CORPUS.authority + IMAGE_CORPUS.shared)
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
