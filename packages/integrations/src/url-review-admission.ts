import {
  resolveUrlReviewMode,
  resolveUrlReviewAvailability,
  type UrlReviewMode,
} from "@lyrashield/types"
import { isTargetRelayWorkerAvailable } from "./queue"

export {
  resolveUrlReviewMode,
  TARGET_RELAY_UNAVAILABLE_MESSAGE,
  type UrlReviewMode,
} from "@lyrashield/types"

export async function getTargetRelayAvailability(targetType: string): Promise<boolean> {
  return (
    (targetType !== "WEB_APP" && targetType !== "API") || (await isTargetRelayWorkerAvailable())
  )
}

/** The same read-only infrastructure gate for worker and API admission. */
export async function resolveAvailableUrlReview(
  input: Parameters<typeof resolveUrlReviewMode>[0],
  relayAvailable?: boolean
): Promise<UrlReviewMode> {
  const resolved = resolveUrlReviewMode(input)
  if (!resolved.ok || !resolved.engineBacked) return resolved
  return resolveUrlReviewAvailability(
    resolved,
    relayAvailable ?? (await getTargetRelayAvailability(input.targetType))
  )
}
