/** Resolve a provider-assigned catalog ID from a JSON environment map. */
export function resolveProviderId(raw: string | undefined, key: string): string | null {
  if (!raw) return null

  try {
    const value = (JSON.parse(raw) as Record<string, unknown>)[key]
    return typeof value === "string" && value.trim() ? value.trim() : null
  } catch {
    return null
  }
}

/** Resolve the internal catalog key for a provider-owned product or plan ID. */
export function resolveProviderKey(raw: string | undefined, providerId: string): string | null {
  if (!raw || !providerId) return null

  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null

    for (const [key, value] of Object.entries(parsed)) {
      if (value === providerId) return key
    }
  } catch {
    return null
  }

  return null
}
