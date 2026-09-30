import type { ScanStatus } from "@lyrashield/db"
import type { WorkerExecutionProvenance } from "@lyrashield/config"
import type { QueueReconciliationResult } from "../queue-reconciliation"

export const OPERATOR_ACTION_GROUP = "lyrashield-operator-alerts"
const CONFIRMATION_PHRASE = "I AUTHORIZE LYRASHIELD FAILURE INJECTION"
const SCAN_ID_PATTERN = /^c[0-9a-z]{24}$/
const WORKSPACE_ID_PATTERN = /^[0-9a-z]{20,30}$/
export const TERMINAL_SCAN_STATUSES = new Set<ScanStatus>([
  "COMPLETED",
  "PARTIAL",
  "FAILED",
  "CANCELLED",
  "STOPPED_BUDGET",
  "TIMED_OUT",
])
export const ACTIVE_SCAN_STATUSES = new Set<ScanStatus>([
  "QUEUED",
  "PREFLIGHT",
  "RUNNING",
  "VERIFYING",
])

export const EXPECTED_METRIC_ALERT_RULES = [
  "worker-vm-unavailable",
  "worker-cpu-high",
  "app-no-active-replica",
  "app-replica-restart",
  "scanner-no-active-replica",
  "scanner-replica-restart",
]

export const EXPECTED_SCHEDULED_QUERY_RULES = [
  "scan-readiness-unavailable",
  "scan-queue-depth-high",
  "scan-queue-oldest-wait-high",
  "reconciliation-drift",
  "webhook-dead-letter",
  "evidence-persistence-failure",
  "terminal-cost-unreconciled",
]

export const DEFAULT_STEP_TIMEOUT_MS = 30_000
export const SETTLE_POLL_MS = 2_000
export const SETTLE_TIMEOUT_MS = 120_000

// ── Types ───────────────────────────────────────────────────────────────────

export type StepStatus = "passed" | "failed" | "skipped"

export interface StepRecord {
  name: string
  status: StepStatus
  reason?: string
  durationMs: number
}

export interface LaunchAssuranceReceipt {
  mode: "dry-run" | "storage-proof" | "full"
  timestamp: string
  productRevision: string | null
  workerImageDigest: string | null
  engineRevision: string | null
  scanId?: string
  workspaceId?: string
  incidentCommander?: string
  steps: StepRecord[]
  overall: "passed" | "failed" | "preflight_passed"
  cleanup: { removedContainers: string[] }
  durationMs: number
}

export interface LaunchAssuranceOptions {
  dryRun: boolean
  allowStorageProof: boolean
  workerImage?: string
  workerEnvFile?: string
  egressPinFile?: string
  allowFailureInjection: boolean
  scanId?: string
  workspaceId?: string
  environment?: string
  confirmProduction?: string
  incidentCommander?: string
  apiBaseUrl?: string
  apiKey?: string
  azureResourceGroup?: string
  stepTimeoutMs?: number
}

export interface LaunchAssuranceDeps {
  fetch: typeof fetch
  execFile: (command: string, args: string[]) => Promise<{ stdout: string; stderr?: string }>
  now: () => Date
  readFile: (path: string) => Promise<string>
  reconcile: () => Promise<QueueReconciliationResult>
  listActiveScans: () => Promise<Array<{ id: string; status: ScanStatus }>>
  getScanState: (
    scanId: string,
    workspaceId: string
  ) => Promise<{
    id: string
    workspaceId: string
    status: ScanStatus
  }>
  countEngineStartsSince: (scanId: string, workspaceId: string, since: Date) => Promise<number>
  hasTerminalCostUncertainty: (now: Date) => Promise<boolean>
  resolveProvenance: () => WorkerExecutionProvenance | null
  getFailureInjectionOperationalState: () => Promise<{
    admissionStopped: boolean
    enabledScheduleCount: number
    scanJobs: Array<{
      id: string
      state: "waiting" | "active" | "delayed" | "prioritized"
    }>
    webhookQueueDepth: number
  }>
}

export function assertFailureInjectionAuthorization(options: LaunchAssuranceOptions): void {
  if (options.environment !== "production") {
    throw new Error("--allow-failure-injection requires --environment production")
  }
  if (!options.scanId || !SCAN_ID_PATTERN.test(options.scanId)) {
    throw new Error("--allow-failure-injection requires an exact --scan-id")
  }
  if (!options.workspaceId || !WORKSPACE_ID_PATTERN.test(options.workspaceId)) {
    throw new Error("--allow-failure-injection requires an exact --workspace-id")
  }
  if (options.confirmProduction !== CONFIRMATION_PHRASE) {
    throw new Error("--allow-failure-injection requires the exact --confirm-production phrase")
  }
  if (
    !options.incidentCommander ||
    options.incidentCommander.trim().length === 0 ||
    options.incidentCommander.trim().length > 100
  ) {
    throw new Error("--allow-failure-injection requires a named --incident-commander")
  }
}

// ── Option parsing and validation ───────────────────────────────────────────

export function parseLaunchAssuranceOptions(
  values: Record<string, unknown>
): LaunchAssuranceOptions {
  const options: LaunchAssuranceOptions = {
    dryRun: values["dry-run"] === true,
    allowStorageProof: values["allow-storage-proof"] === true,
    allowFailureInjection: values["allow-failure-injection"] === true,
    workerImage: typeof values["worker-image"] === "string" ? values["worker-image"] : undefined,
    workerEnvFile:
      typeof values["worker-env-file"] === "string" ? values["worker-env-file"] : undefined,
    egressPinFile:
      typeof values["egress-pin-file"] === "string" ? values["egress-pin-file"] : undefined,
    scanId: typeof values["scan-id"] === "string" ? values["scan-id"] : undefined,
    workspaceId: typeof values["workspace-id"] === "string" ? values["workspace-id"] : undefined,
    environment: typeof values.environment === "string" ? values.environment : undefined,
    confirmProduction:
      typeof values["confirm-production"] === "string" ? values["confirm-production"] : undefined,
    incidentCommander:
      typeof values["incident-commander"] === "string"
        ? values["incident-commander"].trim()
        : undefined,
    azureResourceGroup:
      typeof values["azure-resource-group"] === "string"
        ? values["azure-resource-group"]
        : undefined,
  }

  if (options.workerImage !== undefined && !/@sha256:[0-9a-fA-F]{64}$/.test(options.workerImage)) {
    throw new Error("worker-image must be an immutable image reference ending in @sha256:<64 hex>")
  }

  if (options.allowStorageProof) {
    if (!options.workerImage || !options.workerEnvFile) {
      throw new Error(
        "--allow-storage-proof requires --worker-image <name@sha256:...> and --worker-env-file <path>"
      )
    }
  } else if (options.workerImage || options.workerEnvFile || options.egressPinFile) {
    throw new Error("storage-proof inputs require --allow-storage-proof")
  }

  if (options.allowFailureInjection) {
    assertFailureInjectionAuthorization(options)
  } else if (
    options.scanId ||
    options.workspaceId ||
    options.environment ||
    options.confirmProduction ||
    options.incidentCommander
  ) {
    throw new Error("failure-injection inputs require --allow-failure-injection")
  }

  return options
}
