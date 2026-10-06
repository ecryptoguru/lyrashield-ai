import { resolve } from "path"
import { logger } from "@lyrashield/logger"
import { buildEngineCommand, type ScanConfig } from "./command-builder"
import { parseEngineOutput, type ParsedScanOutput } from "./output-parser"
import { resolveEngineProfile } from "./runner-config"
import { emitScanEvent } from "./runner-events"
import {
  findRunOutputDir,
  prepareEngineWorkspace,
  readEngineOutput,
  readEngineProgressFingerprint,
  readEngineSpendUsd,
  resolveEngineSourceCheckout,
  resolveEngineSourceRevision,
  verifySandboxRemoved,
} from "./runner-output"
import { ENGINE_LLM_STALL_MS, runEngineProcess } from "./runner-process"

export type { EngineProfile } from "./runner-config"
export {
  assertRepositoryScanRuntimeConfigured,
  buildEngineEnv,
  resolveEngineProfile,
  resolveEngineSandboxNetwork,
} from "./runner-config"
export {
  cleanupEngineWorkspace,
  findRunOutputDir,
  parseEngineProgressFingerprint,
  prepareEngineWorkspace,
  readEngineOutput,
  readEngineProgressFingerprint,
  readEngineSpendUsd,
  resolveEngineSourceCheckout,
  resolveEngineSourceRevision,
} from "./runner-output"
export {
  collectEngineFailureType,
  createKillEscalation,
  extractEngineFailureType,
  OVERSHOOT_GRACE,
  terminateActiveEngineProcesses,
  trackActiveEngineProcess,
} from "./runner-process"
export {
  appendEngineStreamTail,
  createEngineStreamTail,
  ENGINE_TAIL_MAX_CHARS,
  ENGINE_TAIL_MAX_LINES,
  flushEngineStreamTail,
  redactEngineTailLine,
} from "./runner-tail"
export { runEngineTriage } from "./triage-runner"
export type { EngineTriageRunParams } from "./triage-runner"

export interface EngineRunResult {
  exitCode: number
  cancelled: boolean
  timedOut: boolean
  timeoutReason?: "DURATION" | "INACTIVITY" | "LLM_STALL" | null
  /**
   * The worker backstop killed the engine because the polled run.json
   * llm_usage.cost crossed the protected budget ceiling (maxBudgetUsd ×
   * (1 + OVERSHOOT_GRACE)). This is NOT an error — it maps to STOPPED_BUDGET,
   * the same terminal status the engine's own exit-3 self-stop uses.
   */
  budgetKilled?: boolean
  output: ParsedScanOutput
  /** Validated host-side checkout for deterministic repository scanners. */
  sourceCheckoutPath: string | null
  /** Immutable Git commit actually checked out for repository scanners. */
  sourceRevision?: string | null
  /** Host-observed confirmation that no sandbox owned by this scan remains. */
  sandboxRemoved?: boolean
}
const EXIT_CODE_MAP: Record<
  number,
  { status: "COMPLETED" | "FAILED"; category: string; message: string }
> = {
  0: { status: "COMPLETED", category: "SUCCESS", message: "Scan completed successfully" },
  1: { status: "FAILED", category: "ENGINE_ERROR", message: "Engine exited with an error" },
  2: {
    status: "COMPLETED",
    category: "VULNERABILITIES_FOUND",
    message: "Scan completed with vulnerabilities found",
  },
  3: {
    status: "FAILED",
    category: "BUDGET_EXCEEDED",
    message: "Engine stopped at the protected budget limit",
  },
  4: {
    status: "FAILED",
    category: "RATE_LIMITED",
    message: "Engine stopped because the model provider rate limited the scan",
  },
  5: {
    status: "FAILED",
    category: "ENGINE_INCOMPLETE",
    message: "Engine ended without a completed scan receipt",
  },
  [-2]: {
    status: "FAILED",
    category: "INFRA_ERROR",
    message: "Engine runtime could not be started",
  },
}

