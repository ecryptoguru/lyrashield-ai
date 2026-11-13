/**
 * Single source of truth for marketing copy that must agree across every page.
 *
 * The trial terms and the sign-up label were previously written by hand in a
 * dozen places, so they drifted apart (Spec finding A4: the trial was stated
 * three ways; finding D1: ten sign-up labels pointed at one destination).
 * Derive them from the shared pricing catalog instead and import them here.
 */
import { CLOUD_PLAN_MAP } from "@lyrashield/pricing"

const TRIAL = CLOUD_PLAN_MAP.TRIAL

/**
 * The trial length comes from the catalog, so it cannot drift from the plan the
 * billing layer grants. The fallback exists only so a malformed catalog fails
 * loudly in the test rather than printing "undefined days" on the site.
 */
const TRIAL_DAYS = TRIAL.trialDays ?? 0

/** "7 days · 60 agent-minutes · 3 targets · no card" */
export function buildTrialLine({
  days = TRIAL_DAYS,
  agentMinutes = TRIAL.agentMinutes,
  targets = TRIAL.targetCaps,
}: { days?: number; agentMinutes?: number; targets?: number } = {}): string {
  return `${days} days · ${agentMinutes} agent-minutes · ${targets} targets · no card`
}

export const TRIAL_LINE = buildTrialLine()

/** "7-day limited trial: 60 agent-minutes, up to 3 targets, no card" */
export const TRIAL_SUMMARY = `${TRIAL_DAYS}-day limited trial: ${TRIAL.agentMinutes} agent-minutes, up to ${TRIAL.targetCaps} targets, no card`

/** The one sign-up label and the Lite Check action label. */
export const CTA_LABEL = {
  signUp: "Start free trial",
  liteCheck: "Run Lite Check",
} as const
