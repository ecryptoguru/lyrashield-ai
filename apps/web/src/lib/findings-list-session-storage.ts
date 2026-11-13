export const FINDINGS_LIST_CONTEXT_STORAGE_PREFIX = "lyrashield:findings-list:"

/** Remove list snapshots after sign-out so another account cannot restore them in this tab. */
export function clearFindingsListSessionStorage(): void {
  if (typeof window === "undefined") return

  try {
    const storage = window.sessionStorage
    for (let index = storage.length - 1; index >= 0; index -= 1) {
      const key = storage.key(index)
      if (key?.startsWith(FINDINGS_LIST_CONTEXT_STORAGE_PREFIX)) storage.removeItem(key)
    }
  } catch {
    // Session storage can be unavailable; live list data remains authoritative.
  }
}
