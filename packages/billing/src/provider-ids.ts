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
