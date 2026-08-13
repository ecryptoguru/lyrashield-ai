export const MOTION_VERSION = "2"
export const MOTION_DURATION = 42
export const MOTION_FPS = 30
export const MOTION_GOP = 6
export const MOTION_CHAPTERS = [
  "gateway",
  "target",
  "scan",
  "evidence-state",
  "fix-proposal",
  "retest",
  "report",
]

export const MOTION_VARIANTS = {
  desktop: {
    width: 1600,
    height: 900,
    scale: "1600:900",
    budgetBytes: 8 * 1024 * 1024,
    master: "assurance-world-desktop-web.mp4",
  },
  portrait: {
    width: 720,
    height: 1280,
    scale: "720:1280",
    budgetBytes: 5 * 1024 * 1024,
    master: "assurance-world-portrait-web.mp4",
  },
}

export function motionTrackRelativePath(variant) {
  if (!Object.hasOwn(MOTION_VARIANTS, variant)) throw new Error(`Unknown motion variant: ${variant}`)
  return `${variant}/assurance-world.mp4`
}

export function motionPosterRelativePath(chapter, variant, format = "webp") {
  if (!MOTION_CHAPTERS.includes(chapter)) throw new Error(`Unknown motion chapter: ${chapter}`)
  if (!Object.hasOwn(MOTION_VARIANTS, variant)) throw new Error(`Unknown motion variant: ${variant}`)
  return `posters/${chapter}-${variant}.${format}`
}

export function motionPublishRoot(renderHash) {
  if (!/^[a-f0-9]{16}$/.test(renderHash)) throw new Error("Render hash must be 16 lowercase hex characters")
  return `assurance-world/v${MOTION_VERSION}/${renderHash}`
}
