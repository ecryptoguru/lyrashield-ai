/**
 * Patch scope policy for the WP3 fix-PR pipeline.
 *
 * Founder decision (2026-09-02) — scope limits are PLAN-TIERED:
 * - Starter ($29): current-file-only, 100-line cap.
 * - All other PAID plans: finding-implicated file set, 200-line cap.
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

/** Plans with the broader implicated-set policy (paid tiers at or above Pro). */
const IMPLICATED_SET_PLANS: ReadonlySet<string> = new Set([
  "PRO",
  "TEAM",
  "LAUNCH_ASSURANCE",
  "AGENCY",
  "BUSINESS",
  "ENTERPRISE",
])

/**
 * Resolve the patch scope policy for a workspace plan.
 *
 * The plan string is the WorkspacePlan enum value. PRO and above get the
 * broader implicated-set policy. Anything else — STARTER (its own deliberate
 * tier), FREE, TRIAL, legacy/internal values, or an unrecognized string —
 * fails closed to the STRICTEST tier (current-file, 100 lines): an unknown
 * plan must never silently widen what a generated patch may touch.
 */
export function patchScopeForPlan(plan: string): PatchScopePolicy {
  if (IMPLICATED_SET_PLANS.has(plan)) {
    return { pathScope: "implicated-set", maxLinesTouched: 200 }
  }
  // STARTER, FREE, TRIAL, unknown: strictest tier.
  return { pathScope: "current-file", maxLinesTouched: 100 }
}
