import { spawn, type ChildProcess } from "child_process"
import { readFile, rm, mkdir, readdir, stat } from "fs/promises"
import { join, resolve } from "path"
import { logger } from "@lyrashield/logger"
import { addScanEvent } from "@lyrashield/db"
import { buildEngineCommand, type ScanConfig, type EngineCommand } from "./command-builder"
import { parseEngineOutput, type ParsedScanOutput } from "./output-parser"

export interface EngineRunResult {
  exitCode: number
  output: ParsedScanOutput
  stdout: string
  stderr: string
}

const EXIT_CODE_MAP: Record<number, { status: "COMPLETED" | "FAILED"; category: string; message: string }> = {
  0: { status: "COMPLETED", category: "SUCCESS", message: "Scan completed successfully" },
  1: { status: "COMPLETED", category: "SUCCESS", message: "Scan completed (exit 1 — non-critical)" },
  2: { status: "COMPLETED", category: "VULNERABILITIES_FOUND", message: "Scan completed with vulnerabilities found" },
}

export function interpretExitCode(code: number): {
  status: "COMPLETED" | "FAILED"
  category: string
  message: string
} {
  return EXIT_CODE_MAP[code] ?? {
    status: "FAILED",
    category: "ENGINE_ERROR",
    message: `Engine exited with code ${code}`,
  }
}

const MAX_BUFFER_BYTES = 10 * 1024 * 1024

function buildEngineEnv(): Record<string, string> {
  const allow = new Set([
    "PATH", "HOME", "USER", "SHELL", "LANG", "LC_ALL", "TERM",
    "DOCKER_HOST", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH",
    "LYRASHIELD_LLM", "LLM_API_KEY", "LLM_API_BASE", "LLM_TIMEOUT",
    "LYRASHIELD_IMAGE", "LYRASHIELD_RUNTIME_BACKEND", "LYRASHIELD_MAX_LOCAL_COPY_MB",
    "LYRASHIELD_REASONING_EFFORT", "LYRASHIELD_TELEMETRY",
    "PERPLEXITY_API_KEY",
  ])
  // Prefix-based allowlist for LLM/AI provider API keys so new providers
  // work without code changes. Each prefix matches env vars like
  // ANTHROPIC_API_KEY, OPENAI_API_KEY, GROQ_API_KEY, etc.
  const ALLOWED_PREFIXES = [
    "LLM_",
    "AI_",
    "ANTHROPIC_",
    "OPENAI_",
    "GROQ_",
    "MISTRAL_",
    "TOGETHER_",
    "FIREWORKS_",
    "DEEPSEEK_",
    "GOOGLE_AI_", // Google Vertex AI / Gemini
  ]
  const filtered: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (allow.has(key) || ALLOWED_PREFIXES.some((p) => key.startsWith(p))) {
      filtered[key] = value
    }
  }
  return filtered
}

async function emitScanEvent(
  scanId: string,
  stage: string,
  level: string,
  message: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  try {
    await addScanEvent(scanId, stage, level, message, metadata)
  } catch (err) {
    logger.warn("Failed to persist scan event", {
      scanId, stage,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

async function runEngineProcess(
  cmd: EngineCommand,
  absWorkDir: string,
  scanId: string,
  timeoutMs: number,
): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolvePromise, reject) => {
    const child: ChildProcess = spawn(cmd.executable, cmd.args, {
      cwd: absWorkDir,
      env: buildEngineEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""
    let stdoutTruncated = false
    let stderrTruncated = false
    let killed = false

    const timer = setTimeout(() => {
      killed = true
      child.kill("SIGTERM")
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL")
      }, 5000)
    }, timeoutMs)

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString()
      if (stdout.length < MAX_BUFFER_BYTES) {
        stdout += text
      } else if (!stdoutTruncated) {
        stdoutTruncated = true
        logger.warn("stdout buffer truncated", { scanId, maxBytes: MAX_BUFFER_BYTES })
      }
      const lines = text.trim().split("\n")
      for (const line of lines) {
        if (line.trim()) {
          emitScanEvent(scanId, "engine_stdout", "info", line.slice(0, 500), {}).catch(() => {})
        }
      }
    })

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString()
      if (stderr.length < MAX_BUFFER_BYTES) {
        stderr += text
      } else if (!stderrTruncated) {
        stderrTruncated = true
        logger.warn("stderr buffer truncated", { scanId, maxBytes: MAX_BUFFER_BYTES })
      }
      const lines = text.trim().split("\n")
      for (const line of lines) {
        if (line.trim()) {
          emitScanEvent(scanId, "engine_stderr", "warn", line.slice(0, 500), {}).catch(() => {})
        }
      }
    })

    child.on("close", (code) => {
      clearTimeout(timer)
      const exitCode = code ?? (killed ? -1 : 1)
      resolvePromise({ exitCode, stdout, stderr, timedOut: killed })
    })

    child.on("error", (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

async function findRunOutputDir(workDir: string): Promise<string | null> {
  const runsDir = join(workDir, "lyrashield_runs")
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const entries = await readdir(runsDir)
    let newest: string | null = null
    let newestMtime = 0
    for (const entry of entries) {
      const entryPath = join(runsDir, entry)
      try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        const s = await stat(entryPath)
        if (s.isDirectory() && s.mtimeMs > newestMtime) {
          newestMtime = s.mtimeMs
          newest = entry
        }
      } catch {
        // skip entries that can't be stat'd
      }
    }
    return newest ? join(runsDir, newest) : null
  } catch {
    logger.warn("lyrashield_runs directory not found", { runsDir })
    return null
  }
}

