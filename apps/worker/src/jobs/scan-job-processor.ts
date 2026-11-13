import type { Job } from "bullmq"
import type { ScanJobData, ScanJobResult } from "@lyrashield/types"
import { processScanJob } from "./run-scan.job"
import { retainedBrokerScanResult } from "./run-scan/broker-authority"
import {
  workerAuthorityStartup,
  legacyWorkerLifecycleEnabled,
  type WorkerAuthorityMode,
} from "../worker-authority-startup"

/** Mode is immutable trusted startup configuration; queue fields cannot select it. */
export function createWorkerScanJobProcessor(mode: WorkerAuthorityMode = { kind: "closed" }) {
  const selected = Object.freeze({ ...mode })
  return async (job: Job<ScanJobData, ScanJobResult>): Promise<ScanJobResult> => {
    if (legacyWorkerLifecycleEnabled(selected)) return processScanJob(job)
    if (selected.kind === "broker" && typeof selected.adapter?.process === "function") {
      try {
        return await selected.adapter.process(job)
      } catch {
        return retainedBrokerScanResult("BROKER_OUTCOME_UNKNOWN")
      }
    }
    return retainedBrokerScanResult("BROKER_AUTHORITY_CLOSED")
  }
}

// Preserve the deployed legacy baseline until issuer/IPC/receipt/worker grants
// are qualified together. Cutover must replace this startup selection once;
// the broker branch never calls the legacy executor, even after uncertainty.
export const processWorkerScanJob = createWorkerScanJobProcessor(workerAuthorityStartup)
