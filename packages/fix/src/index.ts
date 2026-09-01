/**
 * @lyrashield/fix — the WP3 fix-PR pipeline core.
 *
 * Pure, security-critical primitives for turning a verified finding into a
 * reviewable patch. The plan-tiered scope policy and the diff validator are
 * the mechanical guardrails; the approval binding (AgentApproval inputHash)
 * lives in the service layer that consumes this package.
 */

export { patchScopeForPlan, type FixPlanTier, type PatchScopePolicy } from "./scope-policy"
export {
  validatePatchDiff,
  type DiffValidation,
  type DiffValidationOk,
  type DiffValidationRejected,
  type DiffRejectCode,
} from "./diff-validator"
export { diffChecksum } from "./checksum"
export { applyUnifiedDiff, extractFileDiff } from "./apply-diff"
