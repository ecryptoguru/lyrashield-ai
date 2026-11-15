import { logger } from "@lyrashield/logger"
import { createBrokerWorkerAuthorityAdapter } from "./jobs/run-scan/broker-authority"
import { loadProtectedWorkerBrokerInstallation } from "./installed-worker-authority"

export type WorkerAuthorityMode =
  | { kind: "closed" }
  | { kind: "legacy"; compatibility: "existing-production-baseline" }
  | { kind: "broker"; adapter: ReturnType<typeof createBrokerWorkerAuthorityAdapter> }

// This one immutable startup selection owns both execution and queue lifecycle.
// Normal startup selects the established production baseline (Docker sandbox
// isolation, egress-restricted network, pinned image digests, provenance,
// budget and evidence controls) unless trusted startup installs a qualified
// broker adapter with its receipt/reconciliation bridge. The broker remains
// fail-closed by itself: no installation means no broker authority, never a
// degraded broker. There is deliberately no environment, HTTP or queue-data
// mode selector.
export let workerAuthorityStartup: WorkerAuthorityMode = Object.freeze({ kind: "closed" })
let initialization: Promise<WorkerAuthorityMode> | undefined

/** Only the actual worker entrypoint initializes authority, once, before consumers and readiness. */
export function initializeWorkerAuthorityStartup(): Promise<WorkerAuthorityMode> {
  initialization ??= loadProtectedWorkerBrokerInstallation()
    .then((installed) => {
      workerAuthorityStartup = installed
        ? Object.freeze({ kind: "broker", adapter: createBrokerWorkerAuthorityAdapter(installed) })
        : Object.freeze({
            kind: "legacy",
            compatibility: "existing-production-baseline",
          })
      logger.info("Worker authority selected", { mode: workerAuthorityStartup.kind })
      return workerAuthorityStartup
    })
    .catch(() => workerAuthorityStartup)
  return initialization
}

export function legacyWorkerLifecycleEnabled(mode: WorkerAuthorityMode = workerAuthorityStartup) {
  return mode.kind === "legacy" && mode.compatibility === "existing-production-baseline"
}
