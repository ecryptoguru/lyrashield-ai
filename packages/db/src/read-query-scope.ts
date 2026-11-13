import type { ScanMode, ScanStatus } from "./generated/prisma"

export interface TargetReadScope {
  targetId?: string
  /** Undefined is unrestricted; an empty array matches no targets. */
  targetIds?: string[]
  /** Delegated reads require the target lifecycle to be re-evaluated in the data query itself. */
  requireActiveTarget?: boolean
  /** Delegated reads may also be limited to the scan profiles granted by the connection. */
  allowedProfiles?: string[]
}

export function targetReadScopeWhere({ targetId, targetIds }: TargetReadScope) {
  return targetIds !== undefined
    ? { targetId: { in: targetIds, ...(targetId ? { equals: targetId } : {}) } }
    : targetId
      ? { targetId }
      : {}
}

export interface FindingScopeParams extends TargetReadScope {
  workspaceId: string
  observedInScanId?: string
}

export function findingScopeWhere({
  workspaceId,
  observedInScanId,
  requireActiveTarget,
  allowedProfiles,
  ...targetScope
}: FindingScopeParams) {
  const targets = targetReadScopeWhere(targetScope)
  return {
    workspaceId,
    deletedAt: null,
    ...targets,
    ...(allowedProfiles !== undefined
      ? { scan: { mode: { in: allowedProfiles as ScanMode[] } } }
      : {}),
    ...(requireActiveTarget ? { target: { workspaceId, deletedAt: null } } : {}),
    ...(observedInScanId
      ? {
          candidates: {
            some: { workspaceId, scanId: observedInScanId, ...targets },
          },
        }
      : {}),
  }
}

export interface ListScansParams {
  workspaceId: string
  scanIds?: string[]
  targetId?: string
  targetIds?: string[]
  requireActiveTarget?: boolean
  allowedProfiles?: string[]
  status?: ScanStatus
  statuses?: ScanStatus[]
  cursor?: string
  limit?: number
}
