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
  new URL("../components/landing/evidence-world.ts", import.meta.url),
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
    expect(homepage.indexOf("<PremiumHero />")).toBeLessThan(homepage.indexOf('id="different"'))
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
    expect(hero).toContain("Run the free Lite Check")
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
    expect(manifest.version).toBe("2")
    expect(manifest.desktop).toEqual({
      src: "/media-local/assurance-world/v2/test-render/desktop/assurance-world.mp4",
      width: 1600,
      height: 900,
      duration: 42,
    })
    expect(manifest.portrait).toEqual({
      src: "/media-local/assurance-world/v2/test-render/portrait/assurance-world.mp4",
      width: 720,
      height: 1280,
      duration: 42,
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
      [0, 6],
      [6, 12],
      [12, 18],
      [18, 24],
      [24, 30],
      [30, 36],
      [36, 42],
    ])
    for (const chapter of manifest.chapters) {
      expect(chapter.desktopPoster).toMatch(/-desktop\.webp$/)
      expect(chapter.portraitPoster).toMatch(/-portrait\.webp$/)
    }
  })

  it("lazy-loads the evidence-world module as an island", () => {
    expect(world).toContain('import("./evidence-world.ts")')
    expect(world).toContain("IntersectionObserver")
    expect(world).toContain("bootstrapEvidenceWorld")
    expect(world).toContain("min-height: max(840px, 115svh)")
    expect(world).toContain("min-height: max(840px, 125svh)")
    expect(world).toContain("font-size: clamp(1.6rem, 7.4vw, 2.5rem)")
  })

  it("warms the scrubbed timeline on approach, but only when wanted", () => {
    // The story is scroll-scrubbed, so arriving with an empty buffer stutters on
    // the first pass. The element upgrades early and fetches ahead of arrival.
    expect(worldModule).toContain('this.video.preload = "auto"')
    expect(worldModule).not.toContain('this.video.preload = "metadata"')
    // Only the fetch moves early; per-frame scroll work still waits for the
    // observer, so the module must still assign the source before observing.
    expect(worldModule.indexOf("this.assignSource()")).toBeLessThan(
      worldModule.indexOf("this.observer = new IntersectionObserver")
    )

    // Warm ahead of activation, with no unconditional idle-after-load fetch.
    expect(world).toContain('rootMargin: "200% 0px"')
    expect(world).toContain("warmObserver.observe(el)")
    expect(world).not.toContain("requestIdleCallback")

    // A multi-megabyte prefetch has to stay opt-out-able.
    expect(world).toContain("if (!reduced && !saveData && !slowNetwork)")
    expect(world).toContain('connection?.effectiveType === "slow-2g"')

    // The markup itself must stay preload="none" so a no-JS or reduced-motion
    // visit fetches no video at all.
    expect(world).toContain('preload="none"')
  })

  it("keeps telemetry privacy-bounded and includes resilient media fallbacks", () => {
    expect(worldModule).toContain('"cinematic_chapter_view"')
    expect(worldModule).toContain("{ chapter_id: chapterId, mode }")
    expect(worldModule).toContain('"cinematic_media_error"')
    expect(worldModule).toContain("chapter_id: chapterId")
    expect(worldModule).toContain("asset_type: assetType")
    expect(worldModule).not.toContain("exception")
    expect(worldModule).not.toContain("userAgent")
    expect(worldModule).toContain('matchMedia("(prefers-reduced-motion: reduce)")')
    expect(worldModule).toContain("connection?.saveData")
    expect(worldModule.indexOf("if (!this.motionEnabled)")).toBeLessThan(
      worldModule.indexOf('this.classList.add("is-enhanced")')
    )
    expect(worldModule).toContain('rootMargin: "50% 0px"')
    expect(worldModule).not.toContain("URL.createObjectURL")
  })

  it("coalesces scroll seeks and keeps exactly one decoded video layer in front", () => {
    expect(world.match(/<video/g)).toHaveLength(1)
    expect(worldModule).toContain("if (video.seeking) return")
    expect(worldModule).toContain("requestVideoFrameCallback")
    expect(worldModule).toContain("setTimeout(painted, 120)")
    expect(worldModule).toContain('addEventListener("loadeddata", this.queueUpdate)')
    expect(worldModule).toContain("HTMLMediaElement.HAVE_CURRENT_DATA")
    expect(worldModule).toContain("this.showPoster()")
    expect(worldModule).toContain("this.showVideo()")
    expect(worldModule).toContain("Math.max(this.targetTime, 0)")
    expect(worldModule).not.toContain("video.currentTime + delta *")
    expect(worldModule).not.toContain("response.blob()")
    expect(worldModule).not.toContain("URL.createObjectURL")
    expect(worldModule).not.toContain("loadPair")
    expect(worldModule).toContain("if (innerWidth === this.viewportWidth)")
    expect(worldModule).toContain('chapter.classList.toggle("is-active", chapterIndex === index)')
    expect(worldModule).toContain("chapterProgress >= 0.58")
    expect(worldModule).toContain('"is-card-active"')
  })
})
