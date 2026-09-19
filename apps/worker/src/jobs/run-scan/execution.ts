import { uploadEncryptedArtifact } from "@lyrashield/evidence-storage"
import { addScanEvent, prisma } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import {
  buildUrlTargetInstruction,
  buildVibeSecurityInstruction,
  normalizeDomainForProof,
} from "@lyrashield/security"
import {
  authorizeDeterministicRetest,
  checkoutDeterministicRetest,
} from "../../engine/deterministic-retest"
import {
  fetchRelayAudit,
  mintScanRelayGrant,
  registerRelayGrant,
  resolveRelayRuntimeConfig,
  resolveSpecServerHosts,
  revokeRelayGrant,
} from "../../engine/relay-client"
import {
  interpretExitCode,
  resolveEngineProfile,
  runEngine,
  type EngineRunResult,
} from "../../engine/runner"
import { resolveScanBudgetUsd, type TargetType } from "../../engine/command-builder"
import type { ScanExecutionPlan } from "@lyrashield/types"
import type { ScanJobData, ScanJobResult } from "../../types"
import { requireEngineModel, resolveEngineRuntimeBudgetMs } from "./lifecycle-utils"
import type { ScanExecutionTarget } from "./preparation"
import type { ScanTerminalError } from "./settlement"

export interface ScanPolicyConstraints {
  maxBudgetUsd: { toNumber(): number } | null
  maxDurationMinutes: number | null
  blockedPaths: string[]
  allowedDomains: string[]
  destructiveTestsAllowed: boolean
}

export type ScanExecutionResult =
  | {
      ok: true
      engineResult: EngineRunResult
      deterministicCheckout?: Awaited<ReturnType<typeof checkoutDeterministicRetest>>
      engineProfile?: ReturnType<typeof resolveEngineProfile>
      engineModel?: string
      maxBudgetUsd: number
      engineStartedAtMs: number | null
    }
  | { ok: false; result: ScanJobResult }

