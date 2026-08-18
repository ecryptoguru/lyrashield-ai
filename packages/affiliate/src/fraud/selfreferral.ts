/**
 * Self-referral detection — reject affiliate.userId == referred userId.
 *
 * C-L06: Also compares by email to catch cases where a user creates a
 * second account with a different userId but the same email address.
 */

/**
 * Check if a referral is a self-referral.
 * The affiliate's own user id must not match the referred user's id.
 * C-L06: Also checks email equality if both emails are provided.
 */
export function isSelfReferral(
  affiliateUserId: string,
  referredUserId: string,
  affiliateEmail?: string,
  referredEmail?: string
): boolean {
  if (affiliateUserId === referredUserId) return true
  // C-L06: Email-based self-referral check
  if (affiliateEmail && referredEmail) {
    const normalize = (email: string) => email.trim().toLowerCase()
    if (normalize(affiliateEmail) === normalize(referredEmail)) return true
  }
  return false
}
