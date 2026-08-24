import { createAuthClient } from "better-auth/client"
import {
  deviceAuthorizationClient,
  inferAdditionalFields,
  twoFactorClient,
} from "better-auth/client/plugins"
import type { auth } from "./auth"

export const authClient = createAuthClient({
  plugins: [
    inferAdditionalFields<typeof auth>(),
    twoFactorClient({ twoFactorPage: "/two-factor" }),
    deviceAuthorizationClient(),
  ],
})

export function safeAuthCallbackPath(value: string | null | undefined): string {
  if (!value || /[\\\u0000-\u001f\u007f]/.test(value)) return "/dashboard"
  let decoded: string
  try {
    decoded = decodeURIComponent(value)
  } catch {
    return "/dashboard"
  }
  if (
    /[\\\u0000-\u001f\u007f]/.test(decoded) ||
    !decoded.startsWith("/") ||
    decoded.startsWith("//")
  )
    return "/dashboard"
  try {
    const base = new URL("https://auth.lyrashield.invalid")
    const resolved = new URL(value, base)
    return resolved.origin === base.origin &&
      value.startsWith("/") &&
      !value.startsWith("//") &&
      resolved.pathname.startsWith("/") &&
      !resolved.pathname.startsWith("//")
      ? `${resolved.pathname}${resolved.search}${resolved.hash}`
      : "/dashboard"
  } catch {
    return "/dashboard"
  }
}

export const {
  signIn,
  signOut,
  signUp,
  useSession,
  sendVerificationEmail: clientSendVerificationEmail,
} = authClient

export const getClientSession = authClient.getSession

export type AuthClient = typeof authClient

/**
 * better-fetch wraps API errors in a BetterFetchError whose `error` property
 * holds the response body (`{ code, message }`). These helpers extract the
 * user-facing details and error code for safer client-side error handling.
 */
export type AuthClientError = Error & {
  error?: { code?: string; message?: string }
}

export function getAuthErrorMessage(error: unknown): string | null {
  if (!error) return null
  if (typeof error === "string") return error
  const err = error as AuthClientError
  return err.error?.message ?? err.message ?? null
}

export function getAuthErrorCode(error: unknown): string | null {
  if (!error) return null
  const err = error as AuthClientError
  return err.error?.code ?? null
}

export function isEmailNotVerifiedError(error: unknown): boolean {
  const code = getAuthErrorCode(error)
  const message = getAuthErrorMessage(error)
  return code === "EMAIL_NOT_VERIFIED" || message === "Email not verified"
}
