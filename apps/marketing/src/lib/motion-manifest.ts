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
      eyebrow: 'From "it works" to "ready to ship"',
      title: "One reviewable record of what you checked, fixed, and retested before you ship.",
      body: "AI builds fast. Shipping safely means you know what you checked, how you checked it, and what changed after. LyraShield keeps all of that in one place, instead of scattered across chat logs and manual checks.",
    },
    {
      id: "target",
      eyebrow: "01 / Target",
      title: "Choose what you are actually shipping.",
      body: "Name your repo, live URL, or API and set the boundary before anything runs. Nothing gets tested you did not explicitly approve, so scope starts honest.",
    },
    {
      id: "scan",
      eyebrow: "02 / Review",
      title: "Run checks that do not blur together.",
      body: "Fast deterministic scanners catch the known stuff: secrets in code, misconfigurations, dependency signals. AI-assisted review looks at logic, auth flows, and data handling. We keep them as separate coverage layers, never a single safe score, so you know what kind of evidence you have.",
    },
    {
      id: "evidence-state",
      eyebrow: "03 / Evidence",
      title: 'Keep "we saw it" separate from "we proved it".',
      body: "Results stay in four honest states: detected when a pattern is seen, independently verified when a separate check confirms it, retest-confirmed when a fresh scan shows it fixed, and inconclusive when we could not fully check it. Missing proof stays visible; it does not become a silent pass.",
    },
    {
      id: "fix-proposal",
      eyebrow: "04 / Fix",
      title: "Get a fix proposal you review. Nothing auto-merges.",
      body: "For each finding you can get a plain-English explanation plus a staged patch proposal. PR execution is blocked until a server-generated patch is bound to your exact approval on your terminal. Fail-closed if no terminal, and no background fixes.",
    },
    {
      id: "retest",
      eyebrow: "05 / Retest",
      title: "Confirm with a fresh check, not the same conversation.",
      body: "When you mark something fixed, we re-run from a clean, server-owned scan. A clean result can confirm a fix when deterministic coverage is complete; engine-only absence stays inconclusive, and we tell you.",
    },
    {
      id: "report",
      eyebrow: "06 / Report",
      title: "Ship one report that shows limits too.",
      body: "Scope, coverage, findings, evidence states, fixes, retest outcomes, and what we could not check, assembled into one immutable release record you can share internally or with clients. No repo coordinates or raw secrets in the shared version.",
    },
  ]

export function createMotionMediaManifest(
  mediaUrl: string,
  renderHash = "local"
): MotionMediaManifest {
  const base = mediaUrl.replace(/\/$/, "")
  const root = `${base}/assurance-world/v1/${renderHash}`
  const variant = (id: EvidenceChapterId, format: "desktop" | "portrait"): MotionVariant => ({
    poster: `${root}/posters/${id}-${format}.webp`,
    mp4: `${root}/${format}/${id}.mp4`,
    webm: `${root}/${format}/${id}.webm`,
  })

  return {
    version: "1",
    renderHash,
    chapters: chapterCopy.map((chapter) => ({
      ...chapter,
      desktop: variant(chapter.id, "desktop"),
      portrait: variant(chapter.id, "portrait"),
    })),
  }
}
