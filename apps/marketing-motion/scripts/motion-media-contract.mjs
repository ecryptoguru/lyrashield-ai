export const MOTION_VERSION = "3"
export const MOTION_DURATION = 56
export const MOTION_FPS = 30
export const MOTION_GOP = 8
export const MOTION_CLIP_DURATION = 1
export const MOTION_CLIP_COUNT = MOTION_DURATION / MOTION_CLIP_DURATION
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
    gop: 8,
    crf: 20,
    width: 1920,
    height: 1080,
    scale: "1920:1080",
    budgetBytes: 48 * 1024 * 1024,
    master: "assurance-world-desktop-web.mp4",
    masterWidth: 1920,
    masterHeight: 1080,
  },
  portrait: {
    gop: 4,
    crf: 23,
    width: 720,
    height: 1280,
    scale: "720:1280",
    budgetBytes: 24 * 1024 * 1024,
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

export function motionClipRelativePath(variant, index) {
  if (!Object.hasOwn(MOTION_VARIANTS, variant))
    throw new Error(`Unknown motion variant: ${variant}`)
  if (!Number.isInteger(index) || index < 0 || index >= MOTION_CLIP_COUNT)
    throw new Error(`Unknown motion clip: ${index}`)
  return `${variant}/clips/${String(index).padStart(2, "0")}.mp4`
}
