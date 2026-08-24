import { safeAuthCallbackPath } from "@lyrashield/auth"

const PENDING_AUTH_CALLBACK_KEY = "lyrashield.auth.callback"

export function setPendingAuthCallback(value: string): void {
  window.sessionStorage.setItem(PENDING_AUTH_CALLBACK_KEY, safeAuthCallbackPath(value))
}

export function consumePendingAuthCallback(fallback?: string | null): string {
  const stored = window.sessionStorage.getItem(PENDING_AUTH_CALLBACK_KEY)
  window.sessionStorage.removeItem(PENDING_AUTH_CALLBACK_KEY)
  return safeAuthCallbackPath(stored ?? fallback)
}
