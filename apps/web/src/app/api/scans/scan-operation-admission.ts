import {
  claimOrGetAgentOperation,
  getDelegatedOperationAccess,
  resolveDelegatedScanOperation,
} from "@lyrashield/db"
import { DELEGATED_OPERATION_ID_HEADER, DELEGATED_OPERATION_PROOF_HEADER } from "@lyrashield/types"
import type { NextResponse } from "next/server"
import { apiError, apiSuccess } from "../../../lib/api-response"
import { publicScanResult } from "../../../lib/scan-provenance"

export interface DelegatedScanAdmission {
  operationId: string
  admissionProof: string
  connectionId: string
  authorizationVersion: number
}

type OAuthPrincipal = { connectionId?: string; authorizationVersion?: number }

export type DelegatedAdmissionResult =
  | { kind: "none" }
  | { kind: "invalid"; response: NextResponse }
  | {
      kind: "admitted"
      admission: DelegatedScanAdmission
      operation: NonNullable<Awaited<ReturnType<typeof resolveDelegatedScanOperation>>>
    }

/** Verify the server-only capability before any target or billing side effect. */
export async function resolveDelegatedScanAdmission(params: {
  request: Request
  workspaceId: string
  oauth?: OAuthPrincipal
}): Promise<DelegatedAdmissionResult> {
  const operationId = params.request.headers.get(DELEGATED_OPERATION_ID_HEADER)?.trim()
  const proof = params.request.headers.get(DELEGATED_OPERATION_PROOF_HEADER)?.trim()
  if (!operationId && !proof) return { kind: "none" }
  if (
    !operationId ||
    !proof ||
    operationId.length > 128 ||
    proof.length < 32 ||
    proof.length > 256 ||
    !params.oauth?.connectionId ||
    !params.oauth.authorizationVersion
  ) {
    return {
      kind: "invalid",
      response: apiError(
        "FORBIDDEN",
        "Delegated scan admission proof is invalid for this connection.",
        403
      ),
    }
  }

  const operation = await resolveDelegatedScanOperation(params.workspaceId, {
    operationId,
    admissionProof: proof,
    connectionId: params.oauth.connectionId,
    authorizationVersion: params.oauth.authorizationVersion,
  })
  if (!operation) {
    return {
      kind: "invalid",
      response: apiError(
        "OPERATION_ADMISSION_INVALID",
        "This delegated operation is not authorized for scan admission.",
        409
      ),
    }
  }
  return {
    kind: "admitted",
    admission: {
      operationId: operation.id,
      admissionProof: proof,
      connectionId: params.oauth.connectionId,
      authorizationVersion: params.oauth.authorizationVersion,
    },
    operation,
  }
}

/** Resolve ordinary REST idempotency without duplicating a delegated MCP claim. */
export async function claimOrdinaryScanOperation(params: {
  request: Request
  workspaceId: string
  input: Record<string, unknown>
  oauth?: OAuthPrincipal
  apiKeyId?: string
  userId: string
  member?: { id: string; role: string; updatedAt: Date }
  delegated: boolean
}): Promise<{
  claim?: Awaited<ReturnType<typeof claimOrGetAgentOperation>>
  response?: NextResponse
}> {
  if (params.delegated) return {}
  const idempotencyKey = params.request.headers.get("idempotency-key")?.trim()
  if (idempotencyKey === undefined) return {}
  if (idempotencyKey.length < 1 || idempotencyKey.length > 128) {
    return {
      response: apiError("VALIDATION_ERROR", "Idempotency-Key must be 1-128 characters", 400),
    }
  }
  const claim = await claimOrGetAgentOperation({
    workspaceId: params.workspaceId,
    operationName: "scan.create",
    idempotencyKey,
    input: params.input,
    connectionId: params.oauth?.connectionId,
    authorizationVersion: params.oauth?.authorizationVersion,
    apiKeyId: params.apiKeyId,
    userId: params.apiKeyId || params.oauth ? undefined : params.userId,
  })
  if (claim.status === "CONFLICT") {
    return {
      response: apiError("IDEMPOTENCY_CONFLICT", claim.message, 409),
    }
  }
  if (claim.status === "REPLAY") {
    if (params.oauth?.connectionId) {
      if (!params.oauth.authorizationVersion || !params.member) {
        return {
          response: apiError("FORBIDDEN", "Current delegated access could not be verified.", 403),
        }
      }
      const access = await getDelegatedOperationAccess({
        operationId: claim.operation.id,
        workspaceId: params.workspaceId,
        userId: params.userId,
        memberId: params.member.id,
        memberRole: params.member.role,
        memberUpdatedAt: params.member.updatedAt,
        connectionId: params.oauth.connectionId,
        authorizationVersion: params.oauth.authorizationVersion,
      })
      if (!access) {
        return {
          response: apiError(
            "FORBIDDEN",
            "Current delegated access does not authorize this operation.",
            403
          ),
        }
      }
      if (access.disclosure !== "FULL") {
        return {
          response: apiSuccess(
            {
              operationId: claim.operation.id,
              status: access.status.status,
              ...(access.status.resultLocation
                ? { scan: { id: access.status.resultLocation } }
                : {}),
            },
            200
          ),
        }
      }
    }
    if (!claim.operation.result || !claim.operation.resultReference) {
      return {
        response: apiError(
          "OPERATION_RESULT_UNAVAILABLE",
          "The recorded scan cannot be replayed. Inspect its operation status.",
          409,
          undefined,
          { operationId: claim.operation.id }
        ),
      }
    }
    return {
      response: apiSuccess(
        {
          ...publicScanResult(claim.operation.result as Record<string, unknown>),
          operationId: claim.operation.id,
        },
        200
      ),
    }
  }
  if (claim.status === "FAILED") {
    return {
      response: apiError(
        "OPERATION_FAILED",
        "This operation previously failed. Inspect its status before starting another scan.",
        409,
        undefined,
        { operationId: claim.operation.id }
      ),
    }
  }
  if (claim.status === "IN_PROGRESS") {
    return {
      response: apiError(
        "OPERATION_IN_PROGRESS",
        "An identical scan start is already in progress. Poll the operation status instead of retrying.",
        409,
        undefined,
        { operationId: claim.operation.id }
      ),
    }
  }
  return { claim }
}

export function isDelegatedScanAdmissionError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as Error & { code?: string }).code === "DELEGATED_SCAN_ADMISSION_INVALID"
  )
}
