function normalizedEmails(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean)
  )
}

export function isBetaInviteAllowed(email: string, inviteEmails: string | undefined): boolean {
  return normalizedEmails(inviteEmails).has(email.trim().toLowerCase())
}

export function isBetaUserCreationAllowed(
  production: boolean,
  email: string,
  inviteEmails: string | undefined
): boolean {
  if (!production) return true
  return isBetaInviteAllowed(email, inviteEmails)
}
