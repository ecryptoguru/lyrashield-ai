import { resolveTargetScanMode } from "./url-scan-capabilities"

const URL_TARGET_TYPES = new Set(["WEB_APP", "API"])
export const TARGET_RELAY_UNAVAILABLE_MESSAGE =
  "Live reviews are temporarily unavailable. Choose a surface review or try again later."

/** URL/API Standard, Deep and Custom are removed from the launch offering. */
export const URL_PROFILE_UNSUPPORTED_MESSAGE =
  "Only Safe and Quick reviews are available for URL and API targets. Standard, Deep and Custom are not offered."

export type UrlReviewMode =
  { ok: true; engineBacked: boolean } | { ok: false; code: string; reason: string }

/**
 * Whether a URL/API review tier is admitted at the shared boundary, and whether
 * it is engine-backed (the fact that decides the free-URL and domain-proof
 * consent gates). Only the deterministic Safe/Quick tier is offered for URL/API
 * here: an explicit Standard/Deep/Custom is refused with a clear unsupported
 * code — before any queue, provider or financial work, and never silently
 * downgraded. A missing profile defaults to Quick. Non-URL targets are never
 * engine-backed. Pure.
 */
export function resolveUrlReviewMode(input: {
  targetType: string
  mode: string
  hasApiSpec: boolean
}): UrlReviewMode {
  if (!URL_TARGET_TYPES.has(input.targetType)) {
    return { ok: true, engineBacked: false }
  }

  // Refuse the removed engine tiers before the OpenAPI/release checks so an
  // explicit Standard/Deep/Custom always reports the same unsupported profile.
  const requested = input.mode.trim().toUpperCase() || "QUICK"
  const tier = requested === "QUICK" ? "SAFE" : requested === "CUSTOM" ? "DEEP" : requested
  if (tier === "STANDARD" || tier === "DEEP") {
    return { ok: false, code: "URL_MODE_UNSUPPORTED", reason: URL_PROFILE_UNSUPPORTED_MESSAGE }
  }

  const resolved = resolveTargetScanMode({
    targetType: input.targetType,
    mode: requested,
    hasApiSpec: input.hasApiSpec,
  })
  if (!resolved.ok) {
    return { ok: false, code: resolved.code, reason: resolved.reason }
  }
  return { ok: true, engineBacked: false }
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
