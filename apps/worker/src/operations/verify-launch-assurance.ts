import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { execFile as nodeExecFile } from "node:child_process"
import { promisify } from "node:util"
import { pathToFileURL } from "node:url"
import { parseArgs } from "node:util"
import { getSystemPrisma, prisma, withWorkspaceRLS, type ScanStatus } from "@lyrashield/db"
import {
  getRedis,
  getWebhookTrackRetryQueue,
  SCAN_ADMISSION_STOP_KEY,
} from "@lyrashield/integrations"
import {
  env,
  resolveWorkerExecutionProvenance,
  type WorkerExecutionProvenance,
} from "@lyrashield/config"
import { reconcileScanQueue, type QueueReconciliationResult } from "../queue-reconciliation"
import { findOldestTerminalUnreconciledCost } from "../operational-health"
import { getScanQueue } from "../queue"

const nodeExecFileAsync = promisify(nodeExecFile)

// ── Constants ───────────────────────────────────────────────────────────────

const OPERATOR_ACTION_GROUP = "lyrashield-operator-alerts"
const CONFIRMATION_PHRASE = "I AUTHORIZE LYRASHIELD FAILURE INJECTION"
const SCAN_ID_PATTERN = /^c[0-9a-z]{24}$/
const WORKSPACE_ID_PATTERN = /^[0-9a-z]{20,30}$/
const TERMINAL_SCAN_STATUSES = new Set<ScanStatus>([
  "COMPLETED",
  "PARTIAL",
  "FAILED",
  "CANCELLED",
  "STOPPED_BUDGET",
  "TIMED_OUT",
])
const ACTIVE_SCAN_STATUSES = new Set<ScanStatus>(["QUEUED", "PREFLIGHT", "RUNNING", "VERIFYING"])

const EXPECTED_METRIC_ALERT_RULES = [
  "worker-vm-unavailable",
  "worker-cpu-high",
  "app-no-active-replica",
  "app-replica-restart",
  "scanner-no-active-replica",
  "scanner-replica-restart",
]

const EXPECTED_SCHEDULED_QUERY_RULES = [
  "scan-readiness-unavailable",
  "scan-queue-depth-high",
  "scan-queue-oldest-wait-high",
  "reconciliation-drift",
  "webhook-dead-letter",
  "evidence-persistence-failure",
  "terminal-cost-unreconciled",
]

const DEFAULT_STEP_TIMEOUT_MS = 30_000
const SETTLE_POLL_MS = 2_000
const SETTLE_TIMEOUT_MS = 120_000

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

function assertFailureInjectionAuthorization(options: LaunchAssuranceOptions): void {
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

// ── Helpers ─────────────────────────────────────────────────────────────────

function boundedReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.slice(0, 200)
}

export async function listGlobalActiveScans(): Promise<Array<{ id: string; status: ScanStatus }>> {
  return getSystemPrisma().scan.findMany({
    where: { deletedAt: null, status: { in: [...ACTIVE_SCAN_STATUSES] } },
    select: { id: true, status: true },
  })
}

export function assertSelectedScanQueueIsolation(
  scanId: string,
  scanStatus: ScanStatus,
  scanJobs: Array<{
    id: string
    state: "waiting" | "active" | "delayed" | "prioritized"
  }>
): void {
  if (scanJobs.length === 0) {
    throw new Error("selected scan has no processable queue job; refusing failure injection")
  }
  if (scanJobs.length !== 1 || scanJobs[0]?.id !== scanId) {
    throw new Error("unexpected or ambiguous scan queue work exists; refusing failure injection")
  }
  const state = scanJobs[0].state
  const stateMatchesStatus =
    scanStatus === "QUEUED"
      ? state === "waiting" || state === "delayed" || state === "prioritized"
      : state === "active"
  if (!stateMatchesStatus) {
    throw new Error(
      `selected scan queue state ${state} does not match database status ${scanStatus}; refusing failure injection`
    )
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`step timed out after ${timeoutMs}ms`)), timeoutMs)
    }),
  ])
}

