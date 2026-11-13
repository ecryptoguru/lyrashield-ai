/**
 * @lyrashield/fix — the WP3 fix-PR pipeline core.
 *
 * Pure, security-critical primitives for turning a verified finding into a
 * reviewable patch. The plan-tiered scope policy and the diff validator are
 * the mechanical guardrails; the approval binding (AgentApproval inputHash)
 * lives in the service layer that consumes this package.
 */

export { patchScopeForPlan, type PatchScopePolicy } from "./scope-policy"
export {
  validatePatchDiff,
  validateComposerFixArtifact,
  type DiffValidation,
  type DiffValidationOk,
  type DiffValidationRejected,
  type DiffRejectCode,
} from "./diff-validator"
export { diffChecksum } from "./checksum"
export { applyUnifiedDiff, extractFileDiff } from "./apply-diff"
export { buildUnifiedDiff } from "./build-diff"
export {
  buildComposerUpdateDiff,
  parseComposerFixArtifact,
  ComposerFixArtifactSchema,
  COMPOSER_FIX_MAX_BYTES,
  type ComposerFixArtifact,
  type ComposerFixBindings,
} from "./composer-update"
