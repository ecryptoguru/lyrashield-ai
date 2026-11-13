import { TARGET_SINGULAR } from "@/lib/terminology"
import {
  isUrlTargetPath,
  pathNeedsRepo,
  urlTargetFieldError,
  type OnboardingPath,
} from "./onboarding-flow.utils"
import type { OnboardingData } from "./onboarding-wizard-model"
import type { Repo } from "./onboarding-step-views"

/**
 * The scan-start gate: everything the wizard must decide before it creates a
 * workspace or a target.
 *
 * The order is the point (P1-1). The workspace used to be created first, so an
 * invalid submit provisioned a workspace and only afterwards reported what was
 * wrong with the form. Here everything the user can see is checked first and
 * nothing is written until the checks pass. The URL/API field rules themselves
 * live in onboarding-flow.utils, next to the payload builder they mirror, and
 * the entry step's Continue reads the same helper.
 */

/** Everything the gate reads from the wizard's current render. */
export interface ScanPreflightContext {
  data: OnboardingData
  path: OnboardingPath
  selectedRepo: Repo | null
  productName: string
  urlForm: { url: string; ownershipAttested: boolean }
  // W2.3: the wizard computes whether the persisted targetId still describes
  // the visible source; the flow reuses it only when this is true.
  persistedTargetReusable: boolean
  ensureWorkspace: () => Promise<string>
}

export type ScanPreflightResult =
  | { ok: true; workspaceId: string; hasExistingTarget: boolean; needsRepo: boolean }
  | { ok: false; error: string }

/**
 * Decide whether the scan may start, and only then create the workspace.
 *
 * The order matters (P1-1): the workspace used to be created first, so an
 * invalid submit provisioned a workspace and only afterwards reported what was
 * wrong with the form. Everything the user can see is checked before anything
 * is written. A retry that reuses the persisted target skips the source checks
 * entirely — the target already exists, so there is nothing left to validate.
 */
export async function preflightScanStart(ctx: ScanPreflightContext): Promise<ScanPreflightResult> {
  const hasExistingTarget = ctx.persistedTargetReusable
  // A selected repo can only come from the repo-select step — treat it as
  // GitHub evidence even when the chooser path was lost across the OAuth
  // install redirect (OnboardingState persists the step, not the path).
  const needsRepo = pathNeedsRepo(ctx.path) || Boolean(ctx.selectedRepo)
  if (!hasExistingTarget && needsRepo && !ctx.selectedRepo) {
    return { ok: false, error: "Workspace and repository are required." }
  }
  if (!hasExistingTarget && !needsRepo) {
    if (!isUrlTargetPath(ctx.path)) {
      return { ok: false, error: "Add a valid target and confirm ownership to continue." }
    }
    const fieldError = urlTargetFieldError({
      path: ctx.path,
      name: ctx.productName,
      url: ctx.urlForm.url,
      ownershipAttested: ctx.urlForm.ownershipAttested,
    })
    if (fieldError) return { ok: false, error: fieldError }
  }
  if (!hasExistingTarget && !ctx.productName.trim()) {
    return { ok: false, error: `Name your ${TARGET_SINGULAR.toLowerCase()} to continue.` }
  }
  // The workspace is normally created when the URL/API form is submitted, but a
  // user can reach this action without that having happened — a restored
  // session, a stale persisted step or a direct start. Create it here rather
  // than dead-ending on "Workspace is required." (P1-1). The duplicate-submit
  // lock covers a double tap.
  let workspaceId = ctx.data.workspaceId
  if (!workspaceId) {
    try {
      workspaceId = await ctx.ensureWorkspace()
    } catch (cause) {
      return {
        ok: false,
        error: cause instanceof Error ? cause.message : "Could not prepare your workspace.",
      }
    }
  }
  return { ok: true, workspaceId, hasExistingTarget, needsRepo }
}
