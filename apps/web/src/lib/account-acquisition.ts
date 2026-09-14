import { withAccountRLS } from "@lyrashield/db"
import type { SignupAttribution } from "./analytics"

/**
 * Claim first-touch acquisition context for an account.
 *
 * The bounded attribution snapshot travels from /sign-up through OAuth as the
 * `lyrashield-acq` cookie and is claimed here — server-side, inside the
 * account RLS context — on the first onboarding visit. `ON CONFLICT DO
 * NOTHING` makes it idempotent and preserves the first touch forever: a later
 * visit with different params never rewrites the primary source.
 *
 * Returns the claimed snapshot (for the onboarding target-type hint), or null
 * when there was nothing to claim / a claim already existed.
 */
export async function claimAccountAcquisition(
  accountId: string,
  attribution: SignupAttribution | null
): Promise<{ targetTypeHint: string | null } | null> {
  if (!attribution) return null
  const hasAny = Object.values(attribution).some((v) => typeof v === "string" && v.length > 0)
  if (!hasAny) return null

  await withAccountRLS(accountId, (tx) =>
    tx.accountAcquisition.createMany({
      data: [{ accountId, ...attribution }],
      skipDuplicates: true,
    })
  )

  // Return the persisted row's hint (first-touch wins — read back so a
  // conflicting second visit does not inherit this request's hint).
  const existing = await withAccountRLS(accountId, (tx) =>
    tx.accountAcquisition.findUnique({
      where: { accountId },
      select: { targetTypeHint: true },
    })
  )
  return existing ? { targetTypeHint: existing.targetTypeHint } : null
}
