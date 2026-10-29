export const MOTION_VERSION = "3"
export const MOTION_DURATION = 56
export const MOTION_FPS = 30
export const MOTION_GOP = 15
export const MOTION_CHAPTERS = [
  "gateway",
  "target",
  "scan",
  "evidence-state",
  "fix-proposal",
  "retest",
  "report",
]
export const MOTION_CHAPTER_DURATION = MOTION_DURATION / MOTION_CHAPTERS.length

export const MOTION_VARIANTS = {
  desktop: {
    gop: 15,
    crf: 38,
    width: 800,
    height: 450,
    scale: "800:450",
    budgetBytes: 3 * 1024 * 1024,
    master: "assurance-world-desktop-web.mp4",
    masterWidth: 1920,
    masterHeight: 1080,
  },
  portrait: {
    gop: 15,
    crf: 38,
    width: 450,
    height: 800,
    scale: "450:800",
    budgetBytes: 3 * 1024 * 1024,
    master: "assurance-world-portrait-web.mp4",
    masterWidth: 1080,
    masterHeight: 1920,
  },
}

export function motionTrackRelativePath(variant) {
  if (!Object.hasOwn(MOTION_VARIANTS, variant))
    throw new Error(`Unknown motion variant: ${variant}`)
  return `${variant}/assurance-world.mp4`
}

export function motionPosterRelativePath(chapter, variant, format = "webp") {
  if (!MOTION_CHAPTERS.includes(chapter)) throw new Error(`Unknown motion chapter: ${chapter}`)
  if (!Object.hasOwn(MOTION_VARIANTS, variant))
    throw new Error(`Unknown motion variant: ${variant}`)
  return `posters/${chapter}-${variant}.${format}`
}

export function motionPublishRoot(renderHash) {
  if (!/^[a-f0-9]{16}$/.test(renderHash))
    throw new Error("Render hash must be 16 lowercase hex characters")
  return `assurance-world/v${MOTION_VERSION}/${renderHash}`
}
