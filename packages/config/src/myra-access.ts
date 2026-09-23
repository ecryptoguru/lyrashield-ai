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
 * The shared Myra dashboard admission rule. All verified accounts may use
 * the interactive support surface; API and UI enforce the same condition.
 */
export function myraDashboardAllowed(input: {
  email: string
  emailVerified: boolean
  allowlist: string
}): boolean {
  return input.emailVerified
}
