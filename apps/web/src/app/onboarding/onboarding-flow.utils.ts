import { getManualScanOptions, type ManualScanOption } from "@/lib/scan-presets"

/**
 * Pure decision logic for the onboarding four-way flow.
 *
 * Step 2 ("Add your first target") offers four ways forward — Connect GitHub,
 * Add app URL, Add API endpoint, or Skip. This module owns the transitions and
 * the target-creation payload so the wizard component stays thin and every path
 * is unit-testable without rendering React.
 *
 * The P0 this fixes: the wizard previously hard-depended on GitHub connect,
 * which 500s in production when the GitHub App env vars are absent — bricking
 * every new signup behind a dashboard redirect that sends them back to
 * onboarding. URL / API / Skip must never depend on GitHub being configured.
 */

export type OnboardingPath = "github" | "url" | "api" | "skip" | null

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
 * The index the wizard jumps to after step 2 for each path. GitHub goes to
 * repo-select (step 2); URL/API go straight to product details (step 3); skip
 * leaves the wizard entirely (no onward step).
 */
export function nextStepForPath(path: Exclude<OnboardingPath, null>): number | null {
  switch (path) {
    case "github":
      return 2
    case "url":
    case "api":
      return 3
    case "skip":
      return null
  }
}

/** Step 3 (product details) needs a repo only for the GitHub path. */
export function pathNeedsRepo(path: OnboardingPath): boolean {
  return path === "github"
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
