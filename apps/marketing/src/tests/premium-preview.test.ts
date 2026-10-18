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
    // Nine-block order (spec section 8): hero, what is different, Lite Check,
    // journey, surfaces, coverage, pricing, FAQ, closing CTA.
    expect(homepage.indexOf("<PremiumHero cinematic />")).toBeLessThan(
      homepage.indexOf('id="different"')
    )
    expect(homepage.indexOf('id="different"')).toBeLessThan(homepage.indexOf("<HomeLiteScan"))
    expect(homepage.indexOf("<HomeLiteScan")).toBeLessThan(homepage.indexOf("<EvidenceWorld"))
    expect(homepage.indexOf("<EvidenceWorld")).toBeLessThan(
      homepage.indexOf("<HeroProductFrame />")
    )
    // The journey block carries the anchor the header links to.
    expect(homepage.indexOf('id="how-it-works"')).toBeLessThan(homepage.indexOf("<EvidenceWorld"))
    expect(homepage).toContain('renderHash === "local" ? "/media-local"')
    expect(homepage.match(/cinematic-threshold--to-dark/g)).toHaveLength(3)
    expect(homepage.match(/cinematic-threshold--to-light/g)).toHaveLength(3)
    expect(homepage).not.toContain("<AssuranceLoop")
    expect(homepage).not.toContain("<AssuranceRecord")
    expect(homepage).not.toContain("<Loop />")
  })

  it("uses the approved D1 launch-gate copy and conversion anchors", () => {
    // D1 Option 1, approved after the five-second test was skipped (2026-10-04).
    expect(hero).toContain("Open beta · Security review for AI-built apps")
    expect(hero).toContain("The launch gate for AI-built apps.")
    expect(heroCopy).toContain(
      "Point LyraShield at a repository, URL or API you are authorized to test."
    )
    expect(heroCopy).toContain(
      "It reviews what your coding agents shipped and returns one verdict: ready, not ready or insufficient evidence."
    )
    // The retired category line must not come back (D2 vocabulary lock).
    expect(hero).not.toContain("Release assurance")
    expect(hero.indexOf("landing_hero&cta=start_trial")).toBeLessThan(
      hero.indexOf('href="#free-scan"')
    )
    expect(hero).toContain("app.lyrashieldai.com/sign-up")
  })

  it("keeps the hero task-oriented and the sample verdict card honest", () => {
    // One filled primary CTA and one secondary; the label comes from the single
    // source so it can never drift from the rest of the site.
    expect(hero).toContain("CTA_LABEL.signUp")
    expect(hero).toContain("TRIAL_LINE")
    expect(hero).toContain('data-cta-id="premium-hero-primary"')
    expect(hero).toContain("premium-hero__secondary")
    expect(hero).toContain("See a sample Lite result")
    expect(hero).not.toContain("Create account")

    // The artifact is a synthetic sample labelled as one, so it must never show
    // a retest-confirmed or independently verified state.
    expect(hero).toContain("Sample verdict card")
    expect(hero).toContain("Verdict · Insufficient evidence")
    expect(hero).toContain("Server credential referenced by client build")
    expect(hero).toContain("Missing rate limit on login route")
    expect(hero).toContain("7 controls need your evidence")
    expect(hero).toContain("bounded to the checks that ran")
    // Scope the ban to the rendered artifact: the component's own CSS comment
    // explains that no verified state may appear, so a whole-file match would
    // flag the warning itself.
    const artifactMarkup = hero.slice(
      hero.indexOf('class="premium-hero__artifact"'),
      hero.indexOf("</figure>")
    )
    expect(artifactMarkup).not.toMatch(/verified|retest-confirmed/i)

    // Both sample findings read Detected and nothing else.
    const states = hero.match(/premium-hero__artifact-state">([^<]+)</g) ?? []
    expect(states).toHaveLength(2)
    for (const state of states) expect(state).toContain(">Detected<")
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

  it("keeps agent setup subordinate to existing homepage conversions", () => {
    const agentLink = hero.indexOf("premium-hero-agent-setup")
    expect(agentLink).toBeGreaterThan(hero.indexOf("premium-hero-lite-check"))
    expect(agentLink).toBeGreaterThan(hero.indexOf("premium-hero-primary"))
  })

  it("builds one immutable desktop and portrait track with seven timed chapters", () => {
    const manifest = createMotionMediaManifest("/media-local/", "test-render")
    const ids = manifest.chapters.map((chapter) => chapter.id)
    expect(manifest.version).toBe("3")
    expect(manifest.desktop).toEqual({
      src: "/media-local/assurance-world/v3/test-render/desktop/assurance-world.mp4",
      width: 1440,
      height: 810,
      duration: 56,
    })
    expect(manifest.portrait).toEqual({
      src: "/media-local/assurance-world/v3/test-render/portrait/assurance-world.mp4",
      width: 720,
      height: 1280,
      duration: 56,
    })
    expect(ids).toHaveLength(7)
    expect(manifest.chapters.filter((chapter) => chapter.supportingCard)).toHaveLength(5)
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
    expect(world).toContain("Example EX-014 remains on record")
    expect(world).toContain("Incomplete coverage · inconclusive")
    expect(world).toContain("Insufficient evidence")
    expect(world).toContain("Approval required")
    expect(world).toContain("Retest coverage incomplete")
    expect(world).not.toContain("state-verified")
    expect(world).toContain('aria-label="Evidence journey chapters"')
    expect(world).toContain('href="#product-preview"')
  })
})
