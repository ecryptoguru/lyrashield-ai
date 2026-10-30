import type { Scan } from "./generated/prisma"
import type { ScopedTransaction } from "./rls"

export interface ScanCapacityProjection {
  state: string
  executionStopped: boolean
  admissionHeld: boolean
  multiplier: number
  fundedMinutes: number
  runtimeLimitMs: number
  observedMs: number
  chargedMinutes: number
  absorbedMinutes: number
}

export async function createScanCapacity(
  tx: ScopedTransaction,
  scan: Scan,
  engineBacked: boolean
): Promise<void> {
  await tx.userScanSlot.create({
    data: { userId: scan.createdById, scanId: scan.id, workspaceId: scan.workspaceId },
  })
  const accountId = scan.sponsorAccountId ?? scan.createdById
  await tx.$executeRaw`SELECT set_config('app.current_account_id', ${accountId}, true)`
  await tx.scanCapacityReservation.create({
    data: {
      scanId: scan.id,
      accountId,
      state: engineBacked ? "WAITING" : "RESERVED",
      workspaceId: scan.workspaceId,
      userId: scan.createdById,
      multiplier: scan.mode === "DEEP" || scan.mode === "CUSTOM" ? 3 : 1,
    },
  })
}

export async function readScanCapacity(
  tx: ScopedTransaction,
  scan: Scan
): Promise<ScanCapacityProjection | null> {
  let capacity: ScanCapacityProjection | null = null
  if (scan.accountingVersion === 2) {
    const accountId = scan.sponsorAccountId ?? scan.createdById
    await tx.$executeRaw`SELECT set_config('app.current_account_id', ${accountId}, true)`
    const reservation = await tx.scanCapacityReservation.findFirst({
      where: { scanId: scan.id, workspaceId: scan.workspaceId, accountId },
      select: {
        state: true,
        multiplier: true,
        fundedMinutes: true,
        runtimeLimitMs: true,
        observedMs: true,
        chargedMinutes: true,
        absorbedMinutes: true,
        stoppedAt: true,
      },
    })
    if (reservation) {
      const { stoppedAt, ...usage } = reservation
      capacity = {
        ...usage,
        executionStopped: Boolean(stoppedAt),
        admissionHeld: !scan.accountingSettledAt,
      }
    }
  }
  return capacity
}
