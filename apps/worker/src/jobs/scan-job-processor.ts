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

// Imports used by operator CLIs remain closed. The actual worker entrypoint
// completes its one-time installed authority initialization before invoking this.
export async function processWorkerScanJob(
  job: Job<ScanJobData, ScanJobResult>
): Promise<ScanJobResult> {
  return createWorkerScanJobProcessor(workerAuthorityStartup)(job)
}
