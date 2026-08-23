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
  version: "2"
  renderHash: string
  desktop: MotionTrack
  portrait: MotionTrack
  chapters: readonly EvidenceWorldChapter[]
}

const chapterCopy: ReadonlyArray<Omit<EvidenceWorldChapter, "desktopPoster" | "portraitPoster">> = [
  {
    id: "gateway",
    start: 0,
    end: 6,
    eyebrow: 'From "it works" to "ready to ship"',
    title: "One reviewable record of what you checked, fixed, and retested before you ship.",
    body: "AI builds fast. LyraShield keeps what you checked, how you checked it, and what changed after in one reviewable record instead of scattered chats and manual checks.",
    supportingCard: {
      eyebrow: "Live in open beta",
      title: "Start with the surface you need to ship.",
      body: "Review a repository, public URL, or API. Use a passive Lite Check for a quick public-surface read, or create an account for the full evidence loop.",
      items: [
        "Repository, URL, and API targets",
        "GitHub and coding-agent workflows",
        "Approval-gated fixes and fresh retests",
      ],
    },
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
    supportingCard: {
      eyebrow: "Vibe Security 50",
      title: "Coverage stays explicit, including what needs human evidence.",
      body: "The control ledger separates 43 code or URL review controls from 7 evidence-required controls. Unmatched or unsupported checks remain inconclusive, never silently passed.",
      status: "43 review controls · 7 evidence-required",
    },
  },
  {
    id: "evidence-state",
    start: 18,
    end: 24,
    eyebrow: "03 / Evidence",
    title: 'Keep "we saw it" separate from "we proved it".',
    body: "Detected, independently verified, retest-confirmed, and inconclusive remain distinct. Missing proof stays visible; it never becomes a silent pass.",
    supportingCard: {
      eyebrow: "Illustrative evidence ledger",
      title: "Every conclusion carries its basis and its limit.",
      body: "See which check produced the signal, whether independent proof exists, and whether a fresh retest confirmed the change. Shared records omit repository coordinates and raw secrets.",
      items: [
        "Finding and evidence state",
        "Control-level coverage receipt",
        "Retest outcome and stated limitations",
      ],
    },
  },
  {
    id: "fix-proposal",
    start: 24,
    end: 30,
    eyebrow: "04 / Fix",
    title: "Get a fix proposal you review. Nothing auto-merges.",
    body: "Review a plain-English explanation and staged patch proposal. PR execution stays blocked until a server-generated patch is bound to your exact approval.",
    supportingCard: {
      eyebrow: "Where you build",
      title: "Bring the review loop into your coding agent.",
      body: "Use the hosted MCP server and supported agent integrations to inspect results and prepare approval-gated remediation without copying findings between tools.",
      items: [
        "OAuth-first agent connections",
        "GitHub-aware review context",
        "No automatic merge or silent write",
      ],
    },
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
    supportingCard: {
      eyebrow: "Your first release record",
      title: "Turn the next release into evidence your team can review.",
      body: "Create a workspace, add the target you are shipping, and choose the depth of review. LyraShield keeps the resulting scope, evidence, and retest outcome together.",
      primaryCta: {
        label: "Create account",
        href: "https://app.lyrashieldai.com/sign-up?source=landing_story&cta=report",
        id: "story-report-create-account",
      },
      secondaryCta: {
        label: "Read methodology",
        href: "/methodology",
        id: "story-report-methodology",
      },
    },
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
