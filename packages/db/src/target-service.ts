import { createId } from "@paralleldrive/cuid2"
import { computeAuditHash } from "./audit-hash"
import type { AuditLog } from "./generated/prisma"
import { withWorkspaceRLS, type ScopedTransaction } from "./rls"
import { ACTIVE_SCAN_STATUSES, lockWorkspaceScanAdmission } from "./scan-service"

/**
 * Target lifecycle service.
 *
 * Targets are soft-deleted (`deletedAt`): scans, findings, verdicts, reports,
 * scorecard shares and Evidence Vault rows stay in the workspace untouched;
 * the extended Prisma client filters deleted targets out of every read, and
 * the deleted row frees its target-cap slot (`assertTargetAllowed` counts
 * `deletedAt: null` only).
 */

export class TargetHasActiveScanError extends Error {
  readonly code = "TARGET_HAS_ACTIVE_SCAN"
  constructor(message = "Target has an active scan") {
    super(message)
    this.name = "TargetHasActiveScanError"
  }
}

export class TargetNotFoundError extends Error {
  readonly code = "TARGET_NOT_FOUND"
  constructor(message = "Target not found in this workspace") {
    super(message)
    this.name = "TargetNotFoundError"
  }
}

/**
 * Append a chained `target.deleted` audit row inside the mutation
 * transaction. The extended client's `auditLog.create` cannot nest inside a
 * Prisma transaction, and a post-commit audit write could report failure
 * after the delete already committed — the audit receipt must be atomic with
 * the delete. This mirrors the in-transaction append in account-deletion.
 */
async function appendTargetDeletedAudit(
  tx: ScopedTransaction,
  workspaceId: string,
  actorUserId: string,
  target: { id: string; name: string; url: string | null; repoFullName: string | null }
): Promise<void> {
  // Serialize with concurrent audit creation for this workspace — the same
  // advisory-lock key the audit extension uses, so this append cannot
  // interleave with a post-commit create. The locked chain order must match
  // (createdAt, id) sorting exactly.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${workspaceId}, 0))`
  const entries = await tx.$queryRaw<Pick<AuditLog, "hash" | "createdAt">[]>`
    SELECT "hash", "createdAt" FROM "AuditLog"
    WHERE "workspaceId" = ${workspaceId}
    ORDER BY "createdAt" DESC, id DESC
    LIMIT 1`
  const last = entries[0]
  const prevHash = last?.hash ?? null
  const requestedCreatedAt = new Date()
  const createdAt =
    last && requestedCreatedAt <= last.createdAt
      ? new Date(last.createdAt.getTime() + 1)
      : requestedCreatedAt
  const auditId = createId()
  const metadata = { name: target.name, url: target.url, repoFullName: target.repoFullName }
  const hash = computeAuditHash(
    {
      id: auditId,
      workspaceId,
      actorUserId,
      action: "target.deleted",
      resourceType: "target",
      resourceId: target.id,
      ipAddress: null,
      userAgent: null,
      metadata,
      createdAt,
    },
    prevHash
  )
  await tx.$executeRaw`
    INSERT INTO "AuditLog" (
      id, "workspaceId", "actorUserId", action, "resourceType", "resourceId",
      "ipAddress", "userAgent", metadata, "prevHash", hash, "createdAt"
    ) VALUES (
      ${auditId}, ${workspaceId}, ${actorUserId}, 'target.deleted', 'target', ${target.id},
      NULL, NULL, ${JSON.stringify(metadata)}::jsonb, ${prevHash}, ${hash}, ${createdAt}
    )`
}

/**
 * Soft-delete a target after locking it and refusing while a scan is queued
 * or running. Disables the target's schedules. Retains every scan, finding,
 * verdict, report, share and evidence row.
 *
 * @throws {TargetNotFoundError} when the target is missing, foreign or already deleted
 * @throws {TargetHasActiveScanError} when a scan for the target is queued or running
 */
export async function softDeleteTarget(
  workspaceId: string,
  targetId: string,
  actorUserId: string
): Promise<{ id: string }> {
  return withWorkspaceRLS(workspaceId, async (tx) => {
    // Same admission lock order as createScan (workspace admission, then the
    // target's hashtext lock) so delete can never race a scan create.
    await lockWorkspaceScanAdmission(tx, workspaceId)
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${targetId}))`

    const rows = await tx.$queryRaw<Array<{ deletedAt: Date | null }>>`
      SELECT "deletedAt" FROM "Target"
      WHERE id = ${targetId} AND "workspaceId" = ${workspaceId}
      FOR UPDATE`
    if (rows.length === 0 || rows[0]!.deletedAt !== null) {
      throw new TargetNotFoundError()
    }

    const activeScans = await tx.scan.count({
      where: {
        workspaceId,
        targetId,
        status: { in: ACTIVE_SCAN_STATUSES },
        deletedAt: null,
      },
    })
    if (activeScans > 0) {
      throw new TargetHasActiveScanError()
    }

    const target = await tx.target.update({
      where: { id: targetId },
      data: { deletedAt: new Date() },
      select: { id: true, name: true, url: true, repoFullName: true },
    })

    await tx.schedule.updateMany({
      where: { targetId, workspaceId, deletedAt: null, enabled: true },
      data: { enabled: false },
    })

    await appendTargetDeletedAudit(tx, workspaceId, actorUserId, target)
    return { id: target.id }
  })
}
