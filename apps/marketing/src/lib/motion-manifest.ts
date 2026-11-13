import {
  MOTION_VERSION,
  MOTION_DURATION,
  MOTION_CHAPTER_DURATION,
  MOTION_VARIANTS,
  MOTION_FPS,
} from "../../../marketing-motion/scripts/motion-media-contract.mjs"

export type EvidenceChapterId =
  "gateway" | "target" | "scan" | "evidence-state" | "fix-proposal" | "retest" | "report"

export interface MotionTrack {
  src: string
  width: number
  height: number
  duration: number
}

export interface EvidenceWorldChapter {
  id: EvidenceChapterId
  start: number
  end: number
  eyebrow: string
  title: string
  body: string
  desktopPoster: string
  portraitPoster: string
  supportingCard?: EvidenceWorldSupportingCard
}

export interface EvidenceWorldSupportingCard {
  eyebrow: string
  title: string
  body: string
  items?: readonly string[]
  status?: string
  primaryCta?: { label: string; href: string; id: string }
  secondaryCta?: { label: string; href: string; id: string }
}

export interface MotionMediaManifest {
  version: string
  fps: number
  renderHash: string
  desktop: MotionTrack
  portrait: MotionTrack
  chapters: readonly EvidenceWorldChapter[]
}

/**
 * Descriptive alt text for each chapter's poster frames. The posters are
 * abstract 3D artwork, not product UI, so the descriptions say what the
 * frame actually shows and which story chapter it belongs to. Keyed by
 * chapter id so a poster can never drift from its chapter copy.
 */
export const CHAPTER_POSTER_ALT: Readonly<Record<EvidenceChapterId, string>> = {
  gateway:
    "Architectural navy workspace with a cyan-edged aperture and a retained evidence record.",
  target: "Evidence record inside a bounded scope plane along a continuous workspace.",
  scan: "Parallel cyan review routes meet below the same retained evidence record.",
  "evidence-state":
    "Evidence record framed by finding planes; an amber limitation remains visible.",
  "fix-proposal":
    "A separate translucent proposal layer beside the evidence record and approval boundary.",
  retest: "Two comparison planes with an amber gap representing incomplete evidence.",
  report: "The retained record approaches a report stack with its amber limitation intact.",
}

const chapterCopy: ReadonlyArray<Omit<EvidenceWorldChapter, "desktopPoster" | "portraitPoster">> = [
  {
    id: "gateway",
    start: 0 * MOTION_CHAPTER_DURATION,
    end: 1 * MOTION_CHAPTER_DURATION,
    eyebrow: "From target to report.",
    title: "From target to report.",
    body: "Keep your review, proposed fixes and retest results together.",
  },
  {
    id: "target",
    start: 1 * MOTION_CHAPTER_DURATION,
    end: 2 * MOTION_CHAPTER_DURATION,
    eyebrow: "Set the scope.",
    title: "Set the scope.",
    body: "Choose a repository, website or API you are authorized to test.",
  },
  {
    id: "scan",
    start: 2 * MOTION_CHAPTER_DURATION,
    end: 3 * MOTION_CHAPTER_DURATION,
    eyebrow: "See the findings.",
    title: "See the findings.",
    body: "Coverage shows which checks ran and where assessment was limited.",
  },
  {
    id: "evidence-state",
    start: 3 * MOTION_CHAPTER_DURATION,
    end: 4 * MOTION_CHAPTER_DURATION,
    eyebrow: "See what is supported.",
    title: "See what is supported.",
    body: "Detected, retest-confirmed and inconclusive results stay distinct.",
  },
  {
    id: "fix-proposal",
    start: 4 * MOTION_CHAPTER_DURATION,
    end: 5 * MOTION_CHAPTER_DURATION,
    eyebrow: "Review the proposed fix.",
    title: "Review the proposed fix.",
    body: "You approve the proposal. Nothing auto-merges.",
  },
  {
    id: "retest",
    start: 5 * MOTION_CHAPTER_DURATION,
    end: 6 * MOTION_CHAPTER_DURATION,
    eyebrow: "Check the change again.",
    title: "Check the change again.",
    body: "Complete deterministic coverage can confirm a fix; missing proof stays inconclusive.",
  },
  {
    id: "report",
    start: 6 * MOTION_CHAPTER_DURATION,
    end: 7 * MOTION_CHAPTER_DURATION,
    eyebrow: "Share the result.",
    title: "Share the result.",
    body: "Bring scope, findings, retest outcomes and limitations into one report.",
  },
]

export function createMotionMediaManifest(
  mediaUrl: string,
  renderHash = "local"
): MotionMediaManifest {
  const base = mediaUrl.replace(/\/$/, "")
  const root = `${base}/assurance-world/v${MOTION_VERSION}/${renderHash}`

  return {
    version: MOTION_VERSION,
    fps: MOTION_FPS,
    renderHash,
    desktop: {
      src: `${root}/desktop/assurance-world.mp4`,
      width: MOTION_VARIANTS.desktop.width,
      height: MOTION_VARIANTS.desktop.height,
      duration: MOTION_DURATION,
    },
    portrait: {
      src: `${root}/portrait/assurance-world.mp4`,
      width: 720,
      height: 1280,
      duration: MOTION_DURATION,
    },
    chapters: chapterCopy.map((chapter) => ({
      ...chapter,
      desktopPoster: `${root}/posters/${chapter.id}-desktop.webp`,
      portraitPoster: `${root}/posters/${chapter.id}-portrait.webp`,
    })),
  }
}
