/**
 * Self-referral detection — reject affiliate.userId == referred userId.
 */

/**
 * Check if a referral is a self-referral.
 * The affiliate's own user id must not match the referred user's id.
 */
export function isSelfReferral(
  affiliateUserId: string,
  referredUserId: string
): boolean {
  return affiliateUserId === referredUserId
}
