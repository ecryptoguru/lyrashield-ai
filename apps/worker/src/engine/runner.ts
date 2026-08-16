import { execFile, spawn, type ChildProcess } from "child_process"
import { constants as fsConstants } from "fs"
import { rm, mkdir, readdir, stat, lstat, realpath, open, writeFile } from "fs/promises"
import { join, relative, resolve, sep } from "path"
import { tmpdir } from "os"
import { promisify } from "util"
import { env } from "@lyrashield/config"
import { logger } from "@lyrashield/logger"
import { addScanEvent } from "@lyrashield/db"
import { buildEngineCommand, type ScanConfig, type EngineCommand } from "./command-builder"
import { parseEngineOutput, type ParsedScanOutput } from "./output-parser"
import {
  parseEngineTriageArtifact,
  type EngineTriageArtifact,
} from "@lyrashield/security/ai-security"

export interface EngineRunResult {
  exitCode: number
  cancelled: boolean
  timedOut: boolean
  timeoutReason?: "DURATION" | "INACTIVITY" | null
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

const execFileAsync = promisify(execFile)

const SANDBOX_RECEIPT_TIMEOUT_MS = 10_000

async function verifySandboxRemoved(scanId: string): Promise<boolean | undefined> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(scanId) || scanId.includes("..")) {
    return undefined
  }
  try {
    // Use `docker ps -a` (all containers), not just running ones. A sandbox that
    // exited but was never removed must still count as "not removed" — otherwise a
    // stopped container reports sandboxRemoved:true and leaks the resource receipt.
    const { stdout } = await execFileAsync(
      "docker",
      ["ps", "-a", "--filter", `label=strix-run-id=${scanId}`, "--quiet`"],
      { timeout: SANDBOX_RECEIPT_TIMEOUT_MS, maxBuffer: 16 * 1024 }
    )
    return stdout.trim() === ""
  } catch (error) {
    logger.warn("Could not verify terminal sandbox cleanup", {
      scanId,
      error: error instanceof Error ? error.message : String(error),
    })
    return undefined
  }
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