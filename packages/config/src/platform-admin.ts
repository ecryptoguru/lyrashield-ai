export const APPROVED_PLATFORM_ADMIN_EMAILS = [
  "ecryptoguru@gmail.com",
  "ankit@lyrashieldai.com",
] as const

const APPROVED_EMAIL_SET = new Set<string>(APPROVED_PLATFORM_ADMIN_EMAILS)
const INVALID_ADMIN_EMAILS =
  "PLATFORM_ADMIN_EMAILS must contain exactly the approved platform administrators"

export function normalizePlatformAdminEmails(value: string): string {
  const emails = value.split(",").map((email) => email.trim().toLowerCase())
  const unique = new Set(emails)

  if (
    emails.some((email) => !email) ||
    unique.size !== APPROVED_EMAIL_SET.size ||
    unique.size !== emails.length ||
    [...unique].some((email) => !APPROVED_EMAIL_SET.has(email))
  ) {
    throw new Error(INVALID_ADMIN_EMAILS)
  }

  return APPROVED_PLATFORM_ADMIN_EMAILS.join(",")
}
