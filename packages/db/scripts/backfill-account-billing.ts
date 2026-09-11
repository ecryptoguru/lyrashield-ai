/**
 * Backfill `accountId` onto BillingAccount / UsageRecord / MinutePack rows
 * written before account-owned billing shipped (launch-review remediation
 * WP-A, stage 2 of the expand–contract rollout).
 *
 * Ownership mapping: existing account-bound billing rows or an explicit,
 * reviewed BillingAccount-id to account-id mapping. Workspace roles are never
 * ownership evidence. Historical workspace-pool debits follow that pool's owner,
 * not the initiating user (who may have consumed someone else's legacy pool).
 * Pass --mapping=/absolute/path/approved-mapping.json with an object of
 * { "billingAccountId": "verifiedUserId" }; retain its approval/evidence separately.
 *
 * Rows that cannot be mapped deterministically are listed in the report and
 * left untouched — never guessed. The script is idempotent (`accountId IS
 * NULL` predicates) so it can be re-run during the transition window to catch
 * rows written by a rolled-back old image.
 *
 * Usage:
 *   DATABASE_SYSTEM_URL=… tsx packages/db/scripts/backfill-account-billing.ts            # dry-run report
 *   DATABASE_SYSTEM_URL=… tsx packages/db/scripts/backfill-account-billing.ts --apply=backfill-account-billing
 */

import { readFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"

export const BACKFILL_CONFIRMATION = "backfill-account-billing"

export interface BackfillReport {
  billingAccounts: { mapped: number; unmapped: Array<{ id: string; workspaceId: string | null }> }
  usageRecords: { mapped: number; unmapped: number }
  minutePacks: { mapped: number; unmapped: number }
  applied: boolean
}

type DbTx = {
  billingAccount: {
    findMany(
      args: unknown
    ): Promise<Array<{ id: string; workspaceId: string | null; accountId: string | null }>>
    updateMany(args: unknown): Promise<{ count: number }>
  }
  user: { findUnique(args: unknown): Promise<{ id: string; emailVerified: boolean } | null> }
  usageRecord: {
    findMany(args: unknown): Promise<
      Array<{
        id: string
        workspaceId: string | null
        accountId: string | null
        kind: string
        metadata: unknown
      }>
    >
    updateMany(args: unknown): Promise<{ count: number }>
  }
  minutePack: {
    findMany(
      args: unknown
    ): Promise<Array<{ id: string; workspaceId: string | null; accountId: string | null }>>
    updateMany(args: unknown): Promise<{ count: number }>
  }
  scan: {
    findUnique(args: unknown): Promise<{ createdById: string } | null>
  }
}

export async function runAccountBillingBackfill(
  tx: DbTx,
  apply: boolean,
  approvedMapping: Record<string, string> = {}
): Promise<BackfillReport> {
  const report: BackfillReport = {
    billingAccounts: { mapped: 0, unmapped: [] },
    usageRecords: { mapped: 0, unmapped: 0 },
    minutePacks: { mapped: 0, unmapped: 0 },
    applied: apply,
  }

  // ── 1. BillingAccount rows: attribute ownership from workspace owner. ──
  const billingRows = await tx.billingAccount.findMany({
    where: { deletedAt: null },
    select: { id: true, workspaceId: true, accountId: true },
  })
  const resolved = new Map<string, string>()
  for (const row of billingRows) {
    const proposed = approvedMapping[row.id]
    if (row.accountId && proposed && proposed !== row.accountId) {
      throw new Error(`ownership_mapping_conflict:${row.id}`)
    }
    const accountId = row.accountId ?? proposed
    if (accountId) {
      const user = await tx.user.findUnique({
        where: { id: accountId },
        select: { id: true, emailVerified: true },
      })
      if (!user?.emailVerified) throw new Error(`ownership_mapping_unverified:${row.id}`)
      resolved.set(row.id, accountId)
    }
  }
  for (const id of Object.keys(approvedMapping)) {
    if (!billingRows.some((row) => row.id === id))
      throw new Error(`ownership_mapping_unknown:${id}`)
  }
  const ownerFor = async (workspaceId: string | null): Promise<string | null> => {
    if (!workspaceId) return null
    const candidates = billingRows.filter((row) => row.workspaceId === workspaceId)
    if (candidates.length !== 1) return null
    return resolved.get(candidates[0]!.id) ?? null
  }
  for (const row of billingRows) {
    if (row.accountId) continue
    const ownerId = resolved.get(row.id)
    if (!ownerId) {
      report.billingAccounts.unmapped.push({ id: row.id, workspaceId: row.workspaceId })
      continue
    }
    if (apply) {
      await tx.billingAccount.updateMany({
        where: { id: row.id, accountId: null },
        data: { accountId: ownerId },
      })
    }
    report.billingAccounts.mapped += 1
  }

  // Preserve historical pool attribution for both grants and debits.
  const usageRows = await tx.usageRecord.findMany({
    where: { accountId: null, deletedAt: null },
    select: { id: true, workspaceId: true, kind: true, metadata: true },
  })

  for (const row of usageRows) {
    const ownerId = await ownerFor(row.workspaceId)
    if (!ownerId) {
      report.usageRecords.unmapped += 1
      continue
    }
    if (apply) {
      await tx.usageRecord.updateMany({
        where: { id: row.id, accountId: null },
        data: { accountId: ownerId },
      })
    }
    report.usageRecords.mapped += 1
  }

  const packRows = await tx.minutePack.findMany({
    where: { accountId: null, deletedAt: null },
    select: { id: true, workspaceId: true },
  })
  for (const row of packRows) {
    const ownerId = await ownerFor(row.workspaceId)
    if (!ownerId) {
      report.minutePacks.unmapped += 1
      continue
    }
    if (apply) {
      await tx.minutePack.updateMany({
        where: { id: row.id, accountId: null },
        data: { accountId: ownerId },
      })
    }
    report.minutePacks.mapped += 1
  }

  return report
}

async function main() {
  const apply = process.argv.includes(`--apply=${BACKFILL_CONFIRMATION}`)
  const databaseSystemUrl = process.env.DATABASE_SYSTEM_URL
  if (!databaseSystemUrl) {
    throw new Error("DATABASE_SYSTEM_URL is required; ordinary runtime credentials are refused")
  }

  const [{ PrismaClient }, { createBoundedPgAdapter }] = await Promise.all([
    import("../src/generated/prisma"),
    import("../src/pool"),
  ])
  const prisma = new PrismaClient({
    adapter: createBoundedPgAdapter(databaseSystemUrl),
    log: ["error"],
  })
  try {
    const mappingPath = process.argv
      .find((arg) => arg.startsWith("--mapping="))
      ?.slice("--mapping=".length)
    const mapping: unknown = mappingPath ? JSON.parse(await readFile(mappingPath, "utf8")) : {}
    if (
      !mapping ||
      typeof mapping !== "object" ||
      Array.isArray(mapping) ||
      Object.values(mapping).some((value) => typeof value !== "string" || !value.trim())
    )
      throw new Error("invalid_ownership_mapping")
    const report = await prisma.$transaction(
      async (tx) =>
        runAccountBillingBackfill(tx as unknown as DbTx, apply, mapping as Record<string, string>),
      { isolationLevel: "Serializable", maxWait: 15_000, timeout: 120_000 }
    )
    console.log(JSON.stringify(report, null, 2))
    if (!apply) {
      console.log(
        `Dry run complete. Re-run with --apply=${BACKFILL_CONFIRMATION} to write the mapping.`
      )
    }
  } finally {
    await prisma.$disconnect()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
