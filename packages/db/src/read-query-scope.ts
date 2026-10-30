import type { ScanStatus } from "./generated/prisma"

export interface TargetReadScope {
  targetId?: string
  /** Undefined is unrestricted; an empty array matches no targets. */
  targetIds?: string[]
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
  ...targetScope
}: FindingScopeParams) {
  const targets = targetReadScopeWhere(targetScope)
  return {
    workspaceId,
    deletedAt: null,
    ...targets,
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
  status?: ScanStatus
  statuses?: ScanStatus[]
  cursor?: string
  limit?: number
}
