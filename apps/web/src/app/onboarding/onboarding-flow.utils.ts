import { getManualScanOptions, type ManualScanOption } from "@/lib/scan-presets"
import { TARGET_SINGULAR } from "@/lib/terminology"

/**
 * Pure decision logic for the onboarding four-way flow.
 *
 * Step 1 ("Add your first target") offers four ways forward — Connect GitHub,
 * Add app URL, Add API endpoint, or Skip. This module owns the transitions,
 * the step model, and the target-creation payload so the wizard component
 * stays thin and every path is unit-testable without rendering React.
 *
 * The P0 this fixes: the wizard previously hard-depended on GitHub connect,
 * which 500s in production when the GitHub App env vars are absent — bricking
 * every new signup behind a dashboard redirect that sends them back to
 * onboarding. URL / API / Skip must never depend on GitHub being configured.
 */

export type OnboardingPath = "github" | "url" | "api" | "skip" | null

export function onboardingPathForTargetType(targetType: string | null): OnboardingPath {
  if (targetType === "REPO") return "github"
  if (targetType === "WEB_APP") return "url"
  if (targetType === "API") return "api"
  return null
}

export async function ensureOnboardingTargetId(
  existingTargetId: string | null,
  createTarget: () => Promise<string>
): Promise<string> {
  return existingTargetId ?? createTarget()
}

export function getOnboardingReviewOptions(path: OnboardingPath): ManualScanOption[] {
  const type = path === "github" ? "REPO" : path === "url" ? "WEB_APP" : path === "api" ? "API" : ""
  return getManualScanOptions({ type, hasApiSpec: false }).filter((option) => option.available)
}

export interface UrlTargetPayload {
  workspaceId: string
  type: "WEB_APP" | "API"
  name: string
  url: string
  environment: string
  ownershipAttested: boolean
}

/**
 * Where the wizard lands after the chooser for each path. GitHub goes to
 * repo-select; URL/API go straight to target details; skip leaves the wizard
 * entirely (no onward step).
 *
 * This is the ONLY place a step index is written. The rendered progress list
 * is derived from the same `stepModelForPath` definition below, so the wizard's
 * "Step N of M" indicator cannot disagree with the steps it shows (v16 3.1:
 * URL/API previously jumped to a step the two-item progress list did not have).
 */
export function nextStepForPath(path: Exclude<OnboardingPath, null>): number | null {
  switch (path) {
    case "github":
      return GITHUB_STEPS.repoSelect.index
    case "url":
    case "api":
      return URL_API_STEPS.details.index
    case "skip":
      return null
  }
}

/** Step 3 (target details) needs a repo only for the GitHub path. */
export function pathNeedsRepo(path: OnboardingPath): boolean {
  return path === "github"
}

// ---------------------------------------------------------------------------
// Single source of truth for the wizard's step model (v16 3.1).
//
// Every step the wizard can render is declared once, keyed by the flow that
// shows it (github vs url/api — the skip path leaves the wizard, so it has no
// steps), with its wizard index and its label. `nextStepForPath` and the
// wizard's progress list both read from these objects, so the highlighted
// progress item, the "Step N of M" eyebrow/live region, and the section
// headings can never drift apart again.
// ---------------------------------------------------------------------------

export interface OnboardingStepDef {
  /** Index used for `step` state, persistence (currentStep) and lookups. */
  readonly index: number
  /** Label in the progress list and the step eyebrow. */
  readonly label: string
}

/** Shared first step: the four-way chooser (Connect GitHub / URL / API / Skip). */
const CHOOSER: OnboardingStepDef = { index: 1, label: "Add target" }
/** Shared final step where the name and review are confirmed. */
const DETAILS: OnboardingStepDef = { index: 3, label: `${TARGET_SINGULAR} details` }

/** Steps for the GitHub flow: chooser → repo-select → details. */
export const GITHUB_STEPS = {
  chooser: CHOOSER,
  repoSelect: { index: 2, label: "Select repository" },
  details: DETAILS,
} as const

/** Steps for the URL / API flows: chooser → details (no repo-select). */
export const URL_API_STEPS = {
  chooser: CHOOSER,
  details: DETAILS,
} as const

/**
 * The ordered steps a given flow renders — the one list the wizard draws its
 * progress bar from. `path === null` (user still on the chooser, or restored
 * with an unknown target type) renders the longer GitHub list: step 2 is then
 * only reachable through the GitHub connect redirect, and falling back to the
 * two-item list would repeat the original off-by-one ("Step 3 of 2").
 */
export function stepModelForPath(path: OnboardingPath): readonly OnboardingStepDef[] {
  if (path === "url" || path === "api") return [URL_API_STEPS.chooser, URL_API_STEPS.details]
  return [GITHUB_STEPS.chooser, GITHUB_STEPS.repoSelect, GITHUB_STEPS.details]
}

/**
 * Which rendered progress item (0-based) is current for wizard `step` in the
 * given flow. Derived from the same step definitions as `stepModelForPath`, so
 * the live region's "Step N of M" always names a step the list shows.
 */
export function displayStepForPath(step: number, path: OnboardingPath): number {
  const model = stepModelForPath(path)
  const match = model.find((entry) => entry.index === step)
  // A step the model does not know (stale persisted value) still needs a sane
  // announcement: clamp into range rather than point past the last item.
  return match ? model.indexOf(match) : Math.min(Math.max(step, 1), model.length) - 1
}

/**
 * Build the POST /api/targets body for the URL / API paths. Returns null when
 * the input is not yet submittable — the caller keeps the button disabled in
 * that state, so this never produces an invalid request. `ownershipAttested`
 * is load-bearing: the API (CreateUrlTargetSchema) rejects anything but true,
 * and a security product must not scan a target the user hasn't attested to.
 */
export function buildUrlTargetPayload(input: {
  workspaceId: string | null
  path: OnboardingPath
  name: string
  url: string
  environment: string
  ownershipAttested: boolean
}): UrlTargetPayload | null {
  if (!input.workspaceId) return null
  if (input.path !== "url" && input.path !== "api") return null
  const name = input.name.trim()
  const url = input.url.trim()
  if (!name || !url) return null
  if (!input.ownershipAttested) return null
  return {
    workspaceId: input.workspaceId,
    type: input.path === "api" ? "API" : "WEB_APP",
    name,
    url,
    environment: input.environment,
    ownershipAttested: true,
  }
}

/** Human label for the chosen path, used in the step-3 heading and hints. */
export function pathLabel(path: OnboardingPath): string {
  switch (path) {
    case "github":
      return "GitHub repository"
    case "url":
      return "web app"
    case "api":
      return "API"
    case "skip":
      return "later"
    default:
      return "target"
  }
}

/**
 * Prefill a target name from its source (W2-02): the hostname for URL/API
 * targets, so the user confirms rather than invents a name. Returns null when
 * no sensible name can be derived; the caller keeps the current value then.
 */
export function targetNameFromUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl)
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null
    const host = parsed.hostname.replace(/^www\./, "")
    return host || null
  } catch {
    return null
  }
}
