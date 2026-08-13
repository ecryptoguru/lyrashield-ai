export type EvidenceChapterId =
  "gateway" | "target" | "scan" | "evidence-state" | "fix-proposal" | "retest" | "report"

export interface MotionTrack {
  src: string
  width: number
  height: number
  duration: 42
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
}

export interface MotionMediaManifest {
  version: "2"
  renderHash: string
  desktop: MotionTrack
  portrait: MotionTrack
  chapters: readonly EvidenceWorldChapter[]
}

const chapterCopy: ReadonlyArray<
  Pick<EvidenceWorldChapter, "id" | "start" | "end" | "eyebrow" | "title" | "body">
> = [
    {
      id: "gateway",
      start: 0,
      end: 6,
      eyebrow: 'From "it works" to "ready to ship"',
      title: "One reviewable record of what you checked, fixed, and retested before you ship.",
      body: "AI builds fast. LyraShield keeps what you checked, how you checked it, and what changed after in one reviewable record instead of scattered chats and manual checks.",
    },
    {
      id: "target",
      start: 6,
      end: 12,
      eyebrow: "01 / Target",
      title: "Choose what you are actually shipping.",
      body: "Name your repo, live URL, or API before anything runs. Nothing is tested outside the boundary you explicitly approve.",
    },
    {
      id: "scan",
      start: 12,
      end: 18,
      eyebrow: "02 / Review",
      title: "Run checks that do not blur together.",
      body: "Deterministic checks find known signals. AI-assisted review examines logic, auth flows, and data handling. Separate coverage layers show what kind of evidence you actually have.",
    },
    {
      id: "evidence-state",
      start: 18,
      end: 24,
      eyebrow: "03 / Evidence",
      title: 'Keep "we saw it" separate from "we proved it".',
      body: "Detected, independently verified, retest-confirmed, and inconclusive remain distinct. Missing proof stays visible; it never becomes a silent pass.",
    },
    {
      id: "fix-proposal",
      start: 24,
      end: 30,
      eyebrow: "04 / Fix",
      title: "Get a fix proposal you review. Nothing auto-merges.",
      body: "Review a plain-English explanation and staged patch proposal. PR execution stays blocked until a server-generated patch is bound to your exact approval.",
    },
    {
      id: "retest",
      start: 30,
      end: 36,
      eyebrow: "05 / Retest",
      title: "Confirm with a fresh check, not the same conversation.",
      body: "A fresh, server-owned scan checks the fix. Complete deterministic coverage can confirm it; engine-only absence stays inconclusive.",
    },
    {
      id: "report",
      start: 36,
      end: 42,
      eyebrow: "06 / Report",
      title: "Ship one report that shows limits too.",
      body: "Scope, coverage, findings, fixes, retest outcomes, and limits become one immutable release record. Shared versions exclude repository coordinates and raw secrets.",
    },
  ]

function assertChapterContract() {
  const ids = new Set<EvidenceChapterId>()
  let expectedStart = 0

  for (const chapter of chapterCopy) {
    if (ids.has(chapter.id)) throw new Error(`Duplicate motion chapter: ${chapter.id}`)
    if (chapter.start !== expectedStart || chapter.end <= chapter.start)
      throw new Error(`Invalid motion chapter range: ${chapter.id}`)
    ids.add(chapter.id)
    expectedStart = chapter.end
  }

  if (expectedStart !== 42) throw new Error("Motion chapters must span exactly 42 seconds")
}

assertChapterContract()

export function createMotionMediaManifest(
  mediaUrl: string,
  renderHash = "local"
): MotionMediaManifest {
  const base = mediaUrl.replace(/\/$/, "")
  const root = `${base}/assurance-world/v2/${renderHash}`

  return {
    version: "2",
    renderHash,
    desktop: {
      src: `${root}/desktop/assurance-world.mp4`,
      width: 1600,
      height: 900,
      duration: 42,
    },
    portrait: {
      src: `${root}/portrait/assurance-world.mp4`,
      width: 720,
      height: 1280,
      duration: 42,
    },
    chapters: chapterCopy.map((chapter) => ({
      ...chapter,
      desktopPoster: `${root}/posters/${chapter.id}-desktop.webp`,
      portraitPoster: `${root}/posters/${chapter.id}-portrait.webp`,
    })),
  }
}
