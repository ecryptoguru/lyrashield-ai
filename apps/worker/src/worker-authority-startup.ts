import type { createBrokerWorkerAuthorityAdapter } from "./jobs/run-scan/broker-authority"

export type WorkerAuthorityMode =
  | { kind: "closed" }
  | { kind: "legacy"; compatibility: "existing-production-baseline" }
  | { kind: "broker"; adapter: ReturnType<typeof createBrokerWorkerAuthorityAdapter> }

// This one immutable startup selection owns both execution and queue lifecycle.
// The deployed compatibility baseline stays selected until coordinated cutover
// installs the qualified broker adapter and its receipt/reconciliation bridge.
// There is deliberately no environment, HTTP or queue-data mode selector.
export const workerAuthorityStartup: WorkerAuthorityMode = Object.freeze({
  kind: "legacy",
  compatibility: "existing-production-baseline",
})

export function legacyWorkerLifecycleEnabled(mode: WorkerAuthorityMode = workerAuthorityStartup) {
  return mode.kind === "legacy" && mode.compatibility === "existing-production-baseline"
}
