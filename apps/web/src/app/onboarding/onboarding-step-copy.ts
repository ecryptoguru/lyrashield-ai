import { SCAN_SINGULAR, TARGET_SINGULAR } from "@/lib/terminology"
import { pathLabel, pathNeedsRepo, type OnboardingPath } from "./onboarding-flow.utils"

export function detailsCopy(
  path: OnboardingPath,
  productName: string,
  retryingExistingTarget: boolean,
  hasFailedScanAttempt: boolean
): string {
  if (retryingExistingTarget && hasFailedScanAttempt) {
    return `Retry the review for ${productName || `this ${TARGET_SINGULAR.toLowerCase()}`}. The target stays locked so the retry cannot create or scan a different target.`
  }
  if (retryingExistingTarget) {
    return `Reviewing your existing ${pathLabel(path)}. Go back to update the source if needed.`
  }
  if (pathNeedsRepo(path)) {
    return `Name your ${TARGET_SINGULAR.toLowerCase()}. You can classify its environment later in target settings.`
  }
  return `Reviewing your ${pathLabel(path)}. Confirm the details and choose what you need from this ${SCAN_SINGULAR.toLowerCase()}.`
}