export async function executeScanTarget(params: {
  scanId: string
  workspaceId: string
  goal: string
  mode: ScanJobData["mode"]
  focus: ScanJobData["focus"]
  target: ScanExecutionTarget
  policy: ScanPolicyConstraints | null
  policyMaxBudgetUsd: number | undefined
  scanRuntimeBudgetMs: number
  elapsedScanMs: () => number
  isScanCancelled: (force?: boolean) => Promise<boolean>
  markGlobalScanTimeout: () => void
  markBillablePhaseStarted: () => void
  deterministicRetest: boolean
  engineBacked: boolean
  urlEngineBacked: boolean
  scanProfile: { canonicalMode: string } | null
  /** Hash-verified stored execution plan; null on legacy pre-plan rows. */
  executionPlan?: ScanExecutionPlan | null
}): Promise<ScanExecutionResult> {
  const {
    scanId,
    workspaceId,
    goal,
    mode,
    focus,
    target,
    policy,
    policyMaxBudgetUsd,
    scanRuntimeBudgetMs,
    elapsedScanMs,
    isScanCancelled,
    markGlobalScanTimeout,
    markBillablePhaseStarted,
    deterministicRetest,
    engineBacked,
    urlEngineBacked,
    scanProfile,
    executionPlan,
  } = params

  let engineResult: EngineRunResult
  let engineStartedAtMs: number | null = null
  let maxBudgetUsd = 0
  let deterministicCheckout: Awaited<ReturnType<typeof checkoutDeterministicRetest>> | undefined
  let engineProfile: ReturnType<typeof resolveEngineProfile> | undefined
  let engineModel: string | undefined

  if (deterministicRetest) {
    if (target.repoProvider !== "github") {
      throw new Error("Deterministic repository retests require a GitHub source target")
    }
    await authorizeDeterministicRetest(scanId, workspaceId, params.target.id)
    deterministicCheckout = await checkoutDeterministicRetest({
      scanId,
      repoFullName: target.repoFullName,
      branch: target.branch,
      installationId: target.installationId,
      timeoutMs: Math.max(0, scanRuntimeBudgetMs - elapsedScanMs()),
      isCancelled: isScanCancelled,
    })
    engineResult = {
      exitCode: 0,
      cancelled: false,
      timedOut: false,
      sourceCheckoutPath: deterministicCheckout.checkoutPath,
      sourceRevision: deterministicCheckout.sourceRevision,
      output: {
        vulnerabilities: [],
        runRecord: null,
        findingCount: 0,
        summary:
          "Deterministic repository retest completed; model analysis was outside this retest scope.",
        findingsComplete: true,
        ingestionIssues: [],
        scopedCoverage: null,
        threatModels: null,
        httpExchangeExport: null,
      },
    }
    try {
      await addScanEvent(
        scanId,
        "engine_skipped",
        "info",
        "Deterministic repository retest uses an independent checkout and no model calls"
      )
    } catch (error) {
      // Ownership has not reached the job finalizer yet. Clean locally so an
      // event-write failure cannot strand the independent retest checkout.
      await deterministicCheckout.cleanup().catch((cleanupError) => {
        logger.error("Failed to clean deterministic retest checkout after event failure", {
          scanId,
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        })
      })
      throw error
    }
  } else if (engineBacked) {
    maxBudgetUsd = resolveScanBudgetUsd(mode, policyMaxBudgetUsd, target.type)
    if (maxBudgetUsd <= 0) {
      const errorMessage = "Protected run limit is zero"
      logger.warn("Scan rejected: zero budget", { scanId, workspaceId, policyMaxBudgetUsd })
      try {
        await addScanEvent(scanId, "budget_exceeded", "error", errorMessage, {
          maxBudgetUsd,
          policyMaxBudgetUsd,
        })
      } catch (eventErr) {
        logger.warn("Failed to persist budget_exceeded event", {
          scanId,
          error: eventErr instanceof Error ? eventErr.message : String(eventErr),
        })
      }
      return {
        ok: false,
        result: {
          status: "failed",
          errorCategory: "BUDGET_EXCEEDED",
          errorMessage,
        },
      }
    }

    engineProfile = resolveEngineProfile(mode)
    engineModel = requireEngineModel(engineProfile.model)
    const budgetSource =
      typeof policyMaxBudgetUsd === "number" &&
      Number.isFinite(policyMaxBudgetUsd) &&
      policyMaxBudgetUsd > 0
        ? "policy"
        : "mode_default"

    try {
      await addScanEvent(scanId, "budget_cap", "info", "Protected run limit enabled", {
        maxBudgetUsd,
        source: budgetSource,
      })
    } catch (eventErr) {
      logger.warn("Failed to persist budget_cap event", {
        scanId,
        error: eventErr instanceof Error ? eventErr.message : String(eventErr),
      })
    }

    if (await isScanCancelled(true)) {
      return {
        ok: false,
        result: {
          status: "failed",
          errorCategory: "CANCELLED",
          errorMessage: "Scan cancelled by user",
        },
      }
    }

    // Engine-backed URL/API targets reach their host only through the
    // scan-scoped relay. Everything here fails closed: no verified domain,
    // no relay config, or an empty scope means no engine run — the coverage
    // receipt records the gap instead of pretending the phase ran.
    let relayCtx: { url: string; grant: string } | null = null
    let relayConfigForCleanup: ReturnType<typeof resolveRelayRuntimeConfig> = null
    if (urlEngineBacked) {
      const relayConfig = resolveRelayRuntimeConfig()
      relayConfigForCleanup = relayConfig
      const verifiedDomain = target.url ? normalizeDomainForProof(target.url) : null
      const verification = verifiedDomain
        ? await prisma.targetDomainVerification.findFirst({
            where: {
              workspaceId,
              domain: verifiedDomain,
              status: "VERIFIED",
              expiresAt: { gt: new Date() },
            },
            select: { id: true },
          })
        : null
      if (!relayConfig || !verification || !target.url || !verifiedDomain) {
        await addScanEvent(
          scanId,
          "engine_skipped",
          "error",
          "Engine-backed URL scan requires a verified domain and configured relay",
          {
            targetType: target.type,
            relayConfigured: Boolean(relayConfig),
            domainVerified: Boolean(verification),
          }
        )
        return {
          ok: false,
          result: {
            status: "failed",
            errorCategory: "RELAY_SCOPE_UNAVAILABLE",
            errorMessage:
              "This review depth requires a verified domain and the target relay. Verify the domain or run Surface Review.",
          },
        }
      }

      const engineTimeoutMsForGrant = resolveEngineRuntimeBudgetMs(
        mode,
        target.type,
        scanRuntimeBudgetMs,
        elapsedScanMs()
      )
      try {
        const specServerHosts =
          target.type === "API" && target.apiSpecUrl
            ? await resolveSpecServerHosts(target.apiSpecUrl)
            : []
        const minted = mintScanRelayGrant(
          {
            scanId,
            mode: scanProfile?.canonicalMode === "DEEP" ? "DEEP" : "STANDARD",
            verifiedDomain,
            targetUrl: target.url,
            apiSpecUrl: target.apiSpecUrl,
            specServerHosts,
            engineBudgetMs: engineTimeoutMsForGrant,
            destructiveTestsAllowed: policy?.destructiveTestsAllowed === true,
            blockedPaths: policy?.blockedPaths ?? [],
            allowedDomains: policy?.allowedDomains ?? [],
          },
          relayConfig
        )
        await registerRelayGrant(scanId, minted.grant, relayConfig)
        relayCtx = { url: relayConfig.url, grant: minted.grant }
        await addScanEvent(scanId, "relay_scope", "info", "Relay scope granted", {
          hosts: minted.scope.hosts,
          methods: minted.scope.methods,
          maxRequests: minted.scope.maxRequests,
        })
      } catch (grantErr) {
        await addScanEvent(scanId, "engine_skipped", "error", "Relay grant could not be minted", {
          targetType: target.type,
          error: grantErr instanceof Error ? grantErr.message : String(grantErr),
        })
        return {
          ok: false,
          result: {
            status: "failed",
            errorCategory: "RELAY_SCOPE_UNAVAILABLE",
            errorMessage: "Could not establish relay scope for this verified target.",
          },
        }
      }
    }

    // Once the external engine begins, an automatic BullMQ replay could
    // spend twice for the same scan. Preflight remains retryable; the
    // billable phase is terminal and any rerun requires a fresh scan.
    await addScanEvent(
      scanId,
      "billable_boundary",
      "info",
      "Automatic retries disabled before provider-billable analysis",
      { retryPolicy: "fresh_scan_required" }
    )
    markBillablePhaseStarted()

    // Keep the profile's deterministic-scanner reserve available even when
    // the model is healthy until its own wall-clock cap.
    const engineTimeoutMs = resolveEngineRuntimeBudgetMs(
      mode,
      target.type,
      scanRuntimeBudgetMs,
      elapsedScanMs()
    )
    if (engineTimeoutMs <= 0) {
      markGlobalScanTimeout()
      throw new Error("Scan analysis deadline exhausted before engine execution")
    }

    engineStartedAtMs = Date.now()
    try {
      engineResult = await runEngine(
        {
          scanId,
          goal,
          mode,
          target: {
            id: target.id,
            type: target.type as TargetType,
            url: target.url,
            repoFullName: target.repoFullName,
            branch: target.branch,
            name: target.name,
          },
          apiSpecUrl: target.type === "API" ? target.apiSpecUrl : null,
          instruction:
            target.type === "REPO"
              ? buildVibeSecurityInstruction(goal)
              : buildUrlTargetInstruction(goal, {
                  host: target.url ? new URL(target.url).hostname : "",
                  targetType: target.type as "WEB_APP" | "API",
                  environment: target.environment,
                  hasApiSpec: Boolean(target.apiSpecUrl),
                  focus,
                }),
          maxBudgetUsd,
          ...(relayCtx ? { relay: relayCtx } : {}),
          // The stored plan drives --scope-mode and, for Review Changes, the
          // immutable --diff-base/--diff-head/--repository-revision pins.
          executionPlan: executionPlan ?? null,
        },
        scanId,
        engineTimeoutMs,
        isScanCancelled,
        // Sprint 10: metering hook — called on each agent-loop tick with
        // wall-clock elapsed ms. The hook is a no-op for now; the final
        // metering is done after the engine completes. This signal can be
        // used for real-time balance checks in a future iteration.
        (_elapsedMs: number) => {
          // Real-time metering hook — intentionally empty for now.
          // The final wall-clock duration is recorded after the engine exits.
        }
      )
    } finally {
      // Relay hygiene runs on EVERY terminal path — success, failure,
      // cancel, or throw. The grant's expiry is a backstop, not the
      // mechanism; revocation is immediate.
      if (relayConfigForCleanup) {
        const entries = await fetchRelayAudit(scanId, relayConfigForCleanup)
        if (entries.length > 0) {
          try {
            const uploaded = await uploadEncryptedArtifact({
              workspaceId,
              ownerId: scanId,
              type: "relay_audit",
              content: JSON.stringify(entries),
              contentType: "application/json",
            })
            await addScanEvent(scanId, "relay_audit", "info", "Relay audit trail captured", {
              entries: entries.length,
              storageUri: uploaded.storageUri,
            })
          } catch (auditErr) {
            logger.warn("Failed to persist relay audit", {
              scanId,
              error: auditErr instanceof Error ? auditErr.message : String(auditErr),
            })
          }
        }
        await revokeRelayGrant(scanId, relayConfigForCleanup)
      }
    }
  } else if (target.type === "WEB_APP" || target.type === "API") {
    engineResult = {
      exitCode: 0,
      cancelled: false,
      timedOut: false,
      sourceCheckoutPath: null,
      output: {
        vulnerabilities: [],
        runRecord: null,
        findingCount: 0,
        summary: "Deterministic surface review completed; the engine is not part of this tier.",
        findingsComplete: true,
        ingestionIssues: [],
        scopedCoverage: null,
        threatModels: null,
        httpExchangeExport: null,
      },
    }
  } else {
    return {
      ok: false,
      result: {
        status: "failed",
        errorCategory: "INVALID_TARGET",
        errorMessage: `Unsupported target type for scanning: ${target.type}`,
      },
    }
  }

  return {
    ok: true,
    engineResult,
    ...(deterministicCheckout ? { deterministicCheckout } : {}),
    ...(engineProfile ? { engineProfile } : {}),
    ...(engineModel ? { engineModel } : {}),
    maxBudgetUsd,
    engineStartedAtMs,
  }
}