async function readEngineOutput(outputDir: string): Promise<{
  vulnerabilitiesRaw: string
  runJsonRaw: string
}> {
  let vulnerabilitiesRaw = ""
  let runJsonRaw = ""

  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    vulnerabilitiesRaw = await readFile(join(outputDir, "vulnerabilities.json"), "utf-8")
  } catch {
    logger.warn("vulnerabilities.json not found", { outputDir })
  }

  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    runJsonRaw = await readFile(join(outputDir, "run.json"), "utf-8")
  } catch {
    logger.warn("run.json not found", { outputDir })
  }

  return { vulnerabilitiesRaw, runJsonRaw }
}

export async function runEngine(
  config: ScanConfig,
  scanId: string,
  timeoutMs = 30 * 60 * 1000,
): Promise<EngineRunResult> {
  const cmd = buildEngineCommand(config)

  const absWorkDir = resolve(cmd.workDir)
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await mkdir(absWorkDir, { recursive: true })

  logger.info("Starting engine process", {
    scanId,
    executable: cmd.executable,
    args: cmd.args,
    workDir: absWorkDir,
  })

  await emitScanEvent(scanId, "engine_start", "info", "Starting LyraShield scan engine", {
    executable: cmd.executable,
    args: cmd.args,
    target: config.target.name,
  })

  const { exitCode, stdout, stderr, timedOut } = await runEngineProcess(cmd, absWorkDir, scanId, timeoutMs)

  if (timedOut) {
    await emitScanEvent(scanId, "engine_timeout", "error", `Engine timed out after ${timeoutMs / 1000}s`, {
      timeoutMs,
    })
    logger.error("Engine timed out", { scanId, timeoutMs })
  } else {
    await emitScanEvent(scanId, "engine_exit", "info", `Engine exited with code ${exitCode}`, {
      exitCode,
    })
  }

  logger.info("Engine process finished", { scanId, exitCode, stdoutLen: stdout.length, stderrLen: stderr.length, timedOut })

  const outputDir = await findRunOutputDir(absWorkDir)
  const { vulnerabilitiesRaw, runJsonRaw } = outputDir
    ? await readEngineOutput(outputDir)
    : { vulnerabilitiesRaw: "", runJsonRaw: "" }

  const output = parseEngineOutput(vulnerabilitiesRaw, runJsonRaw)

  await emitScanEvent(scanId, "engine_output_parsed", "info", `Parsed ${output.findingCount} finding(s) from engine output`, {
    findingCount: output.findingCount,
    engineStatus: output.runRecord?.status ?? "unknown",
    outputDir: outputDir ?? "not_found",
  })

  return { exitCode, output, stdout, stderr }
}

export async function cleanupEngineWorkspace(workDir: string): Promise<void> {
  try {
    await rm(resolve(workDir), { recursive: true, force: true })
    logger.info("Engine workspace cleaned up", { workDir })
  } catch (err) {
    logger.warn("Failed to clean up engine workspace", {
      workDir,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
