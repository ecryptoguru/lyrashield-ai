import { randomUUID } from "node:crypto"
import type { ScanStatus } from "@lyrashield/db"
import { env, type WorkerExecutionProvenance } from "@lyrashield/config"
import {
  ACTIVE_SCAN_STATUSES,
  EXPECTED_METRIC_ALERT_RULES,
  EXPECTED_SCHEDULED_QUERY_RULES,
  OPERATOR_ACTION_GROUP,
  SETTLE_POLL_MS,
  SETTLE_TIMEOUT_MS,
  TERMINAL_SCAN_STATUSES,
  type LaunchAssuranceDeps,
  type LaunchAssuranceOptions,
  type LaunchAssuranceReceipt,
  type StepRecord,
} from "./verify-launch-assurance-contract"
import {
  assertSelectedScanQueueIsolation,
  boundedReason,
  readEgressPinArgs,
  runStep,
  withTimeout,
} from "./verify-launch-assurance-steps"

/**
 * Shared per-run state passed to every phase. Created once by
 * verify-launch-assurance-run.ts; phases read inputs and append StepRecords.
 */
export interface LaunchAssuranceRunContext {
  options: LaunchAssuranceOptions
  deps: LaunchAssuranceDeps
  mode: LaunchAssuranceReceipt["mode"]
  stepTimeoutMs: number
  startedAt: Date
  provenance: WorkerExecutionProvenance | null
  apiBase: string
  apiKey: string | undefined
  steps: StepRecord[]
  removedContainers: string[]
  storageContainerNames: string[]
}

export function apiFetch(
  ctx: LaunchAssuranceRunContext,
  path: string,
  init?: RequestInit
): Promise<Response> {
  const headers: Record<string, string> = { Accept: "application/json" }
  if (ctx.apiKey) headers.Authorization = `Bearer ${ctx.apiKey}`
  if (init?.body) headers["Content-Type"] = "application/json"
  return ctx.deps.fetch(`${ctx.apiBase}${path}`, {
    ...init,
    headers: { ...headers, ...(init?.headers ?? {}) },
  })
}

async function dockerRemove(ctx: LaunchAssuranceRunContext, name: string): Promise<void> {
  try {
    await ctx.deps.execFile("docker", ["rm", "-f", name])
  } catch {
    // Cleanup is best effort; the failure is recorded in the receipt only.
  }
}

function pushSkippedSteps(ctx: LaunchAssuranceRunContext, names: string[], reason: string): void {
  for (const name of names) {
    ctx.steps.push({ name, status: "skipped", reason, durationMs: 0 })
  }
}

// ── Read-only gates ─────────────────────────────────────────────────────────

/** Step 1: exact worker execution provenance. */
export async function runProvenanceStep(ctx: LaunchAssuranceRunContext): Promise<void> {
  ctx.steps.push(
    await runStep(
      "provenance",
      async () => {
        if (ctx.provenance) {
          return `${ctx.provenance.productRevision} / ${ctx.provenance.workerImageDigest} / ${ctx.provenance.engineRevision}`
        }
        if (ctx.mode === "dry-run") {
          return "non-production dry run: exact worker provenance not required"
        }
        throw new Error("exact worker execution provenance is required")
      },
      ctx.deps,
      ctx.stepTimeoutMs
    )
  )
}

/** Step 2: scan readiness probe against the app API. */
export async function runReadinessStep(ctx: LaunchAssuranceRunContext): Promise<void> {
  ctx.steps.push(
    await runStep(
      "readiness",
      async () => {
        if (!ctx.apiBase) throw new Error("no API base URL configured for the readiness probe")
        const response = await ctx.deps.fetch(`${ctx.apiBase}/api/ready/scans`, {
          signal: AbortSignal.timeout(ctx.stepTimeoutMs),
        })
        const body = await response.text()
        if (response.status !== 200 || !body.includes("ready")) {
          throw new Error(`scan readiness is not ready (HTTP ${response.status})`)
        }
        return `HTTP ${response.status}`
      },
      ctx.deps,
      ctx.stepTimeoutMs
    )
  )
}

