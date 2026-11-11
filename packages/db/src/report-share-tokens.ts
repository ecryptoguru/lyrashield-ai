import { createHash, randomBytes } from "crypto"
import type { Prisma } from "./generated/prisma"
import { ScanMode } from "./generated/prisma"
import type { DelegatedReadAuthority } from "./delegated-read-access"
import { withWorkspaceRLS, type ScopedTransaction } from "./rls"
import { lockActiveTargetForDerivedWrite } from "./target-write-lock"

interface ShareTokenOptions {
  targetId?: string | null
  requireActiveTarget?: boolean
  client?: ScopedTransaction
}

interface ReleasePacketShareTokenOptions {
  /** Delegated authority must remain held by this caller-owned transaction. */
  client?: ScopedTransaction
  authority?: DelegatedReadAuthority
}

function releasePacketAuthorityWhere(
  workspaceId: string,
  authority?: DelegatedReadAuthority
): Prisma.ReportWhereInput {
  if (!authority) return {}
  return {
    // Bind delegated scope to the UPDATE, so a changed report/scan binding
    // cannot mutate a capability outside the locked grant.
    scan: {
      workspaceId,
      deletedAt: null,
      targetId: {
        in: authority.targetId ? [authority.targetId] : (authority.targetIds ?? []),
      },
      mode: {
        in: Object.values(ScanMode).filter((mode) => authority.allowedProfiles.includes(mode)),
      },
      target: { workspaceId, deletedAt: null },
    },
  }
}

export async function generateShareToken(
  reportId: string,
  workspaceId: string,
  options: ShareTokenOptions = {}
): Promise<{ token: string; tokenHash: string; expiresAt: Date }> {
  return generateTypedShareToken(reportId, workspaceId, false, options)
}

/** Packet issuance uses a private link whose readers still require workspace permission. */
export async function generateReleasePacketShareToken(
  reportId: string,
  workspaceId: string,
  options: ReleasePacketShareTokenOptions = {}
): Promise<{ token: string; tokenHash: string; expiresAt: Date }> {
  if (options.authority && !options.client) throw new Error("FORBIDDEN")
  return generateTypedShareToken(reportId, workspaceId, true, options)
}

async function generateTypedShareToken(
  reportId: string,
  workspaceId: string,
  releasePacket: boolean,
  options: ShareTokenOptions & ReleasePacketShareTokenOptions = {}
): Promise<{ token: string; tokenHash: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("hex")
  const tokenHash = createHash("sha256").update(token).digest("hex")
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)

  const update = async (tx: ScopedTransaction) => {
    if (options.requireActiveTarget) {
      const targetId = options.targetId
      if (!targetId || !(await lockActiveTargetForDerivedWrite(tx, workspaceId, targetId))) {
        throw new Error("FORBIDDEN")
      }
    }
    const updated = await tx.report.updateMany({
      // Bind the type to the write itself: a pre-read cannot prevent a type-change race.
      where: {
        id: reportId,
        workspaceId,
        deletedAt: null,
        type: releasePacket ? "release_packet" : { not: "release_packet" },
        ...(releasePacket ? releasePacketAuthorityWhere(workspaceId, options.authority) : {}),
      },
      data: {
        shareTokenHash: tokenHash,
        shareExpiresAt: expiresAt,
        revokedAt: null,
      },
    })
    if (updated.count !== 1) throw new Error("Report not found")
  }
  if (options.client) await update(options.client)
  else await withWorkspaceRLS(workspaceId, update)

  return { token, tokenHash, expiresAt }
}

export async function revokeShareToken(
  reportId: string,
  workspaceId: string,
  options: {
    targetId?: string | null
    requireActiveTarget?: boolean
    client?: ScopedTransaction
  } = {}
): Promise<Date> {
  const revokedAt = new Date()
  const update = async (tx: ScopedTransaction) => {
    if (options.requireActiveTarget) {
      const targetId = options.targetId
      if (!targetId || !(await lockActiveTargetForDerivedWrite(tx, workspaceId, targetId))) {
        throw new Error("FORBIDDEN")
      }
    }
    const updated = await tx.report.updateMany({
      where: { id: reportId, workspaceId, deletedAt: null, type: { not: "release_packet" } },
      data: { revokedAt },
    })
    if (updated.count !== 1) throw new Error("Report not found")
  }
  if (options.client) await update(options.client)
  else await withWorkspaceRLS(workspaceId, update)
  return revokedAt
}

/** Revoke a private packet capability without requiring its snapshot to verify. */
export async function revokeReleasePacketShareToken(
  reportId: string,
  workspaceId: string,
  options: ReleasePacketShareTokenOptions = {}
): Promise<Date> {
  if (options.authority && !options.client) throw new Error("FORBIDDEN")
  const revokedAt = new Date()
  const update = async (tx: ScopedTransaction) => {
    const updated = await tx.report.updateMany({
      where: {
        id: reportId,
        workspaceId,
        deletedAt: null,
        type: "release_packet",
        ...releasePacketAuthorityWhere(workspaceId, options.authority),
      },
      data: { revokedAt },
    })
    if (updated.count !== 1) throw new Error("Report not found")
  }
  if (options.client) await update(options.client)
  else await withWorkspaceRLS(workspaceId, update)
  return revokedAt
}
