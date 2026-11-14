import { createBrokerWorkerAuthorityAdapter } from "./jobs/run-scan/broker-authority"
import { loadProtectedWorkerBrokerInstallation } from "./installed-worker-authority"

export type WorkerAuthorityMode =
  | { kind: "closed" }
  | { kind: "legacy"; compatibility: "existing-production-baseline" }
  | { kind: "broker"; adapter: ReturnType<typeof createBrokerWorkerAuthorityAdapter> }

// This one immutable startup selection owns both execution and queue lifecycle.
// New candidate images stay closed until trusted startup installs the qualified
// broker adapter and its receipt/reconciliation bridge. The already deployed
// compatibility baseline remains at its original source revision.
// There is deliberately no environment, HTTP or queue-data mode selector.
export let workerAuthorityStartup: WorkerAuthorityMode = Object.freeze({ kind: "closed" })
let initialization: Promise<WorkerAuthorityMode> | undefined

/** Only the actual worker entrypoint initializes authority, once, before consumers and readiness. */
export function initializeWorkerAuthorityStartup(): Promise<WorkerAuthorityMode> {
  initialization ??= loadProtectedWorkerBrokerInstallation()
    .then((installed) => {
      workerAuthorityStartup = installed
        ? Object.freeze({ kind: "broker", adapter: createBrokerWorkerAuthorityAdapter(installed) })
        : Object.freeze({ kind: "closed" })
      return workerAuthorityStartup
    })
    .catch(() => workerAuthorityStartup)
  return initialization
}

export function legacyWorkerLifecycleEnabled(mode: WorkerAuthorityMode = workerAuthorityStartup) {
  return mode.kind === "legacy" && mode.compatibility === "existing-production-baseline"
}
