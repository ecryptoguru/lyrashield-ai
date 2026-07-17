import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { createMotionMediaManifest } from "../lib/motion-manifest"

// eslint-disable-next-line security/detect-non-literal-fs-filename
const homepage = readFileSync(new URL("../pages/index.astro", import.meta.url), "utf8")
// eslint-disable-next-line security/detect-non-literal-fs-filename
const hero = readFileSync(
  new URL("../components/landing/PremiumHero.astro", import.meta.url),
  "utf8"
)
// eslint-disable-next-line security/detect-non-literal-fs-filename
const world = readFileSync(
  new URL("../components/landing/EvidenceWorld.astro", import.meta.url),
  "utf8"
)
// eslint-disable-next-line security/detect-non-literal-fs-filename
const astroConfig = readFileSync(new URL("../../astro.config.mjs", import.meta.url), "utf8")

describe("premium assurance-world homepage", () => {
  it("promotes the assurance world to the canonical homepage", () => {
    expect(astroConfig).not.toContain('pathname !== "/premium-preview"')
    expect(astroConfig).toContain('inlineStylesheets: "always"')
    expect(homepage).toContain("<HomeLiteScan />")
    expect(homepage).toContain("<EvidenceWorld manifest={motionManifest} />")
    expect(homepage).not.toContain("<Loop />")
  })

  it("uses approved gateway copy and conversion anchors", () => {
    expect(hero).toContain("Release assurance for AI-built apps")
    expect(hero).toContain("Know what was tested before you ship.")
    expect(hero).toContain('href="#free-scan"')
    expect(hero).toContain('href="#assurance-world"')
    expect(hero).toContain("Passive public-surface check")
  })

  it("builds all seven typed desktop and portrait media variants", () => {
    const manifest = createMotionMediaManifest("/media-local/", "test-render")
    const ids = manifest.chapters.map((chapter) => chapter.id)
    expect(manifest.version).toBe("1")
    expect(ids).toHaveLength(7)
    expect(new Set(ids).size).toBe(7)
    expect(ids).toEqual([
      "gateway",
      "target",
      "scan",
      "evidence-state",
      "fix-proposal",
      "retest",
      "report",
    ])
    for (const chapter of manifest.chapters) {
      expect(chapter.desktop.mp4).toMatch(
        /^\/media-local\/assurance-world\/v1\/test-render\/desktop\/.+\.mp4$/
      )
      expect(chapter.desktop.webm).toMatch(/\.webm$/)
      expect(chapter.portrait.poster).toMatch(/-portrait\.webp$/)
    }
  })

  it("keeps telemetry privacy-bounded and includes resilient media fallbacks", () => {
    expect(world).toContain('"cinematic_chapter_view"')
    expect(world).toContain("{ chapter_id: chapterId, mode }")
    expect(world).toContain('"cinematic_media_error"')
    expect(world).toContain("{ chapter_id: chapterId, asset_type: assetType }")
    expect(world).not.toContain("exception")
    expect(world).not.toContain("userAgent")
    expect(world).toContain('matchMedia("(prefers-reduced-motion: reduce)")')
    expect(world).toContain("connection?.saveData")
    expect(world).toContain('rootMargin: "50% 0px"')
    expect(world).toContain("URL.revokeObjectURL")
  })
})