async function readAlertRules(
  ctx: LaunchAssuranceRunContext,
  resourceGroup: string,
  groupId: string
): Promise<string> {
  const [metricOut, scheduledOut] = await Promise.all([
    ctx.deps.execFile("az", [
      "monitor",
      "metrics",
      "alert",
      "list",
      "--resource-group",
      resourceGroup,
      "--output",
      "json",
    ]),
    ctx.deps.execFile("az", [
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
}

/** Step 3: Azure alert/action-group readback (read-only). */
export async function runAzureAlertReadbackStep(ctx: LaunchAssuranceRunContext): Promise<void> {
  const azureResourceGroup = ctx.options.azureResourceGroup ?? env.AZURE_RESOURCE_GROUP
  if (!azureResourceGroup && ctx.mode === "dry-run") {
    ctx.steps.push({
      name: "azure_alert_readback",
      status: "skipped",
      reason: "AZURE_RESOURCE_GROUP not configured; alert readback skipped in dry run",
      durationMs: 0,
    })
    return
  }
  ctx.steps.push(
    await runStep(
      "azure_alert_readback",
      async () => {
        const resourceGroup = azureResourceGroup
        if (!resourceGroup) {
          throw new Error("AZURE_RESOURCE_GROUP is not configured; cannot verify alert rules")
        }
        const groupId = (
          await ctx.deps.execFile("az", [
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
        return readAlertRules(ctx, resourceGroup, groupId)
      },
      ctx.deps,
      ctx.stepTimeoutMs
    )
  )
}

// ── Evidence storage proofs (mutation; disposable containers only) ──────────

async function storageDockerArgs(
  ctx: LaunchAssuranceRunContext,
  network: string,
  entrypoint: string
): Promise<string[]> {
  const { options } = ctx
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
    args.push(...(await readEgressPinArgs(options.egressPinFile, ctx.deps.readFile)))
  }
  args.push("--entrypoint", "./apps/worker/node_modules/.bin/tsx", options.workerImage, entrypoint)
  return args
}

async function runStorageProof(
  ctx: LaunchAssuranceRunContext,
  name: string,
  network: string,
  entrypoint: string,
  marker: string
): Promise<StepRecord> {
  const start = ctx.deps.now().getTime()
  try {
    const args = await storageDockerArgs(ctx, network, entrypoint)
    const containerName = args[args.indexOf("--name") + 1]!
    ctx.storageContainerNames.push(containerName)
    const result = await withTimeout(
      ctx.deps.execFile("docker", args).then(async (output) => {
        if (!output.stdout.includes(marker)) {
          throw new Error(`${name} did not print ${marker}`)
        }
        await dockerRemove(ctx, containerName)
        ctx.removedContainers.push(containerName)
        return marker
      }),
      ctx.stepTimeoutMs
    )
    return { name, status: "passed", reason: result, durationMs: ctx.deps.now().getTime() - start }
  } catch (error) {
    return {
      name,
      status: "failed",
      reason: boundedReason(error),
      durationMs: ctx.deps.now().getTime() - start,
    }
  }
}

/** Steps 4 + 5: fail-closed then round-trip evidence storage proofs. */
export async function runStorageProofPhase(ctx: LaunchAssuranceRunContext): Promise<void> {
  const readOnlyGateFailure = ctx.steps.find((step) => step.status === "failed")
  if (ctx.mode === "dry-run") {
    pushSkippedSteps(
      ctx,
      ["storage_fail_closed_proof", "storage_round_trip_proof"],
      "dry run: no mutation"
    )
    return
  }
  if (readOnlyGateFailure) {
    pushSkippedSteps(
      ctx,
      ["storage_fail_closed_proof", "storage_round_trip_proof"],
      `required prior gate failed: ${readOnlyGateFailure.name}`
    )
    return
  }
  const failClosedProof = await runStorageProof(
    ctx,
    "storage_fail_closed_proof",
    "none",
    "apps/worker/src/operations/verify-evidence-storage-fail-closed.ts",
    "EVIDENCE_STORAGE_FAIL_CLOSED_OK"
  )
  ctx.steps.push(failClosedProof)
  if (failClosedProof.status === "failed") {
    pushSkippedSteps(ctx, ["storage_round_trip_proof"], "storage fail-closed proof failed")
    return
  }
  ctx.steps.push(
    await runStorageProof(
      ctx,
      "storage_round_trip_proof",
      "bridge",
      "apps/worker/src/operations/verify-evidence-storage.ts",
      "EVIDENCE_STORAGE_PROOF_OK"
    )
  )
}

// ── Failure-injection sequence (full mode only) ─────────────────────────────

const MUTATION_STEP_NAMES = [
  "failure_injection_preflight",
  "authenticated_cancellation",
  "settle_wait",
  "queue_recovery",
  "post_recovery_readiness",
] as const

async function readSelectedScan(ctx: LaunchAssuranceRunContext): Promise<{
  id: string
  workspaceId: string
  status: ScanStatus
}> {
  const scanId = ctx.options.scanId!
  const workspaceId = ctx.options.workspaceId!
  const scan = await apiFetch(
    ctx,
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
  return scan
}

async function assertInjectionIsolation(
  ctx: LaunchAssuranceRunContext,
  scan: { id: string; status: ScanStatus }
): Promise<void> {
  const scanId = ctx.options.scanId!
  const active = await ctx.deps.listActiveScans()
  const unrelated = active.filter((item) => item.id !== scanId)
  if (unrelated.length > 0) {
    throw new Error(
      `refusing failure injection: ${unrelated.length} unrelated active scan(s) exist`
    )
  }
  const selectedActive = active.find((item) => item.id === scanId)
  if (!selectedActive || selectedActive.status !== scan.status) {
    throw new Error("selected scan state changed during preflight; refusing failure injection")
  }
  const operationalState = await ctx.deps.getFailureInjectionOperationalState()
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
  if (await ctx.deps.hasTerminalCostUncertainty(ctx.deps.now())) {
    throw new Error("terminal provider cost uncertainty exists; refusing failure injection")
  }
}

/** Step 6: full-mode failure-injection preflight. */
async function failureInjectionPreflightStep(ctx: LaunchAssuranceRunContext): Promise<StepRecord> {
  const priorFailure = ctx.steps.find((step) => step.status === "failed")
  if (priorFailure) {
    return {
      name: "failure_injection_preflight",
      status: "failed",
      reason: `required prior gate failed: ${priorFailure.name}`,
      durationMs: 0,
    }
  }
  return runStep(
    "failure_injection_preflight",
    async () => {
      if (ctx.mode !== "full") throw new Error("failure injection requires full mode")
      const scan = await readSelectedScan(ctx)
      await assertInjectionIsolation(ctx, scan)
      return `scan ${scan.id} (${scan.status}) is isolated for injection`
    },
    ctx.deps,
    ctx.stepTimeoutMs
  )
}

/** Step 7: authenticated scan cancellation through the app API. */
async function authenticatedCancellationStep(ctx: LaunchAssuranceRunContext): Promise<StepRecord> {
  return runStep(
    "authenticated_cancellation",
    async () => {
      if (ctx.mode !== "full") throw new Error("cancellation requires full mode")
      const scanId = ctx.options.scanId!
      const workspaceId = ctx.options.workspaceId!
      const response = await apiFetch(ctx, `/api/v1/scans/${encodeURIComponent(scanId)}`, {
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
    ctx.deps,
    ctx.stepTimeoutMs
  )
}

/** Step 8: terminal/queue-settle wait with post-cancellation engine-start audit. */
async function settleWaitStep(
  ctx: LaunchAssuranceRunContext,
  cancelStartedAt: Date
): Promise<StepRecord> {
  return runStep(
    "settle_wait",
    async () => {
      if (ctx.mode !== "full") throw new Error("settle wait requires full mode")
      const scanId = ctx.options.scanId!
      const workspaceId = ctx.options.workspaceId!
      const deadline = ctx.deps.now().getTime() + SETTLE_TIMEOUT_MS
      let state = await ctx.deps.getScanState(scanId, workspaceId)
      while (!TERMINAL_SCAN_STATUSES.has(state.status) && ctx.deps.now().getTime() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS))
        state = await ctx.deps.getScanState(scanId, workspaceId)
      }
      if (!TERMINAL_SCAN_STATUSES.has(state.status)) {
        throw new Error(`scan did not settle to a terminal state within ${SETTLE_TIMEOUT_MS}ms`)
      }
      const engineStarts = await ctx.deps.countEngineStartsSince(
        scanId,
        workspaceId,
        cancelStartedAt
      )
      if (engineStarts > 0) {
        throw new Error(`${engineStarts} engine_start event(s) appeared after cancellation`)
      }
      return `terminal state ${state.status}; no post-cancellation engine starts`
    },
    ctx.deps,
    // The settle loop has its own 120-second deadline. Leave the normal
    // per-step allowance for its final state and engine-start readback.
    SETTLE_TIMEOUT_MS + ctx.stepTimeoutMs
  )
}

/** Step 9: queue recovery through the shared reconciliation authority. */
async function queueRecoveryStep(ctx: LaunchAssuranceRunContext): Promise<StepRecord> {
  return runStep(
    "queue_recovery",
    async () => {
      if (ctx.mode !== "full") throw new Error("queue recovery requires full mode")
      const result = await ctx.deps.reconcile()
      if (!result.leaseAcquired) {
        throw new Error("queue reconciliation lease was not acquired")
      }
      return `drift=${result.failedOrphanedScans + result.removedOrphanedJobs} queueDepth=${result.queueDepth}`
    },
    ctx.deps,
    ctx.stepTimeoutMs
  )
}

/** Step 10: post-recovery readiness probe. */
async function postRecoveryReadinessStep(ctx: LaunchAssuranceRunContext): Promise<StepRecord> {
  return runStep(
    "post_recovery_readiness",
    async () => {
      if (!ctx.apiBase) throw new Error("no API base URL configured for the readiness probe")
      const response = await ctx.deps.fetch(`${ctx.apiBase}/api/ready/scans`, {
        signal: AbortSignal.timeout(ctx.stepTimeoutMs),
      })
      const body = await response.text()
      if (response.status !== 200 || !body.includes("ready")) {
        throw new Error(`scan readiness not restored (HTTP ${response.status})`)
      }
      return "readiness restored"
    },
    ctx.deps,
    ctx.stepTimeoutMs
  )
}

/** Steps 6–10: skipped outside full mode; sequential with fail-fast skips inside. */
export async function runFailureInjectionPhase(ctx: LaunchAssuranceRunContext): Promise<void> {
  if (ctx.mode !== "full") {
    const reason =
      ctx.mode === "dry-run"
        ? "dry run: no mutation"
        : "storage proof: failure injection not authorized"
    pushSkippedSteps(ctx, [...MUTATION_STEP_NAMES], reason)
    return
  }

  const preflight = await failureInjectionPreflightStep(ctx)
  ctx.steps.push(preflight)
  if (preflight.status === "failed") {
    pushSkippedSteps(
      ctx,
      ["authenticated_cancellation", "settle_wait", "queue_recovery", "post_recovery_readiness"],
      "failure-injection preflight failed"
    )
    return
  }

  const cancelStartedAt = ctx.deps.now()
  const cancellation = await authenticatedCancellationStep(ctx)
  ctx.steps.push(cancellation)
  if (cancellation.status === "failed") {
    pushSkippedSteps(
      ctx,
      ["settle_wait", "queue_recovery", "post_recovery_readiness"],
      "authenticated cancellation failed"
    )
    return
  }

  const settle = await settleWaitStep(ctx, cancelStartedAt)
  ctx.steps.push(settle)
  if (settle.status === "failed") {
    pushSkippedSteps(ctx, ["queue_recovery", "post_recovery_readiness"], "settle wait failed")
    return
  }

  const queueRecovery = await queueRecoveryStep(ctx)
  ctx.steps.push(queueRecovery)
  if (queueRecovery.status === "failed") {
    pushSkippedSteps(ctx, ["post_recovery_readiness"], "queue recovery failed")
    return
  }

  ctx.steps.push(await postRecoveryReadinessStep(ctx))
}

/** Remove leftover proof containers and assemble the final receipt. */
export async function finalizeReceipt(
  ctx: LaunchAssuranceRunContext
): Promise<LaunchAssuranceReceipt> {
  for (const name of ctx.storageContainerNames) {
    if (!ctx.removedContainers.includes(name)) {
      await dockerRemove(ctx, name)
      ctx.removedContainers.push(name)
    }
  }
  const failed = ctx.steps.some((step) => step.status === "failed")
  const overall: LaunchAssuranceReceipt["overall"] =
    ctx.mode === "dry-run" ? (failed ? "failed" : "preflight_passed") : failed ? "failed" : "passed"
  return {
    mode: ctx.mode,
    timestamp: ctx.startedAt.toISOString(),
    productRevision: ctx.provenance?.productRevision ?? null,
    workerImageDigest: ctx.provenance?.workerImageDigest ?? null,
    engineRevision: ctx.provenance?.engineRevision ?? null,
    ...(ctx.options.scanId ? { scanId: ctx.options.scanId } : {}),
    ...(ctx.options.workspaceId ? { workspaceId: ctx.options.workspaceId } : {}),
    ...(ctx.options.incidentCommander ? { incidentCommander: ctx.options.incidentCommander } : {}),
    steps: ctx.steps,
    overall,
    cleanup: { removedContainers: [...ctx.removedContainers].sort() },
    durationMs: ctx.deps.now().getTime() - ctx.startedAt.getTime(),
  }
}
