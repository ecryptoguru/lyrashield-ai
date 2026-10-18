export const MOTION_VERSION: string
export const MOTION_DURATION: number
export const MOTION_FPS: number
export const MOTION_GOP: number
export const MOTION_CHAPTER_DURATION: number
export const MOTION_CHAPTERS: readonly [
  "gateway",
  "target",
  "scan",
  "evidence-state",
  "fix-proposal",
  "retest",
  "report",
]
export const MOTION_VARIANTS: Record<
  "desktop" | "portrait",
  {
    width: number
    height: number
    scale: string
    gop: number
    crf: number
    budgetBytes: number
    master: string
    masterWidth: number
    masterHeight: number
  }
>
export function motionPublishRoot(hash: string): string
export function motionPosterRelativePath(chapter: string, variant: string, format?: string): string
export function motionTrackRelativePath(variant: string): string
