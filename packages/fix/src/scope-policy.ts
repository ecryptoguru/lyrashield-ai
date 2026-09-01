/**
 * Patch scope policy for the WP3 fix-PR pipeline.
 *
 * Founder decision (2026-09-02) — scope limits are PLAN-TIERED:
 * - Starter ($29): current-file-only, 100-line cap.
 * - All other plans: finding-implicated file set, 200-line cap.
 *
 * These limits are enforced mechanically by the diff validator, never by the
 * generating model's goodwill. A patch that exceeds its plan's scope is
 * rejected before it is ever shown to a human as viable.
 */

export type FixPlanTier = "STARTER" | "STANDARD"

export interface PatchScopePolicy {
  /**
   * "current-file" — the diff may touch only the single file the finding is
   * anchored to. "implicated-set" — the diff may touch any file in the
   * finding's implicated file set.
   */
  pathScope: "current-file" | "implicated-set"
  /** Hard ceiling on total lines added + removed across the whole diff. */
  maxLinesTouched: number
}

/**
 * Resolve the patch scope policy for a workspace plan.
 *
 * The plan string is the WorkspacePlan enum value. STARTER is the $29 tier;
 * everything else (PRO, LAUNCH_ASSURANCE, ENTERPRISE, and internal/legacy
 * values) gets the broader implicated-set policy. Unknown plans fail closed to
 * the strictest tier.
 */
export function patchScopeForPlan(plan: string): PatchScopePolicy {
  if (plan === "STARTER") {
    return { pathScope: "current-file", maxLinesTouched: 100 }
  }
  return { pathScope: "implicated-set", maxLinesTouched: 200 }
}
