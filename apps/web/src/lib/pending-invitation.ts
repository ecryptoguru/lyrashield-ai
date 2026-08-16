"use client"

/**
 * Carries a team invitation token from the invite link (`?invite=<token>` on
 * sign-up/sign-in) across the auth flow to the post-auth page, where
 * InvitationAcceptBridge redeems it. sessionStorage (not localStorage) so the
 * token dies with the tab instead of lingering in storage.
 */

const STORAGE_KEY = "lyrashield:pending-invite"

export function readPendingInvitation(): string | null {
  try {
    return window.sessionStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

export function storePendingInvitation(token: string): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, token)
  } catch {
    // Storage unavailable (private mode etc.) — the bridge will simply find
    // nothing to redeem and the user can reopen the invite link signed in.
  }
}

export function clearPendingInvitation(): void {
  try {
    window.sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    // Nothing to do.
  }
}
