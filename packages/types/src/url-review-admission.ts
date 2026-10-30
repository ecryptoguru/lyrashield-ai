import { resolveScanProfile } from "./scan-profile"
import { resolveTargetScanMode } from "./url-scan-capabilities"

const URL_TARGET_TYPES = new Set(["WEB_APP", "API"])
export const TARGET_RELAY_UNAVAILABLE_MESSAGE =
  "Live reviews are temporarily unavailable. Choose a surface review or try again later."

export type UrlReviewMode =
  { ok: true; engineBacked: boolean } | { ok: false; code: string; reason: string }

/**
 * Whether a URL/API review tier is engine-backed — the fact that decides the
 * free-URL and domain-verification consent gates. Non-URL targets are never
 * engine-backed. Pure: mirrors the shared resolveTargetScanMode policy.
 */
export function resolveUrlReviewMode(input: {
  targetType: string
  mode: string
  hasApiSpec: boolean
}): UrlReviewMode {
  if (!URL_TARGET_TYPES.has(input.targetType)) {
    return { ok: true, engineBacked: false }
  }
  const resolved = resolveTargetScanMode({
    targetType: input.targetType,
    mode: input.mode,
    hasApiSpec: input.hasApiSpec,
  })
  if (!resolved.ok) {
    return { ok: false, code: resolved.code, reason: resolved.reason }
  }
  return {
    ok: true,
    engineBacked:
      resolved.profile !== null &&
      resolveScanProfile({ targetType: input.targetType, mode: input.mode }).usesAi,
  }
}

/** Apply the same infrastructure snapshot to every live URL admission. */
export function resolveUrlReviewAvailability(
  resolved: UrlReviewMode,
  relayAvailable: boolean
): UrlReviewMode {
  return resolved.ok && resolved.engineBacked && !relayAvailable
    ? { ok: false, code: "TARGET_RELAY_UNAVAILABLE", reason: TARGET_RELAY_UNAVAILABLE_MESSAGE }
    : resolved
}