export function interpretExitCode(
  code: number,
  signal?: NodeJS.Signals | null
): {
  status: "COMPLETED" | "FAILED"
  category: string
  message: string
} {
  if (code === 137 || signal === "SIGKILL") {
    return {
      status: "FAILED",
      category: "INFRA_ERROR",
      message: "Engine was killed by its runtime",
    }
  }
  return (
    EXIT_CODE_MAP[code] ?? {
      status: "FAILED",
      category: "ENGINE_ERROR",
      message: `Engine exited with code ${code}`,
    }
  )
}
const STRIX_RUN_TYPES: Record<string, string> = {
  REPO: "repository",
  WEB_APP: "web_application",
  API: "api_spec",
}
export async function runEngine(
  config: ScanConfig,
  scanId: string,
  timeoutMs: number | null = null,
  shouldCancel?: () => Promise<boolean>,
  onAgentLoopTick?: (elapsedMs: number) => void
): Promise<EngineRunResult> {
  if (shouldCancel && (await shouldCancel())) {
    return {
      exitCode: -1,
      cancelled: true,
      timedOut: false,
      timeoutReason: null,
      budgetKilled: false,
      output: parseEngineOutput("", ""),
      sourceCheckoutPath: null,
    }
  }

  const cmd = buildEngineCommand(config, timeoutMs)
  const profile = resolveEngineProfile(config.mode)

  const absWorkDir = resolve(cmd.workDir)
  await prepareEngineWorkspace(absWorkDir)

  logger.info("Starting engine process", {
    scanId,
    executable: cmd.executable,
    argumentCount: cmd.args.length,
    workDir: absWorkDir,
    model: profile.model,
    reasoningEffort: profile.reasoningEffort,
  })

  await emitScanEvent(scanId, "engine_start", "info", "Starting LyraShield scan engine", {
    model: profile.model ?? "fallback",
    reasoningEffort: profile.reasoningEffort,
  })

  let processResult
  try {
    processResult = await runEngineProcess(
      cmd,
      absWorkDir,
      scanId,
      timeoutMs,
      profile,
      shouldCancel,
      () => readEngineProgressFingerprint(absWorkDir, scanId),
      config.maxBudgetUsd,
      () => readEngineSpendUsd(absWorkDir, scanId),
      onAgentLoopTick,
      config.relay,
      STRIX_RUN_TYPES[config.target.type] ?? "repository"
    )
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== "ENOENT" && code !== "EACCES") throw error
    await emitScanEvent(scanId, "engine_infra", "error", "Engine runtime could not be started", {
      code,
    })
    processResult = {
      exitCode: -2,
      timedOut: false,
      timeoutReason: null,
      cancelled: false,
      budgetKilled: false,
      failureType: null,
    }
  }
  const { exitCode, timedOut, timeoutReason, cancelled, budgetKilled, failureType } = processResult

  if (timedOut) {
    const timeoutMessage =
      timeoutReason === "INACTIVITY"
        ? "Engine stopped after no durable progress was observed"
        : timeoutReason === "LLM_STALL"
          ? `Engine stopped after ${ENGINE_LLM_STALL_MS / 60000} minutes without model activity`
          : `Engine timed out after ${(timeoutMs ?? 0) / 1000}s`
    await emitScanEvent(scanId, "engine_timeout", "error", timeoutMessage, {
      timeoutReason,
      ...(typeof timeoutMs === "number" ? { timeoutMs } : {}),
    })
    logger.error("Engine timed out", { scanId, timeoutMs, timeoutReason })
  } else {
    await emitScanEvent(scanId, "engine_exit", "info", `Engine exited with code ${exitCode}`, {
      exitCode,
    })
  }

  logger.info("Engine process finished", {
    scanId,
    exitCode,
    timedOut,
    timeoutReason,
    failureType,
  })

  if (exitCode === 1 && failureType) {
    await emitScanEvent(
      scanId,
      "engine_error_class",
      "error",
      `Engine analysis stopped unexpectedly (${failureType})`,
      { failureType }
    )
  }

  const outputDir = await findRunOutputDir(absWorkDir, scanId)
  const { vulnerabilitiesRaw, runJsonRaw, artifacts } = outputDir
    ? await readEngineOutput(outputDir)
    : { vulnerabilitiesRaw: "", runJsonRaw: "", artifacts: {} }

  const output = parseEngineOutput(vulnerabilitiesRaw, runJsonRaw, artifacts)
  const sourceCheckoutPath = await resolveEngineSourceCheckout(output.runRecord, scanId)
  const sourceRevision = await resolveEngineSourceRevision(sourceCheckoutPath)
  const sandboxRemoved = await verifySandboxRemoved(scanId)

  if (config.target.type === "REPO") {
    await emitScanEvent(
      scanId,
      "source_checkout",
      sourceCheckoutPath ? "info" : "warning",
      sourceCheckoutPath
        ? "Validated engine source checkout for deterministic scanners"
        : "Validated engine source checkout unavailable; source-dependent scanners will report bounded coverage",
      { available: Boolean(sourceCheckoutPath) }
    )
  }

  await emitScanEvent(
    scanId,
    "engine_output_parsed",
    "info",
    `Parsed ${output.findingCount} finding(s) from engine output`,
    {
      findingCount: output.findingCount,
      engineStatus: output.runRecord?.status ?? "unknown",
      outputAvailable: Boolean(outputDir),
    }
  )

  return {
    exitCode,
    cancelled,
    timedOut,
    timeoutReason,
    budgetKilled,
    output,
    sourceCheckoutPath,
    sourceRevision,
    sandboxRemoved,
  }
}