export async function resolveEngineTerminalError(params: {
  scanId: string
  engineBacked: boolean
  deterministicRetest: boolean
  engineResult: EngineRunResult
  exitInterpretation: ReturnType<typeof interpretExitCode>
  priorError: ScanTerminalError | null
}): Promise<ScanTerminalError | null> {
  const {
    scanId,
    engineBacked,
    deterministicRetest,
    engineResult,
    exitInterpretation,
    priorError,
  } = params
  const runRecord = engineResult.output.runRecord
  let engineTerminalError = priorError

  if (!engineTerminalError && engineBacked && exitInterpretation.status === "FAILED") {
    const stoppedForBudget = exitInterpretation.category === "BUDGET_EXCEEDED"
    engineTerminalError = {
      status: (stoppedForBudget ? "STOPPED_BUDGET" : "FAILED") as ScanTerminalError["status"],
      errorCategory: exitInterpretation.category,
      errorMessage: exitInterpretation.message,
    }
    try {
      await addScanEvent(
        scanId,
        "engine_terminal",
        stoppedForBudget ? "error" : "warning",
        `Engine stopped (${exitInterpretation.category}); continuing with deterministic scanners`,
        {
          exitCode: engineResult.exitCode,
          errorCategory: exitInterpretation.category,
        }
      )
    } catch (eventErr) {
      logger.warn("Failed to persist engine_terminal event", {
        scanId,
        error: eventErr instanceof Error ? eventErr.message : String(eventErr),
      })
    }
    return engineTerminalError
  }

  if (
    engineTerminalError ||
    deterministicRetest ||
    !engineBacked ||
    (engineResult.output.findingsComplete &&
      runRecord &&
      runRecord.run_id === scanId &&
      runRecord.run_name === scanId &&
      runRecord.status === "completed")
  ) {
    return engineTerminalError
  }

  const stoppedForBudget = runRecord?.terminal_reason === "budget_exceeded"
  const stoppedForContentFilter = runRecord?.terminal_reason === "content_filter_stopped"
  const stoppedForEngineError = runRecord?.terminal_reason === "engine_stopped"
  const hasEngineFindings = (engineResult.output.vulnerabilities?.length ?? 0) > 0
  const errorCategory = stoppedForBudget
    ? "BUDGET_EXCEEDED"
    : stoppedForContentFilter
      ? "CONTENT_FILTER_STOPPED"
      : stoppedForEngineError
        ? "ENGINE_STOPPED"
        : "ENGINE_INCOMPLETE"
  const errorMessage = stoppedForBudget
    ? "Protected run limit reached"
    : stoppedForContentFilter
      ? "Engine stopped after content filter blocked the model; partial findings preserved"
      : stoppedForEngineError
        ? "Engine stopped after a model error; partial findings preserved"
        : "Engine did not produce a completed, valid result receipt"
  // Content filter stops and engine errors with findings are PARTIAL:
  // the engine produced results but did not complete its full scope.
  // Reporting these as COMPLETED would promise "we looked, and this is
  // what we found" when the run was actually truncated — false confidence
  // in a security tool. Without findings, they fail.
  const terminalStatus: ScanTerminalError["status"] = stoppedForBudget
    ? "STOPPED_BUDGET"
    : (stoppedForContentFilter || stoppedForEngineError) && hasEngineFindings
      ? "PARTIAL"
      : "FAILED"
  engineTerminalError = {
    status: terminalStatus,
    errorCategory,
    errorMessage,
  }
  try {
    await addScanEvent(
      scanId,
      "engine_incomplete",
      "warning",
      `Engine result incomplete; continuing with deterministic scanners`,
      { errorCategory }
    )
  } catch (eventErr) {
    logger.warn("Failed to persist engine_incomplete event", {
      scanId,
      error: eventErr instanceof Error ? eventErr.message : String(eventErr),
    })
  }
  return engineTerminalError
}
