import type { ScanTransaction } from "./scan-service-types"

export class ScanBillableClaimError extends Error {
  constructor(message = "Scan already has a billable execution claim", options?: ErrorOptions) {
    super(message, options)
    this.name = "ScanBillableClaimError"
  }
}

/** Prisma P2034 proves this transaction rolled back rather than losing its ACK.
 * A later retry still needs the locked lifetime-claim check; this is no authority
 * to clear an existing claim or bypass competing ownership.
 */
export function isConfirmedScanClaimRollback(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2034"
}

/** Serialize paid admission, preflight, retry, and capacity reset on the same scan.
 * Read the event in a separate statement AFTER the lock, so a waiter sees the
 * winner's committed marker under PostgreSQL READ COMMITTED. Include historical
 * events regardless of archival state: this is a lifetime spending boundary.
 */
export async function readLockedBillableScan(
  tx: ScanTransaction,
  workspaceId: string,
  scanId: string
) {
  await tx.$executeRaw`SELECT id FROM "Scan" WHERE id = ${scanId} AND "workspaceId" = ${workspaceId} FOR UPDATE`
  return tx.scan.findFirst({
    where: { id: scanId, workspaceId },
    select: {
      status: true,
      events: { where: { stage: "billable_boundary" }, select: { id: true }, take: 1 },
    },
  })
}

export async function requireUnclaimedScan(
  tx: ScanTransaction,
  workspaceId: string,
  scanId: string
) {
  const scan = await readLockedBillableScan(tx, workspaceId, scanId)
  if (!scan) throw new Error("Scan not found in workspace")
  if (scan.events.length) throw new ScanBillableClaimError()
  return scan
}

/** Called inside the same transaction as any funded RUNNING reservation. */
export async function insertScanBillableClaim(
  tx: ScanTransaction,
  workspaceId: string,
  scanId: string
) {
  const scan = await requireUnclaimedScan(tx, workspaceId, scanId)
  if (scan.status !== "RUNNING")
    throw new ScanBillableClaimError("Scan left RUNNING before billable admission")
  return tx.scanEvent.create({
    data: {
      scanId,
      stage: "billable_boundary",
      level: "info",
      message: "Automatic retries disabled before provider-billable analysis",
      metadata: { retryPolicy: "fresh_scan_required" },
    },
  })
}
