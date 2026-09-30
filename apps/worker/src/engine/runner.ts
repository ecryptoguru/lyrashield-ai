import { rm, writeFile } from "fs/promises"
import { join, resolve } from "path"
import { env } from "@lyrashield/config"
import { logger } from "@lyrashield/logger"
import {
  parseEngineTriageArtifact,
  type EngineTriageArtifact,
} from "@lyrashield/security/ai-security"
import { buildEngineCommand, type ScanConfig } from "./command-builder"
import { parseEngineOutput, type ParsedScanOutput } from "./output-parser"
import { resolveEngineProfile, type EngineProfile } from "./runner-config"
import { emitScanEvent } from "./runner-events"
import {
  findRunOutputDir,
  prepareEngineWorkspace,
  readEngineOutput,
  readEngineProgressFingerprint,
  readEngineSpendUsd,
  readTextFileBounded,
  resolveEngineSourceCheckout,
  resolveEngineSourceRevision,
  verifySandboxRemoved,
} from "./runner-output"
import { ENGINE_LLM_STALL_MS, runEngineProcess } from "./runner-process"
import { ENGINE_WORK_ROOT } from "./workspace-path"

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
const MAX_ENGINE_TRIAGE_ARTIFACT_BYTES = 128 * 1024
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

interface EngineTriageRunResult {
  artifact: EngineTriageArtifact | null
  /** Bounded private usage receipt, normalized by the worker before accounting. */
  llmUsage?: Record<string, unknown>
  exitCode: number
  timedOut: boolean
  cancelled: boolean
}

function isTriageUsage(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Runs the engine-owned triage command in an existing scan workspace. The
 * command receives only redacted candidate data and has no repository target.
 */
export async function runEngineTriage(params: {
  scanId: string
  profile: EngineProfile
  input: Record<string, unknown>
  maxBudgetUsd: number
  timeoutMs: number
  shouldCancel?: () => Promise<boolean>
}): Promise<EngineTriageRunResult> {
  const { scanId, profile, input, maxBudgetUsd, timeoutMs, shouldCancel } = params
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(scanId) || scanId.includes("..")) {
    throw new Error("Invalid scan id for triage workspace")
  }
  if (!Number.isFinite(maxBudgetUsd) || maxBudgetUsd <= 0) {
    throw new Error("Triage requires a positive remaining scan budget")
  }

  const absWorkDir = resolve(ENGINE_WORK_ROOT, scanId)
  const inputPath = join(absWorkDir, "ai-security-triage-input.json")
  const outputPath = join(absWorkDir, "ai-security-triage.json")
  // inputPath is constrained to the worker-owned per-scan workspace above.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await writeFile(inputPath, JSON.stringify(input), { encoding: "utf8", mode: 0o600 })
  await rm(outputPath, { force: true })

  const processResult = await runEngineProcess(
    {
      executable: env.LYRASHIELD_ENGINE_PATH || "lyrashield",
      args: [
        "ai-security-triage",
        "--input",
        inputPath,
        "--output",
        outputPath,
        "--enabled",
        "--max-budget-usd",
        String(maxBudgetUsd),
      ],
      workDir: absWorkDir,
    },
    absWorkDir,
    scanId,
    Math.min(timeoutMs, 90_000),
    profile,
    shouldCancel
  )

  let rawArtifact: unknown
  try {
    rawArtifact = JSON.parse(
      await readTextFileBounded(outputPath, MAX_ENGINE_TRIAGE_ARTIFACT_BYTES)
    )
  } catch (error) {
    logger.warn("AI security triage artifact unavailable or invalid JSON", {
      scanId,
      error: error instanceof Error ? error.message : String(error),
    })
    return { artifact: null, ...processResult }
  }
  const rawUsage = isTriageUsage(rawArtifact) ? rawArtifact.llmUsage : undefined
  const artifact = parseEngineTriageArtifact(rawArtifact)
  if (!artifact) {
    logger.warn("AI security triage artifact violated its versioned contract", { scanId })
    return {
      artifact: null,
      ...(isTriageUsage(rawUsage) ? { llmUsage: rawUsage } : {}),
      ...processResult,
    }
  }
  return {
    artifact,
    ...(isTriageUsage(rawUsage) ? { llmUsage: rawUsage } : {}),
    exitCode: processResult.exitCode,
    timedOut: processResult.timedOut,
    cancelled: processResult.cancelled,
  }
}
