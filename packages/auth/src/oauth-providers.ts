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

export function socialSignUpEnabled(_isProduction: boolean): boolean {
  return true
}
