export interface ScanReviewEvent {
  stage: string
  metadata?: Record<string, unknown> | null
}

export interface ScanReviewProfile {
  model: string | null
  reasoningEffort: string | null
}

function readString(metadata: Record<string, unknown> | null | undefined, key: string) {
  const value = metadata?.[key]
  return typeof value === "string" && value.length > 0 ? value : null
}

export function getScanReviewProfile(events: ScanReviewEvent[]): ScanReviewProfile {
  const engineStart = events.find((event) => event.stage === "engine_start")

  return {
    model: readString(engineStart?.metadata, "model"),
    reasoningEffort: readString(engineStart?.metadata, "reasoningEffort"),
  }
}
