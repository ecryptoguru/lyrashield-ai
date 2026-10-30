import type { ScopedTransaction } from "./rls"
import { withWorkspaceRLS } from "./rls"

export class UserScanAlreadyActiveError extends Error {
  readonly code = "SCAN_ALREADY_ACTIVE"
  constructor() {
    // No cross-workspace scan identifier is exposed by this global conflict.
    super(
      "You already have an active review. Wait for it to finish or cancel it before starting another."
    )
    this.name = "UserScanAlreadyActiveError"
  }
}

/** First lock in every admission/accounting mutation: user, workspace, sponsor. */
export async function lockUserScanAdmission(tx: ScopedTransaction, userId: string): Promise<void> {
  if (!userId) throw new Error("scan_creator_required")
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`scan-user:${userId}`}, 0))`
  await tx.$executeRaw`SELECT set_config('app.current_scan_user_id', ${userId}, true)`
}

/** Called only after the executor confirms termination, never by a status setter. */
export async function releaseStoppedScanSlot(
  workspaceId: string,
  scanId: string
): Promise<boolean> {
  return withWorkspaceRLS(workspaceId, async (tx) => {
    const scan = await tx.scan.findFirst({ where: { id: scanId, workspaceId } })
    if (!scan || scan.accountingVersion !== 2) return false
    await lockUserScanAdmission(tx, scan.createdById)
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${workspaceId}, 0))`
    const accountId = scan.sponsorAccountId ?? scan.createdById
    await tx.$executeRaw`SELECT set_config('app.current_account_id', ${accountId}, true)`
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`account:${accountId}`}, 0))`
    const reservation = await tx.scanCapacityReservation.findUnique({ where: { scanId } })
    if (
      !reservation ||
      !reservation.stoppedAt ||
      !["SETTLED", "RELEASED"].includes(reservation.state)
    )
      return false
    if (scan.accountingVersion === 2)
      await tx.scan.updateMany({
        where: { id: scanId, workspaceId },
        data: { accountingSettledAt: new Date() },
      })
    const result = await tx.userScanSlot.deleteMany({ where: { userId: scan.createdById, scanId } })
    return result.count === 1
  })
}

/** A terminal scan which never claimed provider execution is safe without a process receipt. */
export async function releaseUnstartedScanSlot(workspaceId: string, scanId: string): Promise<void> {
  await withWorkspaceRLS(workspaceId, async (tx) => {
    const scan = await tx.scan.findFirst({ where: { id: scanId, workspaceId } })
    if (!scan || scan.accountingVersion !== 2 || !["CANCELLED", "FAILED"].includes(scan.status))
      return
    await lockUserScanAdmission(tx, scan.createdById)
    const accountId = scan.sponsorAccountId ?? scan.createdById
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${workspaceId}, 0))`
    await tx.$executeRaw`SELECT set_config('app.current_account_id', ${accountId}, true)`
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`account:${accountId}`}, 0))`
    const changed = await tx.scanCapacityReservation.updateMany({
      where: { scanId, accountId, state: { in: ["WAITING", "RESERVED"] } },
      data: { state: "RELEASED", stoppedAt: new Date() },
    })
    if (!changed.count) return
    await tx.scan.updateMany({
      where: { id: scanId, workspaceId },
      data: { accountingSettledAt: new Date() },
    })
    await tx.userScanSlot.deleteMany({ where: { userId: scan.createdById, scanId } })
  })
}
