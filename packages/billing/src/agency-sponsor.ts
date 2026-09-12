import {
  bindAccountRLSContext,
  prisma,
  withAccountRLS,
  type ScopedTransaction,
} from "@lyrashield/db"
import { resolveAccountBilling } from "./account"

/** Resolve a trusted, workspace-bound Agency buyer without accepting a payer ID from the caller. */
export async function resolveWorkspaceScanSponsor(
  workspaceId: string,
  actorAccountId: string,
  tx?: ScopedTransaction
): Promise<
  | { accountId: string; agency: false; agencyActive: false }
  | { accountId: string; agency: true; agencyActive: boolean }
  | null
> {
  const db = tx ?? prisma
  const workspace = await db.workspace.findUnique({
    where: { id: workspaceId },
    select: { agencySponsorAccountId: true },
  })
  if (!workspace) return null
  const sponsorAccountId = workspace.agencySponsorAccountId
  if (!sponsorAccountId) {
    return { accountId: actorAccountId, agency: false, agencyActive: false }
  }

  const [actor, owner] = await Promise.all([
    db.workspaceMember.findFirst({
      where: { workspaceId, userId: actorAccountId, status: "active" },
      select: { id: true },
    }),
    db.workspaceMember.findFirst({
      where: { workspaceId, userId: sponsorAccountId, status: "active", role: "OWNER" },
      select: { id: true },
    }),
  ])
  if (!actor || !owner) return null

  if (tx) await bindAccountRLSContext(tx, sponsorAccountId)
  const billing = tx
    ? await resolveAccountBilling(sponsorAccountId, tx)
    : await withAccountRLS(sponsorAccountId, (accountTx) =>
        resolveAccountBilling(sponsorAccountId, accountTx)
      )
  return {
    accountId: sponsorAccountId,
    agency: true,
    agencyActive: billing?.effectivePlan === "LAUNCH_ASSURANCE",
  }
}
