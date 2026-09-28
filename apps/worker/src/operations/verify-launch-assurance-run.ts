import { randomUUID } from "node:crypto"
import type { ScanStatus } from "@lyrashield/db"
import { env } from "@lyrashield/config"
import {
  ACTIVE_SCAN_STATUSES,
  DEFAULT_STEP_TIMEOUT_MS,
  EXPECTED_METRIC_ALERT_RULES,
  EXPECTED_SCHEDULED_QUERY_RULES,
  OPERATOR_ACTION_GROUP,
  SETTLE_POLL_MS,
  SETTLE_TIMEOUT_MS,
  TERMINAL_SCAN_STATUSES,
  assertFailureInjectionAuthorization,
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
