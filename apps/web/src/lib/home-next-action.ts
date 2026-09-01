import type { DashboardOverview } from "./dashboard-overview"

export interface HomeNextAction {
  /** Eyebrow label, e.g. "Get started" or "Next step". */
  eyebrow: string
  title: string
  description: string
  href: string
  cta: string
}

export const HOME_BLOCKER_HREF = "/dashboard/findings"
export const HOME_REPORT_HREF = "/dashboard/findings?tab=reports"

/**
 * The one contextual next action for Home.
 *
 * Replaces the previous first-run pair (five-step feature tour + four-step
 * checklist), which stacked two instruction layers on a new workspace. The
 * action is derived from workspace state, so it disappears on its own once the
 * initial journey is complete — no dismissal state to manage.
 *
 * Priority order:
 * 1. no target            -> add the first target
 * 2. no evaluated run     -> run the first review
 * 3. evaluated, blockers  -> review the highest-priority issue
 * 4. no blockers, no report -> generate an assurance report
 * 5. journey complete     -> null (no onboarding instruction)
 */
export function deriveHomeNextAction(
  overview: Pick<
    DashboardOverview,
    "targets" | "lastEvaluatedAssessment" | "remediation" | "reportCount"
  >,
  openIssues: Pick<DashboardOverview["openIssues"], "total" | "critical" | "high">
): HomeNextAction | null {
  if (overview.targets.total === 0) {
    return {
      eyebrow: "Get started",
      title: "Add your first target",
      description:
        "Point LyraShield at a repository, app URL, or API. Targets are where every Trust Run starts.",
      href: "/dashboard/targets",
      cta: "Add a target",
    }
  }

  if (!overview.lastEvaluatedAssessment) {
    return {
      eyebrow: "Get started",
      title: "Run your first review",
      description:
        "Start a Trust Run to capture your first evidence record. Deterministic checks and, where applicable, an AI-assisted review inspect the target for you.",
      href: "/dashboard/scans?new=1",
      cta: "Start a Trust Run",
    }
  }

  const blockers = openIssues.critical + openIssues.high
  if (blockers > 0) {
    return {
      eyebrow: "Next step",
      title: "Review the highest-priority issue",
      description: `This workspace has ${blockers} unresolved critical or high issue${blockers === 1 ? "" : "s"} across all targets. Detection is not verification. Review the evidence, then fix and retest.`,
      href: HOME_BLOCKER_HREF,
      cta: "Open Issues",
    }
  }

  if (overview.reportCount === 0) {
    return {
      eyebrow: "Next step",
      title: "Generate an assurance report",
      description:
        "No launch blockers are recorded. Package the retained evidence into an immutable report you can share with your team.",
      href: HOME_REPORT_HREF,
      cta: "Create a report",
    }
  }

  return null
}
