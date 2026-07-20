/**
 * Provider credentials are optional per environment, but a provider must never
 * be advertised or registered with only half of its OAuth credential pair.
 */
export function isOAuthProviderConfigured(
  clientId: string | undefined,
  clientSecret: string | undefined
): boolean {
  return Boolean(clientId?.trim() && clientSecret?.trim())
}

/**
 * OAuth user creation is available in every environment. Production access is
 * still invite-only because the user database hook rejects every non-allowlisted
 * identity before Better Auth persists it.
 */
export function socialSignUpEnabled(_isProduction: boolean): boolean {
  return true
}
