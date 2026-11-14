import { createHash } from "node:crypto"
import type { Job } from "bullmq"
import { readScanDispatchCleanupProof } from "@lyrashield/db/src/scan-dispatch-cleanup-proof"
import type { ScanJobData, ScanJobResult } from "@lyrashield/types"
import type { ScanAuthorityResult } from "./authority"
import { retainedBrokerScanResult, type WorkerBrokerInstallation } from "./broker-authority"
import { processNativeScanResult } from "../run-scan.job"
import { verifyNativeEngineResult, type VerifiedNativeEngineResult } from "./native-engine-result"

export async function readBrokerNativeResult(
  job: Job<ScanJobData, ScanJobResult>,
  installation: WorkerBrokerInstallation,
  authority: Extract<ScanAuthorityResult, { ok: true }>,
  identity: {
    operationId: string
    authorityEpochId: string
    workerInstanceId: string
    workerGrantId: string
  },
  status: Extract<
    Awaited<ReturnType<WorkerBrokerInstallation["broker"]["status"]>>,
    { kind: "available" }
  >,
  operation: { operationId: string }
): Promise<ScanJobResult | undefined> {
  if (!status.attemptId || !installation.results)
    return retainedBrokerScanResult("BROKER_RESULT_PENDING")
  const raw = await installation.results.read(operation.operationId, status.attemptId)
  if (raw) {
    const proof = await installation.results.proof(operation.operationId)
    let native: VerifiedNativeEngineResult
    try {
      native = verifyNativeEngineResult(raw, proof, {
        operationId: operation.operationId,
        attemptId: status.attemptId,
        workspaceId: authority.workspaceId,
        scanId: authority.data.scanId,
        authorityEpochId: installation.authority.authorityEpochId,
        productRevision: installation.authority.productRevision,
        engineRevision: installation.authority.engineRevision,
        sourceRevision: authority.executionPlan!.source?.revision ?? "",
      })
    } catch {
      // Root authenticated finished bytes still permit exact signed cleanup when the output cannot be finalized.
      if (
        proof.action.operationId === operation.operationId &&
        proof.action.attemptId === status.attemptId &&
        proof.action.scanId === authority.data.scanId &&
        proof.action.workspaceId === authority.workspaceId &&
        proof.action.authorityEpochId === installation.authority.authorityEpochId &&
        proof.action.phase === "EXECUTOR_CREATE" &&
        proof.action.executorKey === "engine" &&
        raw.length === proof.totalBytes &&
        `sha256:${createHash("sha256").update(raw).digest("hex")}` === proof.sha256 &&
        !["STOPPING", "TERMINATED"].includes(status.state)
      ) {
        await installation.broker.stop({
          ...identity,
          attemptId: status.attemptId,
          reasonCode: "ENGINE_OUTPUT_INCOMPLETE",
        })
      }
      return retainedBrokerScanResult("BROKER_RESULT_INCOMPLETE")
    }
    const cleanup = await readScanDispatchCleanupProof(authority.workspaceId, authority.data.scanId)
    if (
      !cleanup ||
      cleanup.operationId !== native.action.operationId ||
      cleanup.attemptId !== native.action.attemptId ||
      cleanup.authorityEpochId !== native.action.authorityEpochId
    ) {
      native.cleanup()
      if (!["STOPPING", "TERMINATED"].includes(status.state))
        await installation.broker.stop({
          ...identity,
          attemptId: status.attemptId,
          reasonCode: "ENGINE_OUTPUT_CAPTURED",
        })
      return retainedBrokerScanResult("BROKER_STOP_PENDING")
    }
    return processNativeScanResult(job, native)
  }
}
