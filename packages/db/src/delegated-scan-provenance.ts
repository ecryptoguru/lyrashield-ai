import type { ScanTransaction } from "./scan-service-types"
import { verifyDelegatedAdmissionProof } from "./agent-operation-hash"

export interface DelegatedScanAdmission {
  operationId: string
  /** Canonical outer operation; defaults to the original scan.create contract. */
  operationName?: "scan.create" | "retest.create"
  /** Plaintext server-only capability; persisted history contains only its hash. */
  admissionProof: string
  connectionId: string
  authorizationVersion: number
}

export class DelegatedScanAdmissionError extends Error {
  readonly code = "DELEGATED_SCAN_ADMISSION_INVALID"

  constructor() {
    super("Delegated scan admission is no longer valid")
    this.name = "DelegatedScanAdmissionError"
  }
}

/**
 * Reserve an admitted scan on its outer delegated operation and persist the
 * immutable operation→scan→target binding. The caller must run this inside the
 * same transaction that created the scan and funded its capacity.
 */
export async function bindDelegatedScanProvenance(
  tx: ScanTransaction,
  params: {
    workspaceId: string
    scanId: string
    targetId: string
    executionPlanHash: string
    admission: DelegatedScanAdmission
  }
) {
  const identity = {
    id: params.admission.operationId,
    workspaceId: params.workspaceId,
    connectionId: params.admission.connectionId,
    principalType: "OAUTH_CONNECTION" as const,
    principalId: params.admission.connectionId,
    operationName: params.admission.operationName ?? "scan.create",
    authorizationVersion: params.admission.authorizationVersion,
    status: "EXECUTING" as const,
    resultReference: null,
  }
  const operation = await tx.agentOperation.findFirst({
    where: identity,
    select: { id: true, inputHash: true, admissionProofHash: true },
  })
  if (
    !operation ||
    !verifyDelegatedAdmissionProof(params.admission.admissionProof, operation.admissionProofHash)
  ) {
    throw new DelegatedScanAdmissionError()
  }

  const reserved = await tx.agentOperation.updateMany({
    where: identity,
    data: { resultReference: params.scanId },
  })
  if (reserved.count !== 1) throw new DelegatedScanAdmissionError()

  await tx.delegatedScanProvenance.create({
    data: {
      operationId: operation.id,
      workspaceId: params.workspaceId,
      scanId: params.scanId,
      targetId: params.targetId,
      connectionId: params.admission.connectionId,
      authorizationVersion: params.admission.authorizationVersion,
      operationInputHash: operation.inputHash,
      scanExecutionPlanHash: params.executionPlanHash,
    },
  })
}

/**
 * Resolve a delegated operation after validating its server-issued proof. This
 * is a preflight only; the scan transaction repeats and atomically reserves it.
 */
export async function resolveDelegatedScanOperation(
  tx: ScanTransaction,
  params: {
    workspaceId: string
    admission: DelegatedScanAdmission
  }
) {
  const operation = await tx.agentOperation.findFirst({
    where: {
      id: params.admission.operationId,
      workspaceId: params.workspaceId,
      connectionId: params.admission.connectionId,
      principalType: "OAUTH_CONNECTION",
      principalId: params.admission.connectionId,
      operationName: "scan.create",
      authorizationVersion: params.admission.authorizationVersion,
      status: "EXECUTING",
      resultReference: null,
    },
  })
  if (
    !operation ||
    !verifyDelegatedAdmissionProof(params.admission.admissionProof, operation.admissionProofHash)
  ) {
    throw new DelegatedScanAdmissionError()
  }
  return operation
}
