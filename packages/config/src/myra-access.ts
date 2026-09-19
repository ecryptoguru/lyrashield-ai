import { z } from "zod"

const emailSchema = z.string().email()

export function normalizeMyraAllowedEmails(value: string): string {
  if (!value.trim()) return ""
  const emails = value.split(",").map((email) => email.trim().toLowerCase())
  if (
    emails.some((email) => !emailSchema.safeParse(email).success) ||
    new Set(emails).size !== emails.length
  ) {
    throw new Error("MYRA_ALLOWED_EMAILS must contain unique, valid email addresses")
  }
  return emails.join(",")
}

export function isMyraAllowedEmail(email: string, allowlist: string): boolean {
  return allowlist.split(",").includes(email.trim().toLowerCase())
}

/**
 * The single Myra dashboard admission rule: a verified email that is on the
 * account allowlist. Used by the dashboard layout (UI mount) and by
 * myraPrincipalEnabled (API gate) so both enforce identical semantics — an
 * unverified or unlisted account sees no Myra surface anywhere.
 */
export function myraDashboardAllowed(input: {
  email: string
  emailVerified: boolean
  allowlist: string
}): boolean {
  return input.emailVerified && isMyraAllowedEmail(input.email, input.allowlist)
}
