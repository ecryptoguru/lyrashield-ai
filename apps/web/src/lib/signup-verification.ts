import { authClient } from "@lyrashield/auth"

/** Acceptance does not establish delivery or disclose whether the account exists. */
export async function resendSignupVerificationEmail(
  email: string,
  callbackURL: string,
  signOutFirst = false
): Promise<void> {
  if (signOutFirst) {
    const { error } = await authClient.signOut()
    if (error) throw error
  }
  const { error } = await authClient.sendVerificationEmail({ email, callbackURL })
  if (error) throw error
}
