export type EvidenceChapterId =
  "gateway" | "target" | "scan" | "evidence-state" | "fix-proposal" | "retest" | "report"

export interface MotionVariant {
  poster: string
  mp4: string
  webm: string
}

export interface EvidenceWorldChapter {
  id: EvidenceChapterId
  eyebrow: string
  title: string
  body: string
  desktop: MotionVariant
  portrait: MotionVariant
}

export interface MotionMediaManifest {
  version: "1"
  renderHash: string
  chapters: readonly EvidenceWorldChapter[]
}

const chapterCopy: ReadonlyArray<Pick<EvidenceWorldChapter, "id" | "eyebrow" | "title" | "body">> =
  [
    {
      id: "gateway",
      eyebrow: "Release assurance for AI-built apps",
      title: "Know what was tested before you ship.",
      body: "Move from an authorized target to a reviewable assurance record without blurring detection, proof, and retest outcomes.",
    },
    {
      id: "target",
      eyebrow: "01 / Target",
      title: "Define the authorized surface.",
      body: "Name the target, scope, and permissions before any check begins. Coverage starts with an explicit boundary.",
    },
    {
      id: "scan",
      eyebrow: "02 / Scan",
      title: "Run checks that match the target.",
      body: "Deterministic scanners and AI-assisted review remain separate coverage layers, never a universal guarantee.",
    },
    {
      id: "evidence-state",
      eyebrow: "03 / Evidence State",
      title: "Keep detection separate from proof.",
      body: "Results remain detected until independent verification exists. Retest-confirmed and inconclusive outcomes stay distinct.",
    },
    {
      id: "fix-proposal",
      eyebrow: "04 / Fix Proposal",
      title: "Prepare the change. Keep execution approval-bound.",
      body: "A proposal can explain and stage a fix. PR execution remains blocked until a server-generated patch is bound to exact approval.",
    },
    {
      id: "retest",
      eyebrow: "05 / Retest",
      title: "Retest from a fresh server-owned scan.",
      body: "Complete deterministic coverage can validate a clean retest. Engine-only absence remains inconclusive.",
    },
    {
      id: "report",
      eyebrow: "06 / Assurance Report",
      title: "Ship the evidence record.",
      body: "Coverage, findings, evidence states, retest outcomes, and limitations assemble into one reviewable report.",
    },
  ]

export function createMotionMediaManifest(mediaUrl: string): MotionMediaManifest {
  const base = mediaUrl.replace(/\/$/, "")
  const root = `${base}/assurance-world/v1/local`
  const variant = (id: EvidenceChapterId, format: "desktop" | "portrait"): MotionVariant => ({
    poster: `${root}/posters/${id}-${format}.webp`,
    mp4: `${root}/${format}/${id}.mp4`,
    webm: `${root}/${format}/${id}.webm`,
  })

  return {
    version: "1",
    renderHash: "local",
    chapters: chapterCopy.map((chapter) => ({
      ...chapter,
      desktop: variant(chapter.id, "desktop"),
      portrait: variant(chapter.id, "portrait"),
    })),
  }
}
