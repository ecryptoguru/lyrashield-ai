import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { execFile as nodeExecFile } from "node:child_process"
import { promisify } from "node:util"
import { pathToFileURL } from "node:url"
import { parseArgs } from "node:util"
import { prisma, type ScanStatus } from "@lyrashield/db"
import { env, resolveWorkerExecutionProvenance } from "@lyrashield/config"
import { reconcileScanQueue, type QueueReconciliationResult } from "../queue-reconciliation"

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
  listActiveScans: (workspaceId: string) => Promise<Array<{ id: string; status: ScanStatus }>>
  getScanState: (
    scanId: string,
    workspaceId: string
  ) => Promise<{
    id: string
    workspaceId: string
    status: ScanStatus
  }>
  countEngineStartsSince: (scanId: string, since: Date) => Promise<number>
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
  } else if (
    options.scanId ||
    options.workspaceId ||
    options.environment ||
    options.confirmProduction
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
  const mode: LaunchAssuranceReceipt["mode"] = options.allowFailureInjection
    ? "full"
    : options.allowStorageProof
      ? "storage-proof"
      : "dry-run"
  const stepTimeoutMs = options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS
  const startedAt = deps.now()
  const steps: StepRecord[] = []
  const removedContainers: string[] = []

  const provenance = resolveWorkerExecutionProvenance()
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
        return undefined
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
  } else {
    steps.push(
      await runStorageProof(
        "storage_fail_closed_proof",
        "none",
        "apps/worker/src/operations/verify-evidence-storage-fail-closed.ts",
        "EVIDENCE_STORAGE_FAIL_CLOSED_OK"
      )
    )
    steps.push(
      await runStorageProof(
        "storage_round_trip_proof",
        "bridge",
        "apps/worker/src/operations/verify-evidence-storage.ts",
        "EVIDENCE_STORAGE_PROOF_OK"
      )
    )
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
    steps.push(
      await runStep(
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
          const active = await deps.listActiveScans(workspaceId)
          const unrelated = active.filter((item) => item.id !== scanId)
          if (unrelated.length > 0) {
            throw new Error(
              `refusing failure injection: ${unrelated.length} unrelated active scan(s) exist`
            )
          }
          return `scan ${scanId} (${scan.status}) is isolated for injection`
        },
        deps,
        stepTimeoutMs
      )
    )

    // 7. Authenticated cancellation
    const cancelStartedAt = deps.now()
    steps.push(
      await runStep(
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
    )

    // 8. Terminal/queue-settle wait
    steps.push(
      await runStep(
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
          const engineStarts = await deps.countEngineStartsSince(scanId, cancelStartedAt)
          if (engineStarts > 0) {
            throw new Error(`${engineStarts} engine_start event(s) appeared after cancellation`)
          }
          return `terminal state ${state.status}; no post-cancellation engine starts`
        },
        deps,
        stepTimeoutMs
      )
    )

    // 9. Queue recovery through the shared reconciliation authority
    steps.push(
      await runStep(
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
    )

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

  // Cleanup: remove any containers this command created that the proof steps
  // did not already remove.
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
    steps,
    overall,
    cleanup: { removedContainers: [...removedContainers].sort() },
    durationMs: deps.now().getTime() - startedAt.getTime(),
  }
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
    listActiveScans: async (workspaceId) =>
      prisma.scan.findMany({
        where: { workspaceId, deletedAt: null, status: { in: [...ACTIVE_SCAN_STATUSES] } },
        select: { id: true, status: true },
      }),
    getScanState: async (scanId, workspaceId) => {
      const scan = await prisma.scan.findFirst({
        where: { id: scanId, workspaceId, deletedAt: null },
        select: { id: true, workspaceId: true, status: true },
      })
      if (!scan) throw new Error(`scan not found: ${scanId}`)
      return scan
    },
    countEngineStartsSince: async (scanId, since) =>
      prisma.scanEvent.count({
        where: { scanId, stage: "engine_start", createdAt: { gt: since }, deletedAt: null },
      }),
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
