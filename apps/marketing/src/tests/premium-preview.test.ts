import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { createMotionMediaManifest } from "../lib/motion-manifest"

const homepage = readFileSync(new URL("../pages/index.astro", import.meta.url), "utf8")
const hero = readFileSync(
  new URL("../components/landing/PremiumHero.astro", import.meta.url),
  "utf8"
)
const world = readFileSync(
  new URL("../components/landing/EvidenceWorld.astro", import.meta.url),
  "utf8"
)
const worldModule = readFileSync(
  new URL("../components/landing/evidence-journey.ts", import.meta.url),
  "utf8"
)
const motionManifest = readFileSync(new URL("../lib/motion-manifest.ts", import.meta.url), "utf8")
const manifestIds = [...motionManifest.matchAll(/^    id: "([a-z-]+)",$/gm)].map(
  (match) => match[1]
)
const astroConfig = readFileSync(new URL("../../astro.config.mjs", import.meta.url), "utf8")

/**
 * Hero copy is wrapped across source lines, so assertions run against a
 * whitespace-collapsed copy of the component. Without this, re-wrapping the same
 * approved sentence would fail the test.
 */
const heroCopy = hero.replace(/\s+/g, " ")

describe("premium assurance-world homepage", () => {
  it("promotes the assurance world to the canonical homepage", () => {
    expect(astroConfig).not.toContain('pathname !== "/premium-preview"')
    // "auto" was measured against "always" — 88,227 B vs 199,641 B index.html —
    // and the external stylesheet is separately cacheable. Keep this pinned.
    expect(astroConfig).toContain('inlineStylesheets: "auto"')
    expect(homepage).toContain("<HomeLiteScan />")
    expect(homepage).toContain("<EvidenceWorld manifest={motionManifest} />")
    expect(homepage.indexOf("<PremiumHero cinematic />")).toBeLessThan(
      homepage.indexOf("<EvidenceWorld")
    )
    expect(homepage.indexOf("<EvidenceWorld")).toBeLessThan(
      homepage.indexOf("<HeroProductFrame />")
    )
    expect(homepage.indexOf("<HeroProductFrame />")).toBeLessThan(homepage.indexOf("<HomeLiteScan"))
    expect(homepage.indexOf('id="how-it-works"')).toBeLessThan(homepage.indexOf("<EvidenceWorld"))
    expect(homepage).toContain('renderHash === "local" ? "/media-local"')
    expect(homepage).not.toContain("<AssuranceLoop")
    expect(homepage).not.toContain("<AssuranceRecord")
    expect(homepage).not.toContain("<Loop />")
  })

  it("keeps one clear hero action, short copy and the shared trial contract", () => {
    expect(heroCopy.replace(/<br \/>/g, " ").replace(/\s+/g, " ")).toContain(
      "The launch gate for AI-built apps."
    )
    expect(heroCopy).toContain("Review your repo, website or API.")
    expect(hero).toContain("CTA_LABEL.signUp")
    expect(hero).toContain("TRIAL_LINE")
    expect(hero).toContain('data-cta-id="premium-hero-primary"')
    expect(hero).toContain('href="#how-it-works"')
    expect(hero).toContain("Explore the workflow")
    expect(hero).not.toContain("<form")
    expect(hero).not.toContain("premium-hero__artifact")
    expect(hero).not.toContain("Release assurance")
  })

  it("tells the review loop through the journey block, not a static list", () => {
    // The static three-step block retold the story the journey already tells in
    // six chapters, so it was folded into block 4 (spec section 8).
    expect(homepage).not.toContain("One review, from authorized scope to useful evidence")
    expect(homepage).toContain("<EvidenceWorld manifest={motionManifest} />")
    expect(homepage).toContain('id="how-it-works"')
    // The six chapters still carry the loop, and the fix rule is still stated.
    for (const chapter of [
      "target",
      "scan",
      "evidence-state",
      "fix-proposal",
      "retest",
      "report",
    ]) {
      expect(manifestIds).toContain(chapter)
    }
    expect(motionManifest).toContain("Nothing auto-merges")
    expect(homepage).not.toMatch(/independent verification|verified fixes/i)
  })

  it("keeps agent setup available after the product preview", () => {
    expect(homepage.indexOf('href="/agents"')).toBeGreaterThan(
      homepage.indexOf("<HeroProductFrame />")
    )
  })

  it("builds one immutable desktop and portrait track with seven timed chapters", () => {
    const manifest = createMotionMediaManifest("/media-local/", "test-render")
    const ids = manifest.chapters.map((chapter) => chapter.id)
    expect(manifest.version).toBe("3")
    expect(manifest.desktop).toMatchObject({
      src: "/media-local/assurance-world/v3/test-render/desktop/assurance-world.mp4",
      width: 1920,
      height: 1080,
      duration: 56,
    })
    expect(manifest.portrait).toMatchObject({
      src: "/media-local/assurance-world/v3/test-render/portrait/assurance-world.mp4",
      width: 720,
      height: 1280,
      duration: 56,
    })
    for (const variant of ["desktop", "portrait"] as const) {
      expect(manifest[variant].clipDuration).toBe(1)
      expect(manifest[variant].clips).toEqual(
        Array.from(
          { length: 56 },
          (_, i) =>
            `/media-local/assurance-world/v3/test-render/${variant}/clips/${String(i).padStart(2, "0")}.mp4`
        )
      )
    }
    expect(ids).toHaveLength(7)
    expect(manifest.chapters.filter((chapter) => chapter.supportingCard)).toHaveLength(0)
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
    expect(manifest.chapters.map(({ start, end }) => [start, end])).toEqual([
      [0, 8],
      [8, 16],
      [16, 24],
      [24, 32],
      [32, 40],
      [40, 48],
      [48, 56],
    ])
    for (const chapter of manifest.chapters) {
      expect(chapter.desktopPoster).toMatch(/-desktop\.webp$/)
      expect(chapter.portraitPoster).toMatch(/-portrait\.webp$/)
    }
  })

  it("ships the evidence journey without a video download or motion dependency", () => {
    expect(world).not.toContain("<video")
    expect(world).toContain('import "./evidence-journey"')
    expect(worldModule).toContain("IntersectionObserver")
    expect(worldModule).toContain("document.hidden")
    expect(worldModule).toContain('matchMedia("(prefers-reduced-motion: reduce)")')
    expect(worldModule).toContain("saveData")
    expect(worldModule).toContain("disconnectedCallback")
  })

  it("keeps the same illustrative finding and its limitations through the report", () => {
    expect(world).toContain("Finding EX-014")
    expect(world).toContain("Illustrative example · EX-014")
    expect(world).toContain("Incomplete coverage · inconclusive")
    expect(world).toContain("Insufficient evidence")
    expect(world).toContain("Proposal awaiting review")
    expect(world).toContain("Retest coverage incomplete")
    expect(world).not.toContain("state-verified")
    expect(world).toContain('aria-label="Evidence journey chapters"')
    expect(world).toContain('href="#product-preview"')
  })
})
