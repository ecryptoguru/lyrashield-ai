import { authClient } from "@lyrashield/auth"
import { invalidateAnalyticsPreference } from "@/lib/analytics"
import { clearFindingsListSessionStorage } from "@/lib/findings-list-session-storage"

/** Drop account-scoped browser caches only after the server confirms sign-out. */
export async function signOutAndClearSessionData() {
  const result = await authClient.signOut()
  if (!result.error) {
    invalidateAnalyticsPreference()
    clearFindingsListSessionStorage()
  }
  return result
}
