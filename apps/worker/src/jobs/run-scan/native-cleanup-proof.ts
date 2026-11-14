import { readScanDispatchCleanupProof } from "@lyrashield/db/src/scan-dispatch-cleanup-proof"
import type { ScanAuthorityResult } from "./authority"
import {
  isVerifiedNativeEngineResult,
  type VerifiedNativeEngineResult,
} from "./native-engine-result"

export async function readNativeCleanupProof(
  native: VerifiedNativeEngineResult | undefined,
  workspaceId: string,
  scanId: string,
  executionPlan: Extract<ScanAuthorityResult, { ok: true }>["executionPlan"]
) {
  const nativeCleanup = native ? await readScanDispatchCleanupProof(workspaceId, scanId) : null
  if (
    native &&
    (native.action.scanId !== scanId ||
      native.action.workspaceId !== workspaceId ||
      native.engineResult.sourceRevision !== executionPlan?.source?.revision ||
      !nativeCleanup ||
      nativeCleanup.operationId !== native.action.operationId ||
      nativeCleanup.attemptId !== native.action.attemptId ||
      nativeCleanup.authorityEpochId !== native.action.authorityEpochId)
  )
    throw new Error("Native cleanup or source proof unavailable")
  return nativeCleanup
}

export function assertVerifiedNativeResult(native: VerifiedNativeEngineResult) {
  if (!isVerifiedNativeEngineResult(native)) throw new Error("Native result authority unavailable")
}
