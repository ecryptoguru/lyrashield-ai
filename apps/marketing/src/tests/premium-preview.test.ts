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
const worldModule = readFileSync(
  new URL("../components/landing/evidence-world.ts", import.meta.url),
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
    expect(homepage.indexOf("<EvidenceWorld")).toBeLessThan(homepage.indexOf("<HomeLiteScan"))
    expect(homepage).toContain('renderHash === "local" ? "/media-local"')
    expect(homepage.match(/cinematic-threshold--to-dark/g)).toHaveLength(3)
    expect(homepage.match(/cinematic-threshold--to-light/g)).toHaveLength(3)
    expect(homepage).not.toContain("<AssuranceLoop")
    expect(homepage).not.toContain("<AssuranceRecord")
    expect(homepage).not.toContain("<Loop />")
  })

  it("uses approved gateway copy and conversion anchors", () => {
    expect(hero).toContain("Release assurance for AI-built apps")
    expect(hero).toContain("Ship AI-built apps with evidence, not hope.")
    expect(hero.indexOf("landing_hero&cta=create_account")).toBeLessThan(
      hero.indexOf('href="#free-scan"')
    )
    expect(hero).toContain("app.lyrashieldai.com/sign-up")
    expect(hero).toContain("Missing evidence stays visible")
  })

  it("keeps agent setup subordinate to existing homepage conversions", () => {
    const agentLink = hero.indexOf("premium-hero-agent-setup")
    expect(agentLink).toBeGreaterThan(hero.indexOf("premium-hero-lite-check"))
    expect(agentLink).toBeGreaterThan(hero.indexOf("premium-hero-create-account"))
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

  it("warms the scrubbed timeline in parallel with the page, but only when wanted", () => {
    // The story is scroll-scrubbed, so arriving with an empty buffer stutters on
    // the first pass. The element upgrades early and fetches ahead of arrival.
    expect(worldModule).toContain('this.video.preload = "auto"')
    expect(worldModule).not.toContain('this.video.preload = "metadata"')
    // Only the fetch moves early; per-frame scroll work still waits for the
    // observer, so the module must still assign the source before observing.
    expect(worldModule.indexOf("this.assignSource()")).toBeLessThan(
      worldModule.indexOf("this.observer = new IntersectionObserver")
    )

    // Scheduled off the critical path so it never competes with the hero.
    expect(world).toContain("requestIdleCallback")
    expect(world).toContain('document.readyState === "complete"')
    expect(world).toContain('addEventListener("load", schedule, { once: true })')

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
