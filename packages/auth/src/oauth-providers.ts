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

/** Invite-only production uses OAuth only to sign in to existing beta accounts. */
export function socialSignUpEnabled(isProduction: boolean): boolean {
  return !isProduction
}
