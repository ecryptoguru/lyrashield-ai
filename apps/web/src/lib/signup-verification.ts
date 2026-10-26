import { authClient } from "@lyrashield/auth"
import { signOutAndClearSessionData } from "@/lib/sign-out"

/** Acceptance does not establish delivery or disclose whether the account exists. */
export async function resendSignupVerificationEmail(
  email: string,
  callbackURL: string,
  signOutFirst = false
): Promise<void> {
  if (signOutFirst) {
    const { error } = await signOutAndClearSessionData()
    if (error) throw error
  }
  const { error } = await authClient.sendVerificationEmail({ email, callbackURL })
  if (error) throw error
}

export function signupVerificationErrorStatus(error: unknown) {
  const code = (error as { code?: string } | null)?.code
  if (code === "EMAIL_MISMATCH") return "email-mismatch"
  if (code === "EMAIL_ALREADY_VERIFIED") return "already-verified"
  return "error"
}
