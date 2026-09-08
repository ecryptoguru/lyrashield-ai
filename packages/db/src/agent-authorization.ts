import type { AgentConnection } from "./generated/prisma"
import { CANONICAL_OPERATIONS, type CanonicalOperation } from "@lyrashield/types"

export { CANONICAL_OPERATIONS, AUTOMATION_WORKFLOWS } from "@lyrashield/types"

export const MUTATING_CANONICAL_OPERATIONS = new Set<CanonicalOperation>([
  CANONICAL_OPERATIONS.SCAN_CREATE,
  CANONICAL_OPERATIONS.REPORT_CREATE,
  CANONICAL_OPERATIONS.FIX_PROPOSAL_CREATE,
  CANONICAL_OPERATIONS.RETEST_CREATE,
  CANONICAL_OPERATIONS.FIX_PR_CREATE,
])

export type { CanonicalOperation } from "@lyrashield/types"

export interface ToolOperationDescriptor {
  canonicalOperation: CanonicalOperation
  mutating: boolean
  requiresTarget: boolean
  isBillable: boolean
}

export const TOOL_OPERATION_MAP: Record<string, ToolOperationDescriptor> = {
  // Read tools
  lyrashield_get_workspace: {
    canonicalOperation: CANONICAL_OPERATIONS.WORKSPACE_READ,
    mutating: false,
    requiresTarget: false,
    isBillable: false,
  },
  lyrashield_list_workspaces: {
    canonicalOperation: CANONICAL_OPERATIONS.WORKSPACE_READ,
    mutating: false,
    requiresTarget: false,
    isBillable: false,
  },
  lyrashield_list_targets: {
    canonicalOperation: CANONICAL_OPERATIONS.TARGET_LIST,
    mutating: false,
    requiresTarget: false,
    isBillable: false,
  },
  lyrashield_get_target: {
    canonicalOperation: CANONICAL_OPERATIONS.TARGET_READ,
    mutating: false,
    requiresTarget: true,
    isBillable: false,
  },
  lyrashield_get_findings: {
    canonicalOperation: CANONICAL_OPERATIONS.FINDING_LIST,
    mutating: false,
    requiresTarget: false,
    isBillable: false,
  },
  lyrashield_get_finding_detail: {
    canonicalOperation: CANONICAL_OPERATIONS.FINDING_READ,
    mutating: false,
    requiresTarget: false,
    isBillable: false,
  },
  lyrashield_get_scan_status: {
    canonicalOperation: CANONICAL_OPERATIONS.SCAN_READ,
    mutating: false,
    requiresTarget: false,
    isBillable: false,
  },
  lyrashield_get_reports: {
    canonicalOperation: CANONICAL_OPERATIONS.REPORT_LIST,
    mutating: false,
    requiresTarget: false,
    isBillable: false,
  },
  lyrashield_check_eligibility: {
    canonicalOperation: CANONICAL_OPERATIONS.SCAN_ELIGIBILITY,
    mutating: false,
    requiresTarget: true,
    isBillable: false,
  },
  lyrashield_get_verdict: {
    canonicalOperation: CANONICAL_OPERATIONS.GATE_READ,
    mutating: false,
    requiresTarget: false,
    isBillable: false,
  },
  lyrashield_get_launch_readiness: {
    canonicalOperation: CANONICAL_OPERATIONS.GATE_READ,
    mutating: false,
    requiresTarget: false,
    isBillable: false,
  },
  lyrashield_check_diff: {
    canonicalOperation: CANONICAL_OPERATIONS.GATE_READ,
    mutating: false,
    requiresTarget: false,
    isBillable: false,
  },
  lyrashield_explain_finding: {
    canonicalOperation: CANONICAL_OPERATIONS.FINDING_READ,
    mutating: false,
    requiresTarget: false,
    isBillable: false,
  },
  lyrashield_generate_fix_plan: {
    canonicalOperation: CANONICAL_OPERATIONS.FINDING_READ,
    mutating: false,
    requiresTarget: false,
    isBillable: false,
  },
  lyrashield_create_pr_security_recap: {
    canonicalOperation: CANONICAL_OPERATIONS.GATE_READ,
    mutating: false,
    requiresTarget: true,
    isBillable: false,
  },

  // Mutating tools (5)
  lyrashield_scan_target: {
    canonicalOperation: CANONICAL_OPERATIONS.SCAN_CREATE,
    mutating: true,
    requiresTarget: true,
    isBillable: true,
  },
  lyrashield_run_pr_scan: {
    canonicalOperation: CANONICAL_OPERATIONS.SCAN_CREATE,
    mutating: true,
    requiresTarget: true,
    isBillable: true,
  },
  lyrashield_create_report: {
    canonicalOperation: CANONICAL_OPERATIONS.REPORT_CREATE,
    mutating: true,
    requiresTarget: false,
    isBillable: false,
  },
  lyrashield_create_fix_proposal: {
    canonicalOperation: CANONICAL_OPERATIONS.FIX_PROPOSAL_CREATE,
    mutating: true,
    requiresTarget: false,
    isBillable: false,
  },
  lyrashield_record_fix_proposal: {
    canonicalOperation: CANONICAL_OPERATIONS.FIX_PROPOSAL_CREATE,
    mutating: true,
    requiresTarget: false,
    isBillable: false,
  },
  lyrashield_request_retest: {
    canonicalOperation: CANONICAL_OPERATIONS.RETEST_CREATE,
    mutating: true,
    requiresTarget: false,
    isBillable: true,
  },
  lyrashield_verify_fix: {
    canonicalOperation: CANONICAL_OPERATIONS.RETEST_CREATE,
    mutating: true,
    requiresTarget: false,
    isBillable: true,
  },
  lyrashield_create_fix_pr: {
    canonicalOperation: CANONICAL_OPERATIONS.FIX_PR_CREATE,
    mutating: true,
    requiresTarget: false,
    isBillable: false,
  },
}

