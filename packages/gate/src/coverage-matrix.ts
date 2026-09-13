/**
 * Scanner-coverage matrix for the Launch Gate.
 *
 * Founder-approved (2026-09-02): scanner classes are DERIVED from the scan
 * coverage registry rather than hand-maintained, so the standard cannot drift
 * from the scanners that actually run. The worker's coverage builder
 * (`apps/worker/src/engine/result-integrity.ts` → buildCoverageReceipts) emits
 * receipts for a fixed set of scanner families per target type; this module
 * encodes that same family set as the gate's required-scanner matrix.
 *
 * If the worker adds a scanner family, add it here AND bump the standard
 * version — a change to coverage expectations is a version change, never a
 * silent behaviour change.
 */

export type GateTargetType = "REPO" | "WEB_APP" | "API" | "CLOUD_ACCOUNT" | "CONTAINER" | "IAC"

/** Scanner families the worker emits coverage receipts for. */
export const SCANNER_FAMILIES = [
  "engine",
  "sca",
  "secrets",
  "agent_config",
  "ml_supply_chain",
  "ai_app_security",
  "sast",
  "iac",
  "url",
] as const

export type ScannerFamily = (typeof SCANNER_FAMILIES)[number]

/**
 * Required scanner classes per target type for lyrashield-gate/2.3.0.
 * A target counts as evaluated only when each required family reports
 * COMPLETED or NOT_APPLICABLE on the latest completed scan.
 *
 * - REPO: full static stack + the agentic engine.
 * - WEB_APP / API: URL/config + agent-surface families (no source checkout),
 *   plus `engine` when the scan ran an engine-backed tier (STANDARD/DEEP).
 *   SAFE-tier URL scans stay deterministic-only — the engine is honestly
 *   absent and the gate does not pretend otherwise.
 * - CLOUD_ACCOUNT / CONTAINER / IAC: deferred — the gate returns
 *   INSUFFICIENT_EVIDENCE ("target type not yet covered by the gate standard").
 */
const REQUIRED_BY_TARGET: Record<GateTargetType, readonly ScannerFamily[]> = {
  REPO: [
      "engine",
      "sca",
      "secrets",
      "agent_config",
      "ml_supply_chain",
      "ai_app_security",
      "sast",
      "iac",
    ],
  WEB_APP: ["url", "ai_app_security"],
  API: ["url", "ai_app_security"],
  CLOUD_ACCOUNT: [],
  CONTAINER: [],
  IAC: [],
}

/** Modes whose URL profile is engine-backed (see packages/types scan-profile). */
const ENGINE_BACKED_URL_MODES = new Set(["STANDARD", "DEEP"])

/**
 * Required scanner classes for a target type — mode-conditional where the
 * scan's own tier changes what coverage it could produce. Returns an empty
 * array for target types the standard does not yet cover — the caller must
 * treat empty as "not covered" (INSUFFICIENT_EVIDENCE), not "nothing required".
 */
export function requiredScannersForTarget(
  targetType: string,
  mode?: string | null
): readonly string[] {
  const key = targetType as GateTargetType
  const base = REQUIRED_BY_TARGET[key] ?? []
  if ((key === "WEB_APP" || key === "API") && mode && ENGINE_BACKED_URL_MODES.has(mode)) {
    return ["engine", ...base]
  }
  return base
}

/** True when the gate standard covers this target type at all. */
export function isTargetTypeCovered(targetType: string): boolean {
  const key = targetType as GateTargetType
  return key in REQUIRED_BY_TARGET && REQUIRED_BY_TARGET[key].length > 0
}
