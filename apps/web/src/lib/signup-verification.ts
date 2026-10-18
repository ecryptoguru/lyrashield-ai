import { authClient } from "@lyrashield/auth"

/** Better Auth returns HTTP errors; only a confirmed send may show success. */
export async function resendSignupVerificationEmail(
  email: string,
  callbackURL: string
): Promise<void> {
  const { error } = await authClient.sendVerificationEmail({ email, callbackURL })
  if (error) throw error
}