async function runStep(
  name: string,
  fn: () => Promise<string | undefined>,
  deps: LaunchAssuranceDeps,
  timeoutMs: number
): Promise<StepRecord> {
  const start = deps.now().getTime()
  try {
    const reason = await withTimeout(fn(), timeoutMs)
    return { name, status: "passed", reason, durationMs: deps.now().getTime() - start }
  } catch (error) {
    return {
      name,
      status: "failed",
      reason: boundedReason(error),
      durationMs: deps.now().getTime() - start,
    }
  }
}

async function readEgressPinArgs(
  pinFile: string,
  readFileFn: (path: string) => Promise<string>
): Promise<string[]> {
  const content = await readFileFn(pinFile)
  const args: string[] = []
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim()
    if (!line) continue
    const [host, address, port, extra] = line.split(/\s+/)
    if (!host || !address || !port || extra) {
      throw new Error(`Invalid egress pin entry: ${line}`)
    }
    args.push("--add-host", `${host}:${address}`)
  }
  return args
}

// ── Orchestrator ────────────────────────────────────────────────────────────

export async function verifyLaunchAssurance(
  options: LaunchAssuranceOptions,
  deps: LaunchAssuranceDeps
): Promise<LaunchAssuranceReceipt> {
  if (options.allowFailureInjection) assertFailureInjectionAuthorization(options)
  const mode: LaunchAssuranceReceipt["mode"] = options.allowFailureInjection
    ? "full"
    : options.allowStorageProof
      ? "storage-proof"
      : "dry-run"
  const stepTimeoutMs = options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS
  const startedAt = deps.now()
  const steps: StepRecord[] = []
  const removedContainers: string[] = []

  const provenance = deps.resolveProvenance()
  const apiBase = (
    options.apiBaseUrl ??
    env.LYRASHIELD_API_URL ??
    env.NEXT_PUBLIC_APP_URL ??
    ""
  ).replace(/\/$/, "")
  const apiKey = options.apiKey ?? env.LYRASHIELD_API_KEY

  const apiFetch = async (path: string, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = { Accept: "application/json" }
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`
    if (init?.body) headers["Content-Type"] = "application/json"
    return deps.fetch(`${apiBase}${path}`, {
      ...init,
      headers: { ...headers, ...(init?.headers ?? {}) },
    })
  }

  const dockerRemove = async (name: string): Promise<void> => {
    try {
      await deps.execFile("docker", ["rm", "-f", name])
    } catch {
      // Cleanup is best effort; the failure is recorded in the receipt only.
    }
  }

  // 1. Provenance preflight
  steps.push(
    await runStep(
      "provenance",
      async () => {
        if (provenance) {
          return `${provenance.productRevision} / ${provenance.workerImageDigest} / ${provenance.engineRevision}`
        }
        if (mode === "dry-run") {
          return "non-production dry run: exact worker provenance not required"
        }
        throw new Error("exact worker execution provenance is required")
      },
      deps,
      stepTimeoutMs
    )
  )

  // 2. Readiness
  steps.push(
    await runStep(
      "readiness",
      async () => {
        if (!apiBase) throw new Error("no API base URL configured for the readiness probe")
        const response = await deps.fetch(`${apiBase}/api/ready/scans`, {
          signal: AbortSignal.timeout(stepTimeoutMs),
        })
        const body = await response.text()
        if (response.status !== 200 || !body.includes("ready")) {
          throw new Error(`scan readiness is not ready (HTTP ${response.status})`)
        }
        return `HTTP ${response.status}`
      },
      deps,
      stepTimeoutMs
    )
  )

  // 3. Azure alert/action-group readback (read-only)
  const azureResourceGroup = options.azureResourceGroup ?? env.AZURE_RESOURCE_GROUP
  if (!azureResourceGroup && mode === "dry-run") {
    steps.push({
      name: "azure_alert_readback",
      status: "skipped",
      reason: "AZURE_RESOURCE_GROUP not configured; alert readback skipped in dry run",
      durationMs: 0,
    })
  } else {
    steps.push(
      await runStep(
        "azure_alert_readback",
        async () => {
          const resourceGroup = azureResourceGroup
          if (!resourceGroup) {
            throw new Error("AZURE_RESOURCE_GROUP is not configured; cannot verify alert rules")
          }
          const groupId = (
            await deps.execFile("az", [
              "monitor",
              "action-group",
              "show",
              "--name",
              OPERATOR_ACTION_GROUP,
              "--resource-group",
              resourceGroup,
              "--query",
              "id",
              "-o",
              "tsv",
            ])
          ).stdout.trim()
          if (!groupId) throw new Error("operator action group readback returned no resource id")

          const [metricOut, scheduledOut] = await Promise.all([
            deps.execFile("az", [
              "monitor",
              "metrics",
              "alert",
              "list",
              "--resource-group",
              resourceGroup,
              "--output",
              "json",
            ]),
            deps.execFile("az", [
              "monitor",
              "scheduled-query",
              "list",
              "--resource-group",
              resourceGroup,
              "--output",
              "json",
            ]),
          ])
          const metricRules = JSON.parse(metricOut.stdout || "[]") as Array<{
            name?: string
            enabled?: boolean
            actions?: Array<{ actionGroupId?: string }>
          }>
          const scheduledRules = JSON.parse(scheduledOut.stdout || "[]") as Array<{
            name?: string
            enabled?: boolean
            autoMitigate?: boolean
            actions?: { actionGroups?: string[] }
          }>

          const missing: string[] = []
          for (const expected of EXPECTED_METRIC_ALERT_RULES) {
            const rule = metricRules.find((item) => item.name === expected)
            if (!rule) {
              missing.push(expected)
              continue
            }
            if (rule.enabled !== true || rule.actions?.[0]?.actionGroupId !== groupId) {
              throw new Error(`${expected} is not enabled and bound to ${OPERATOR_ACTION_GROUP}`)
            }
          }
          for (const expected of EXPECTED_SCHEDULED_QUERY_RULES) {
            const rule = scheduledRules.find((item) => item.name === expected)
            if (!rule) {
              missing.push(expected)
              continue
            }
            const bound =
              rule.enabled === true &&
              rule.autoMitigate === true &&
              (rule.actions?.actionGroups ?? []).includes(groupId)
            if (!bound) {
              throw new Error(
                `${expected} is not enabled, auto-mitigating, and bound to ${OPERATOR_ACTION_GROUP}`
              )
            }
          }
          if (missing.length > 0) throw new Error(`missing alert rules: ${missing.join(", ")}`)
          return `${EXPECTED_METRIC_ALERT_RULES.length} metric + ${EXPECTED_SCHEDULED_QUERY_RULES.length} scheduled rules bound`
        },
        deps,
        stepTimeoutMs
      )
    )
  }

  // 4 + 5. Evidence storage proofs (mutation; disposable containers only)
  const storageContainerNames: string[] = []
  const storageDockerArgs = async (network: string, entrypoint: string): Promise<string[]> => {
    if (!options.workerImage || !options.workerEnvFile) {
      throw new Error("storage proof requires --worker-image and --worker-env-file")
    }
    const args = [
      "run",
      "--rm",
      "--name",
      `lyrashield-launch-proof-${randomUUID()}`,
      "--network",
      network,
      "--env-file",
      options.workerEnvFile,
      "--env",
      "NODE_ENV=production",
      "--env",
      "LYRASHIELD_LOCAL_EVIDENCE_STORAGE=0",
      "--env",
      "PLATFORM_ADMIN_EMAILS=ecryptoguru@gmail.com,ankit@lyrashieldai.com",
      "--env",
      "LYRASHIELD_REQUIRE_EMAIL_VERIFICATION=0",
    ]
    if (network === "bridge" && options.egressPinFile) {
      args.push(...(await readEgressPinArgs(options.egressPinFile, deps.readFile)))
    }
    args.push(
      "--entrypoint",
      "./apps/worker/node_modules/.bin/tsx",
      options.workerImage,
      entrypoint
    )
    return args
  }

  const runStorageProof = async (
    name: string,
    network: string,
    entrypoint: string,
    marker: string
  ): Promise<StepRecord> => {
    const start = deps.now().getTime()
    try {
      const args = await storageDockerArgs(network, entrypoint)
      const containerName = args[args.indexOf("--name") + 1]!
      storageContainerNames.push(containerName)
      const result = await withTimeout(
        deps.execFile("docker", args).then(async (output) => {
          if (!output.stdout.includes(marker)) {
            throw new Error(`${name} did not print ${marker}`)
          }
          await dockerRemove(containerName)
          removedContainers.push(containerName)
          return marker
        }),
        stepTimeoutMs
      )
      return { name, status: "passed", reason: result, durationMs: deps.now().getTime() - start }
    } catch (error) {
      return {
        name,
        status: "failed",
        reason: boundedReason(error),
        durationMs: deps.now().getTime() - start,
      }
    }
  }

  const finalizeReceipt = async (): Promise<LaunchAssuranceReceipt> => {
    for (const name of storageContainerNames) {
      if (!removedContainers.includes(name)) {
        await dockerRemove(name)
        removedContainers.push(name)
      }
    }
    const failed = steps.some((step) => step.status === "failed")
    const overall: LaunchAssuranceReceipt["overall"] =
      mode === "dry-run" ? (failed ? "failed" : "preflight_passed") : failed ? "failed" : "passed"
    return {
      mode,
      timestamp: startedAt.toISOString(),
      productRevision: provenance?.productRevision ?? null,
      workerImageDigest: provenance?.workerImageDigest ?? null,
      engineRevision: provenance?.engineRevision ?? null,
      ...(options.scanId ? { scanId: options.scanId } : {}),
      ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
      ...(options.incidentCommander ? { incidentCommander: options.incidentCommander } : {}),
      steps,
      overall,
      cleanup: { removedContainers: [...removedContainers].sort() },
      durationMs: deps.now().getTime() - startedAt.getTime(),
    }
  }

  const readOnlyGateFailure = steps.find((step) => step.status === "failed")
  if (mode === "dry-run") {
    steps.push({
      name: "storage_fail_closed_proof",
      status: "skipped",
      reason: "dry run: no mutation",
      durationMs: 0,
    })
    steps.push({
      name: "storage_round_trip_proof",
      status: "skipped",
      reason: "dry run: no mutation",
      durationMs: 0,
    })
  } else if (readOnlyGateFailure) {
    for (const name of ["storage_fail_closed_proof", "storage_round_trip_proof"]) {
      steps.push({
        name,
        status: "skipped",
        reason: `required prior gate failed: ${readOnlyGateFailure.name}`,
        durationMs: 0,
      })
    }
  } else {
    const failClosedProof = await runStorageProof(
      "storage_fail_closed_proof",
      "none",
      "apps/worker/src/operations/verify-evidence-storage-fail-closed.ts",
      "EVIDENCE_STORAGE_FAIL_CLOSED_OK"
    )
    steps.push(failClosedProof)
    if (failClosedProof.status === "failed") {
      steps.push({
        name: "storage_round_trip_proof",
        status: "skipped",
        reason: "storage fail-closed proof failed",
        durationMs: 0,
      })
    } else {
      steps.push(
        await runStorageProof(
          "storage_round_trip_proof",
          "bridge",
          "apps/worker/src/operations/verify-evidence-storage.ts",
          "EVIDENCE_STORAGE_PROOF_OK"
        )
      )
    }
  }

  if (mode !== "full") {
    const reason =
      mode === "dry-run"
        ? "dry run: no mutation"
        : "storage proof: failure injection not authorized"
    for (const name of [
      "failure_injection_preflight",
      "authenticated_cancellation",
      "settle_wait",
      "queue_recovery",
      "post_recovery_readiness",
    ]) {
      steps.push({ name, status: "skipped", reason, durationMs: 0 })
    }
  } else {
    // 6. Failure-injection preflight
    const priorFailure = steps.find((step) => step.status === "failed")
    const failureInjectionPreflight: StepRecord = priorFailure
      ? {
          name: "failure_injection_preflight",
          status: "failed",
          reason: `required prior gate failed: ${priorFailure.name}`,
          durationMs: 0,
        }
      : await runStep(
          "failure_injection_preflight",
          async () => {
            if (mode !== "full") throw new Error("failure injection requires full mode")
            const scanId = options.scanId!
            const workspaceId = options.workspaceId!
            const scan = await apiFetch(
              `/api/v1/scans/${encodeURIComponent(scanId)}?workspaceId=${encodeURIComponent(workspaceId)}`
            ).then(async (response) => {
              const body = (await response.json()) as {
                success?: boolean
                data?: { id: string; workspaceId: string; status: ScanStatus }
              }
              if (response.status !== 200 || body.success !== true || !body.data) {
                throw new Error(`could not read scan ${scanId} (HTTP ${response.status})`)
              }
              return body.data
            })
            if (scan.workspaceId !== workspaceId) {
              throw new Error("scan does not belong to the supplied workspace")
            }
            if (TERMINAL_SCAN_STATUSES.has(scan.status)) {
              throw new Error(`scan is already terminal (${scan.status})`)
            }
            if (!ACTIVE_SCAN_STATUSES.has(scan.status)) {
              throw new Error(`scan is in an ambiguous state (${scan.status}); refusing injection`)
            }
            const active = await deps.listActiveScans()
            const unrelated = active.filter((item) => item.id !== scanId)
            if (unrelated.length > 0) {
              throw new Error(
                `refusing failure injection: ${unrelated.length} unrelated active scan(s) exist`
              )
            }
            const selectedActive = active.find((item) => item.id === scanId)
            if (!selectedActive || selectedActive.status !== scan.status) {
              throw new Error(
                "selected scan state changed during preflight; refusing failure injection"
              )
            }
            const operationalState = await deps.getFailureInjectionOperationalState()
            if (!operationalState.admissionStopped) {
              throw new Error("scan admission is not stopped; refusing failure injection")
            }
            if (operationalState.enabledScheduleCount !== 0) {
              throw new Error("enabled schedules exist; refusing failure injection")
            }
            assertSelectedScanQueueIsolation(scanId, scan.status, operationalState.scanJobs)
            if (operationalState.webhookQueueDepth !== 0) {
              throw new Error("webhook queue work exists; refusing failure injection")
            }
            if (await deps.hasTerminalCostUncertainty(deps.now())) {
              throw new Error(
                "terminal provider cost uncertainty exists; refusing failure injection"
              )
            }
            return `scan ${scanId} (${scan.status}) is isolated for injection`
          },
          deps,
          stepTimeoutMs
        )
    steps.push(failureInjectionPreflight)

    if (failureInjectionPreflight.status === "failed") {
      for (const name of [
        "authenticated_cancellation",
        "settle_wait",
        "queue_recovery",
        "post_recovery_readiness",
      ]) {
        steps.push({
          name,
          status: "skipped",
          reason: "failure-injection preflight failed",
          durationMs: 0,
        })
      }
      return finalizeReceipt()
    }

    // 7. Authenticated cancellation
    const cancelStartedAt = deps.now()
    const cancellation = await runStep(
      "authenticated_cancellation",
      async () => {
        if (mode !== "full") throw new Error("cancellation requires full mode")
        const scanId = options.scanId!
        const workspaceId = options.workspaceId!
        const response = await apiFetch(`/api/v1/scans/${encodeURIComponent(scanId)}`, {
          method: "POST",
          body: JSON.stringify({ workspaceId }),
        })
        const body = (await response.json()) as {
          success?: boolean
          data?: { id: string; status: string }
        }
        if (response.status !== 200 || body.success !== true || !body.data) {
          throw new Error(`authenticated cancellation failed (HTTP ${response.status})`)
        }
        if (body.data.status !== "CANCELLED") {
          throw new Error(`cancellation did not reach CANCELLED (${body.data.status})`)
        }
        return `scan ${scanId} cancelled`
      },
      deps,
      stepTimeoutMs
    )
    steps.push(cancellation)
    if (cancellation.status === "failed") {
      for (const name of ["settle_wait", "queue_recovery", "post_recovery_readiness"]) {
        steps.push({
          name,
          status: "skipped",
          reason: "authenticated cancellation failed",
          durationMs: 0,
        })
      }
      return finalizeReceipt()
    }

    // 8. Terminal/queue-settle wait
    const settle = await runStep(
      "settle_wait",
      async () => {
        if (mode !== "full") throw new Error("settle wait requires full mode")
        const scanId = options.scanId!
        const workspaceId = options.workspaceId!
        const deadline = deps.now().getTime() + SETTLE_TIMEOUT_MS
        let state = await deps.getScanState(scanId, workspaceId)
        while (!TERMINAL_SCAN_STATUSES.has(state.status) && deps.now().getTime() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS))
          state = await deps.getScanState(scanId, workspaceId)
        }
        if (!TERMINAL_SCAN_STATUSES.has(state.status)) {
          throw new Error(`scan did not settle to a terminal state within ${SETTLE_TIMEOUT_MS}ms`)
        }
        const engineStarts = await deps.countEngineStartsSince(scanId, workspaceId, cancelStartedAt)
        if (engineStarts > 0) {
          throw new Error(`${engineStarts} engine_start event(s) appeared after cancellation`)
        }
        return `terminal state ${state.status}; no post-cancellation engine starts`
      },
      deps,
      stepTimeoutMs
    )
    steps.push(settle)
    if (settle.status === "failed") {
      for (const name of ["queue_recovery", "post_recovery_readiness"]) {
        steps.push({
          name,
          status: "skipped",
          reason: "settle wait failed",
          durationMs: 0,
        })
      }
      return finalizeReceipt()
    }

    // 9. Queue recovery through the shared reconciliation authority
    const queueRecovery = await runStep(
      "queue_recovery",
      async () => {
        if (mode !== "full") throw new Error("queue recovery requires full mode")
        const result = await deps.reconcile()
        if (!result.leaseAcquired) {
          throw new Error("queue reconciliation lease was not acquired")
        }
        return `drift=${result.failedOrphanedScans + result.removedOrphanedJobs} queueDepth=${result.queueDepth}`
      },
      deps,
      stepTimeoutMs
    )
    steps.push(queueRecovery)
    if (queueRecovery.status === "failed") {
      steps.push({
        name: "post_recovery_readiness",
        status: "skipped",
        reason: "queue recovery failed",
        durationMs: 0,
      })
      return finalizeReceipt()
    }

    // 10. Post-recovery readiness
    steps.push(
      await runStep(
        "post_recovery_readiness",
        async () => {
          if (!apiBase) throw new Error("no API base URL configured for the readiness probe")
          const response = await deps.fetch(`${apiBase}/api/ready/scans`, {
            signal: AbortSignal.timeout(stepTimeoutMs),
          })
          const body = await response.text()
          if (response.status !== 200 || !body.includes("ready")) {
            throw new Error(`scan readiness not restored (HTTP ${response.status})`)
          }
          return "readiness restored"
        },
        deps,
        stepTimeoutMs
      )
    )
  }

  return finalizeReceipt()
}

// ── CLI entrypoint ──────────────────────────────────────────────────────────

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // pnpm forwards a literal "--" before the script args in some shells.
  const forwardedArgs = process.argv.slice(2)
  const args = forwardedArgs[0] === "--" ? forwardedArgs.slice(1) : forwardedArgs
  const { values } = parseArgs({
    args,
    options: {
      "dry-run": { type: "boolean", default: false },
      "allow-storage-proof": { type: "boolean", default: false },
      "worker-image": { type: "string" },
      "worker-env-file": { type: "string" },
      "egress-pin-file": { type: "string" },
      "allow-failure-injection": { type: "boolean", default: false },
      "scan-id": { type: "string" },
      "workspace-id": { type: "string" },
      environment: { type: "string" },
      "confirm-production": { type: "string" },
      "incident-commander": { type: "string" },
      "azure-resource-group": { type: "string" },
    },
    strict: true,
  })

  const deps: LaunchAssuranceDeps = {
    fetch: globalThis.fetch,
    execFile: async (command, args) => {
      const { stdout, stderr } = await nodeExecFileAsync(command, args, {
        timeout: DEFAULT_STEP_TIMEOUT_MS,
      })
      return { stdout: String(stdout), stderr: String(stderr) }
    },
    now: () => new Date(),
    // The pin file path is operator-supplied CLI configuration, not attacker input.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    readFile: async (path) => readFile(path, "utf8"),
    reconcile: reconcileScanQueue,
    listActiveScans: listGlobalActiveScans,
    getScanState: async (scanId, workspaceId) => {
      const scan = await prisma.scan.findFirst({
        where: { id: scanId, workspaceId, deletedAt: null },
        select: { id: true, workspaceId: true, status: true },
      })
      if (!scan) throw new Error(`scan not found: ${scanId}`)
      return scan
    },
    countEngineStartsSince: async (scanId, workspaceId, since) =>
      withWorkspaceRLS(workspaceId, (tx) =>
        tx.scanEvent.count({
          where: { scanId, stage: "engine_start", createdAt: { gt: since }, deletedAt: null },
        })
      ),
    hasTerminalCostUncertainty: async (now) =>
      (await findOldestTerminalUnreconciledCost(now)) !== null,
    resolveProvenance: resolveWorkerExecutionProvenance,
    getFailureInjectionOperationalState: async () => {
      const redis = getRedis()
      if (!redis) throw new Error("REDIS_URL is required for failure-injection preflight")
      const scanQueue = getScanQueue()
      const webhookQueue = getWebhookTrackRetryQueue()
      const [
        admissionStopped,
        enabledScheduleCount,
        waitingJobs,
        activeJobs,
        delayedJobs,
        prioritizedJobs,
        webhookCounts,
      ] = await Promise.all([
        redis.exists(SCAN_ADMISSION_STOP_KEY),
        getSystemPrisma().schedule.count({ where: { enabled: true } }),
        scanQueue.getJobs(["wait"], 0, -1, true),
        scanQueue.getJobs(["active"], 0, -1, true),
        scanQueue.getJobs(["delayed"], 0, -1, true),
        scanQueue.getJobs(["prioritized"], 0, -1, true),
        webhookQueue.getJobCounts("wait", "active", "delayed", "prioritized"),
      ])
      return {
        admissionStopped: admissionStopped === 1,
        enabledScheduleCount,
        scanJobs: [
          ...waitingJobs.map((job) => ({ id: String(job.id ?? ""), state: "waiting" as const })),
          ...activeJobs.map((job) => ({ id: String(job.id ?? ""), state: "active" as const })),
          ...delayedJobs.map((job) => ({ id: String(job.id ?? ""), state: "delayed" as const })),
          ...prioritizedJobs.map((job) => ({
            id: String(job.id ?? ""),
            state: "prioritized" as const,
          })),
        ],
        webhookQueueDepth: Object.values(webhookCounts).reduce((sum, count) => sum + count, 0),
      }
    },
  }

  try {
    const options = parseLaunchAssuranceOptions(values)
    verifyLaunchAssurance(options, deps)
      .then((receipt) => {
        console.log(JSON.stringify(receipt, null, 2))
        process.exit(receipt.overall === "failed" ? 1 : 0)
      })
      .catch((error) => {
        console.error(error instanceof Error ? error.message : String(error))
        process.exit(2)
      })
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(2)
  }
}
