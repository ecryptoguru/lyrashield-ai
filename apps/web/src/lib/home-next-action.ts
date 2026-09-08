import type { DashboardOverview } from "./dashboard-overview"
import type { GateReadinessTarget } from "./launch-readiness"

export interface HomeNextAction {
  /** Eyebrow label, e.g. "Get started" or "Next step". */
  eyebrow: string
  title: string
  description: string
  href: string
  cta: string
}

export const HOME_BLOCKER_HREF = "/dashboard/findings"
export const HOME_REPORT_HREF = "/dashboard/reports"

export interface HomeDecisionInput {
  targets: Pick<
    DashboardOverview["targets"],
    "total" | "assessed" | "partiallyAssessed" | "unassessed" | "expiredAssessments"
  >
  lastEvaluatedAssessment: DashboardOverview["lastEvaluatedAssessment"]
  reportCount: number
  openIssues: Pick<DashboardOverview["openIssues"], "total" | "critical" | "high">
  /** Canonical per-target gate states from an uncached applicability read. */
  gateTargets: Pick<GateReadinessTarget, "state" | "applicable">[]
  /** A queued/running scan; the decision leads with its progress. */
  activeScan?: { id: string; targetName: string | null } | null
}

export interface HomeDecision {
  action: HomeNextAction | null
  /** The same decision shaped for the header CTA — never a competing action. */
  primaryAction: { href: string; label: string }
}

/**
 * The ONE canonical home decision. The header CTA and the next-action panel
 * both render from this model, so the screen can never present two competing
 * prominent actions. During an active scan the decision leads with that scan's
 * progress rather than recommending a duplicate.
 *
 * Priority order:
 * 1. active scan      -> view its progress
 * 2. no target        -> add the first target
 * 3. no evaluated run -> run the first review
 * 4. blockers         -> review the highest-priority finding
 * 5. gate not READY   -> strengthen the weakest evidence (missing coverage,
 *                        expired assessment, revision mismatch, uncertainty)
 * 6. all READY, no report -> generate an assurance report
 * 7. journey complete -> null
 *
 * W1-03: the ready-oriented report branch requires every active target's
 * canonical gate state to be READY. Zero recorded blockers never establishes
 * release readiness, and historical reports stay available without implying a
 * current all-clear.
 */
export function deriveHomeDecision(input: HomeDecisionInput): HomeDecision {
  if (input.activeScan) {
    const action: HomeNextAction = {
      eyebrow: "In progress",
      title: "Scan in progress",
      description: input.activeScan.targetName
        ? `A scan of ${input.activeScan.targetName} is running. Findings appear as the scan reaches a reliable state.`
        : "A scan is running. Findings appear as the scan reaches a reliable state.",
      href: `/dashboard/scans/${input.activeScan.id}`,
      cta: "View scan progress",
    }
    return { action, primaryAction: { href: action.href, label: "View scan progress" } }
  }

  if (input.targets.total === 0) {
    const action: HomeNextAction = {
      eyebrow: "Get started",
      title: "Add your first target",
      description:
        "Point LyraShield at a repository, app URL, or API. Targets are where every scan starts.",
      href: "/dashboard/targets",
      cta: "Add a target",
    }
    return { action, primaryAction: { href: "/dashboard/targets", label: "Add a target" } }
  }

  if (!input.lastEvaluatedAssessment) {
    const action: HomeNextAction = {
      eyebrow: "Get started",
      title: "Run your first review",
      description:
        "Start a scan to capture your first evidence record. Deterministic checks and, where applicable, an AI-assisted review inspect the target for you.",
      href: "/dashboard/scans?new=1",
      cta: "Start a scan",
    }
    return { action, primaryAction: { href: "/dashboard/scans?new=1", label: "Start a scan" } }
  }

  const blockers = input.openIssues.critical + input.openIssues.high
  if (blockers > 0) {
    const action: HomeNextAction = {
      eyebrow: "Next step",
      title: "Review the highest-priority finding",
      description: `This workspace has ${blockers} unresolved critical or high finding${blockers === 1 ? "" : "s"} across all targets. Detection is not verification. Review the evidence, then fix and retest.`,
      href: HOME_BLOCKER_HREF,
      cta: "Open findings",
    }
    return { action, primaryAction: { href: HOME_BLOCKER_HREF, label: "Open findings" } }
  }

  // Canonical gate state governs readiness claims. A clean score or an empty
  // blocker list never overrides missing coverage, expired evidence, a revision
  // mismatch, or an unsupported target.
  const notReady = input.gateTargets.filter((target) => target.state !== "READY")
  if (notReady.length > 0) {
    const blocking = notReady.find((target) => target.state === "NOT_READY")
    if (blocking) {
      const action: HomeNextAction = {
        eyebrow: "Next step",
        title: "Resolve launch blockers",
        description:
          "The current gate state is NOT_READY. Review the blocking findings, then fix and retest before a launch decision.",
        href: HOME_BLOCKER_HREF,
        cta: "Review blockers",
      }
      return { action, primaryAction: { href: HOME_BLOCKER_HREF, label: "Review blockers" } }
    }
    const action: HomeNextAction = {
      eyebrow: "Next step",
      title: "Run a review to strengthen evidence",
      description:
        "At least one target lacks usable, current review evidence, so no launch decision is possible yet. Historical reports remain available.",
      href: "/dashboard/scans?new=1",
      cta: "Start a scan",
    }
    return { action, primaryAction: { href: "/dashboard/scans?new=1", label: "Start a scan" } }
  }

  if (input.reportCount === 0) {
    const action: HomeNextAction = {
      eyebrow: "Next step",
      title: "Generate an assurance report",
      description:
        "Every active target's current gate state is READY. Package the retained evidence into an immutable report you can share with your team.",
      href: HOME_REPORT_HREF,
      cta: "Create a report",
    }
    return { action, primaryAction: { href: HOME_REPORT_HREF, label: "Create a report" } }
  }

  return { action: null, primaryAction: { href: "/dashboard/scans?new=1", label: "Start a scan" } }
}

/**
 * Backward-compatible wrapper for callers that only need the next-action
 * panel. Production callers should use `deriveHomeDecision` so the header CTA
 * and the panel render one coherent decision.
 */
export function deriveHomeNextAction(input: HomeDecisionInput): HomeNextAction | null {
  return deriveHomeDecision(input).action
}