export type AuthorizationDenialReason =
  | "CONNECTION_REVOKED"
  | "CONNECTION_PAUSED"
  | "CONNECTION_EXPIRED"
  | "OPERATION_NOT_GRANTED"
  | "TARGET_NOT_GRANTED"
  | "PROFILE_NOT_GRANTED"
  | "WORKSPACE_MISMATCH"
  | "UNKNOWN_OPERATION"

export interface AuthorizationCheckParams {
  connection: Pick<
    AgentConnection,
    | "id"
    | "workspaceId"
    | "status"
    | "expiresAt"
    | "allowedTargetIds"
    | "allowedOperations"
    | "allowedProfiles"
    | "allTargets"
  >
  workspaceId: string
  operationName: string
  targetId?: string
  profile?: string
}

export type AuthorizationCheckResult =
  | {
      authorized: true
      canonicalOperation: CanonicalOperation
    }
  | {
      authorized: false
      code: AuthorizationDenialReason
      reason: string
      canonicalOperation?: CanonicalOperation
    }

export function checkDelegatedOperationAuthorization(
  params: AuthorizationCheckParams
): AuthorizationCheckResult {
  const { connection, workspaceId, operationName, targetId, profile } = params

  if (connection.workspaceId !== workspaceId) {
    return {
      authorized: false,
      code: "WORKSPACE_MISMATCH",
      reason: `Connection belongs to workspace ${connection.workspaceId}, not ${workspaceId}`,
    }
  }

  if (connection.status === "REVOKED") {
    return {
      authorized: false,
      code: "CONNECTION_REVOKED",
      reason: "Agent connection has been revoked",
    }
  }

  if (connection.status === "PAUSED") {
    return {
      authorized: false,
      code: "CONNECTION_PAUSED",
      reason: "Agent connection is paused",
    }
  }

  if (connection.expiresAt && connection.expiresAt.getTime() <= Date.now()) {
    return {
      authorized: false,
      code: "CONNECTION_EXPIRED",
      reason: "Agent connection has expired",
    }
  }

  const descriptor =
    TOOL_OPERATION_MAP[operationName] ??
    Object.values(TOOL_OPERATION_MAP).find((d) => d.canonicalOperation === operationName)

  if (!descriptor) {
    return {
      authorized: false,
      code: "UNKNOWN_OPERATION",
      reason: `Unknown tool or operation: ${operationName}`,
    }
  }

  const canonical = descriptor.canonicalOperation

  if (descriptor.mutating && !connection.allowedOperations.includes(canonical)) {
    return {
      authorized: false,
      code: "OPERATION_NOT_GRANTED",
      reason: `Operation ${canonical} (${operationName}) is not in the allowed operations list for this connection`,
      canonicalOperation: canonical,
    }
  }

  if (descriptor.mutating || descriptor.requiresTarget) {
    if (!targetId && !connection.allTargets) {
      return {
        authorized: false,
        code: "TARGET_NOT_GRANTED",
        reason: `Operation ${operationName} requires an authorized target scope`,
        canonicalOperation: canonical,
      }
    }
    if (targetId && !connection.allTargets && !connection.allowedTargetIds.includes(targetId)) {
      return {
        authorized: false,
        code: "TARGET_NOT_GRANTED",
        reason: `Target ${targetId} is not in the allowed targets list for this connection`,
        canonicalOperation: canonical,
      }
    }
  }

  // If scan profile is checked (e.g. SAFE, QUICK, STANDARD, DEEP)
  if (descriptor.isBillable && !profile) {
    return {
      authorized: false,
      code: "PROFILE_NOT_GRANTED",
      reason: `Operation ${operationName} requires an allowed scan profile`,
      canonicalOperation: canonical,
    }
  }
  if (profile) {
    const normalizedProfile = profile.toUpperCase()
    if (!connection.allowedProfiles.map((p) => p.toUpperCase()).includes(normalizedProfile)) {
      return {
        authorized: false,
        code: "PROFILE_NOT_GRANTED",
        reason: `Scan profile ${profile} is not in the allowed profiles list for this connection`,
        canonicalOperation: canonical,
      }
    }
  }

  return {
    authorized: true,
    canonicalOperation: canonical,
  }
}
