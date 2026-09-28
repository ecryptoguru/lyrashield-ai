import { execFile } from "child_process"
import { createHash } from "crypto"
import { constants as fsConstants } from "fs"
import { rm, mkdir, readdir, lstat, realpath, open } from "fs/promises"
import { join, relative, resolve, sep } from "path"
import { promisify } from "util"
import { logger } from "@lyrashield/logger"
import type { EngineArtifactInput, ParsedScanOutput } from "./output-parser"
import { ENGINE_CHECKOUT_ROOT, ENGINE_WORK_ROOT } from "./workspace-path"

const execFileAsync = promisify(execFile)

const SANDBOX_RECEIPT_TIMEOUT_MS = 10_000

export async function verifySandboxRemoved(scanId: string): Promise<boolean | undefined> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(scanId) || scanId.includes("..")) {
    return undefined
  }
  try {
    // Use `docker ps -a` (all containers), not just running ones. A sandbox that
    // exited but was never removed must still count as "not removed" — otherwise a
    // stopped container reports sandboxRemoved:true and leaks the resource receipt.
    const { stdout } = await execFileAsync(
      "docker",
      ["ps", "-a", "--filter", `label=strix-run-id=${scanId}`, "--quiet"],
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
const MAX_ENGINE_VULNERABILITIES_BYTES = 10 * 1024 * 1024
const MAX_ENGINE_RUN_BYTES = 1 * 1024 * 1024
// run.json 1.1 sibling artifacts — bounded like every other engine output.
const MAX_ENGINE_COVERAGE_BYTES = 256 * 1024
const MAX_ENGINE_THREAT_MODEL_BYTES = 32 * 1024 * 1024
const MAX_ENGINE_HTTP_EXCHANGES_BYTES = 2 * 1024 * 1024
const ENGINE_RUN_LAYOUTS = ["strix_runs", "lyrashield_runs"] as const
const ENGINE_OUTPUT_ARTIFACTS = ["run.json", "vulnerabilities.json"] as const
const MAX_RUN_OUTPUT_ENTRIES = 50_000

/**
 * Extract only a repository checkout created by the engine below its dedicated
 * temporary root. A run artifact must never redirect scanners to arbitrary
 * worker files.
 */
export async function resolveEngineSourceCheckout(
  runRecord: ParsedScanOutput["runRecord"],
  scanId: string
): Promise<string | null> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(scanId) || scanId.includes("..")) return null
  if (runRecord?.run_id !== scanId || runRecord.run_name !== scanId) return null

  let checkoutRoot: string
  try {
    // ENGINE_CHECKOUT_ROOT is a fixed constant under the system temp directory.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    checkoutRoot = await realpath(ENGINE_CHECKOUT_ROOT)
  } catch {
    return null
  }

  const checkoutPrefix = `repo_${scanId}_`
  const validateCheckout = async (sourcePath: string): Promise<string | null> => {
    try {
      // sourcePath is engine-controlled. Reject links before resolving and require
      // the exact scan-owned clone layout: <root>/repo_<scanId>_<random>/<repo>.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const sourceStat = await lstat(sourcePath)
      if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) return null
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const checkout = await realpath(sourcePath)
      const pathFromRoot = relative(checkoutRoot, checkout)
      const pathParts = pathFromRoot.split(sep)
      if (
        pathParts.length !== 2 ||
        !pathParts[0]?.startsWith(checkoutPrefix) ||
        !pathParts[1] ||
        resolve(checkoutRoot, pathFromRoot) !== checkout
      ) {
        return null
      }
      const ownerRoot = resolve(checkoutRoot, pathParts[0])
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const ownerStat = await lstat(ownerRoot)
      return ownerStat.isDirectory() && !ownerStat.isSymbolicLink() ? checkout : null
    } catch {
      return null
    }
  }

  for (const target of Array.isArray(runRecord?.targets_info) ? runRecord.targets_info : []) {
    if (typeof target !== "object" || target === null) continue
    const details = (target as { details?: unknown }).details
    if (typeof details !== "object" || details === null) continue
    const sourcePath = (details as { cloned_repo_path?: unknown }).cloned_repo_path
    if (typeof sourcePath !== "string" || !sourcePath.trim()) continue

    const checkout = await validateCheckout(sourcePath)
    if (checkout) return checkout
  }

  // Public run.json deliberately redacts cloned_repo_path. Recover the checkout
  // from the fixed worker-owned root without reading the private resume record.
  try {
    // ENGINE_CHECKOUT_ROOT is fixed; entries remain untrusted engine output.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const ownedRoots = (await readdir(checkoutRoot, { withFileTypes: true })).filter(
      (entry) => entry.name.startsWith(checkoutPrefix) && entry.isDirectory()
    )
    if (ownedRoots.length !== 1) return null

    const ownerRoot = resolve(checkoutRoot, ownedRoots[0]!.name)
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const children = (await readdir(ownerRoot, { withFileTypes: true })).filter((entry) =>
      entry.isDirectory()
    )
    if (children.length !== 1) return null
    return validateCheckout(resolve(ownerRoot, children[0]!.name))
  } catch {
    // Missing, ambiguous, or unsafe checkouts are a coverage gap, never an empty source scan.
  }

  return null
}

export async function resolveEngineSourceRevision(
  checkoutPath: string | null
): Promise<string | null> {
  if (!checkoutPath) return null
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", checkoutPath, "rev-parse", "--verify", "HEAD"],
      {
        timeout: 5_000,
        maxBuffer: 1_024,
      }
    )
    const revision = stdout.trim().toLowerCase()
    return /^[a-f0-9]{40}$/.test(revision) ? revision : null
  } catch {
    return null
  }
}

async function hasEngineOutputArtifact(runDir: string): Promise<boolean> {
  for (const artifact of ENGINE_OUTPUT_ARTIFACTS) {
    try {
      // artifact names are fixed and joined to a validated run directory.
      // Use lstat so a symlink (even one pointing to a file) does not count.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const artifactStat = await lstat(join(runDir, artifact))
      if (artifactStat.isFile()) return true
    } catch {
      // Try the next expected artifact.
    }
  }
  return false
}

export async function findRunOutputDir(
  workDir: string,
  expectedRunName?: string
): Promise<string | null> {
  let newest: { path: string; mtimeMs: number } | null = null
  let entriesSeen = 0

  for (const layout of ENGINE_RUN_LAYOUTS) {
    const runsDir = join(workDir, layout)
    try {
      // runsDir is a fixed layout under the resolved engine work directory.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      for (const entry of await readdir(runsDir)) {
        if (++entriesSeen > MAX_RUN_OUTPUT_ENTRIES) {
          logger.warn("Engine run output walk capped", {
            workDir,
            maxEntries: MAX_RUN_OUTPUT_ENTRIES,
          })
          break
        }
        if (expectedRunName && entry !== expectedRunName) continue
        const entryPath = join(runsDir, entry)
        try {
          // entryPath is inside the validated run layout and is not used as a destination.
          // eslint-disable-next-line security/detect-non-literal-fs-filename
          const entryStat = await lstat(entryPath)
          if (entryStat.isSymbolicLink()) continue
          if (!entryStat.isDirectory() || !(await hasEngineOutputArtifact(entryPath))) continue
          if (!newest || entryStat.mtimeMs > newest.mtimeMs) {
            newest = { path: entryPath, mtimeMs: entryStat.mtimeMs }
          }
        } catch {
          // A disappearing/unreadable run must not fail the worker.
        }
      }
    } catch {
      logger.debug("Engine run layout not found", { runsDir })
    }
  }

  return newest?.path ?? null
}

export async function prepareEngineWorkspace(workDir: string): Promise<void> {
  const workspace = resolve(workDir)
  const workspaceFromRoot = relative(ENGINE_WORK_ROOT, workspace)
  if (
    !workspaceFromRoot ||
    workspaceFromRoot === ".." ||
    workspaceFromRoot.startsWith(`..${sep}`)
  ) {
    throw new Error("Refusing to prepare an engine workspace outside the owned run root")
  }
  // The work directory belongs to one scan id. Clearing it before launch
  // prevents a crashed attempt's receipt from being mistaken for this attempt.
  await rm(workspace, { recursive: true, force: true })
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await mkdir(workspace, { recursive: true })
}

export async function readTextFileBounded(path: string, maxBytes: number): Promise<string> {
  // The artifact location is selected only from a validated engine output directory.
  // O_NOFOLLOW and fstat reject symlinked or special-file artifacts without a
  // pre-open lstat/TOCTOU gap.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    const fileStat = await handle.stat()
    if (!fileStat.isFile()) {
      throw new Error(`Engine artifact is not a regular file: ${path}`)
    }

    const buffer = Buffer.allocUnsafe(maxBytes + 1)
    let offset = 0
    while (offset <= maxBytes) {
      const { bytesRead } = await handle.read(buffer, offset, maxBytes + 1 - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset > maxBytes) throw new Error(`Engine artifact exceeds ${maxBytes} byte limit`)
    return buffer.subarray(0, offset).toString("utf8")
  } finally {
    await handle.close()
  }
}

/** Reads only the engine's bounded monotonic liveness fields. */
export async function readEngineProgressFingerprint(
  workDir: string,
  expectedRunName: string
): Promise<string | null> {
  const outputDir = await findRunOutputDir(workDir, expectedRunName)
  if (!outputDir) return null

  let raw: string
  try {
    raw = await readTextFileBounded(join(outputDir, "run.json"), MAX_ENGINE_RUN_BYTES)
  } catch {
    return null
  }

  try {
    const record = JSON.parse(raw) as { seq?: unknown; turn_count?: unknown; phase?: unknown }
    if (
      !Number.isInteger(record.seq) ||
      (record.seq as number) < 0 ||
      !Number.isInteger(record.turn_count) ||
      (record.turn_count as number) < 0 ||
      !["setup", "running", "finalizing", "completed", "stopped"].includes(record.phase as string)
    ) {
      return null
    }
    return `${record.seq}:${record.turn_count}:${record.phase}`
  } catch {
    return null
  }
}

/**
 * Inverse of the fingerprint string readEngineProgressFingerprint emits, for
 * detectors that need the individual liveness fields (turn count, phase).
 * Returns null for a fingerprint from an unexpected format.
 */
export function parseEngineProgressFingerprint(
  fingerprint: string
): { seq: number; turnCount: number; phase: string } | null {
  const parts = fingerprint.split(":")
  if (parts.length !== 3) return null
  const seq = Number(parts[0])
  const turnCount = Number(parts[1])
  if (!Number.isInteger(seq) || seq < 0) return null
  if (!Number.isInteger(turnCount) || turnCount < 0) return null
  if (!["setup", "running", "finalizing", "completed", "stopped"].includes(parts[2]!)) return null
  return { seq, turnCount, phase: parts[2]! }
}

/**
 * Reads the live cumulative LLM spend (run.json -> llm_usage -> cost) from the
 * same engine receipt the fingerprint poll already opens. Returns null when the
 * file, the llm_usage object, or the cost field is missing or malformed —
 * treated as "no spend signal yet", NEVER as "over budget" (fail-open on read).
 */
export async function readEngineSpendUsd(
  workDir: string,
  expectedRunName: string
): Promise<number | null> {
  const outputDir = await findRunOutputDir(workDir, expectedRunName)
  if (!outputDir) return null

  let raw: string
  try {
    raw = await readTextFileBounded(join(outputDir, "run.json"), MAX_ENGINE_RUN_BYTES)
  } catch {
    return null
  }

  try {
    const record = JSON.parse(raw) as { llm_usage?: unknown }
    const usage = record.llm_usage
    if (typeof usage !== "object" || usage === null || Array.isArray(usage)) return null
    const cost = (usage as { cost?: unknown }).cost
    if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) return null
    return cost
  } catch {
    return null
  }
}

export async function readEngineOutput(outputDir: string): Promise<{
  vulnerabilitiesRaw: string
  runJsonRaw: string
  artifacts: EngineArtifactInput
}> {
  let vulnerabilitiesRaw = ""
  let runJsonRaw = ""

  try {
    vulnerabilitiesRaw = await readTextFileBounded(
      join(outputDir, "vulnerabilities.json"),
      MAX_ENGINE_VULNERABILITIES_BYTES
    )
  } catch (error) {
    logger.warn("vulnerabilities.json unavailable or oversized", {
      outputDir,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  try {
    runJsonRaw = await readTextFileBounded(join(outputDir, "run.json"), MAX_ENGINE_RUN_BYTES)
  } catch (error) {
    logger.warn("run.json unavailable or oversized", {
      outputDir,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  /**
   * run.json 1.1 sibling artifacts are optional: `undefined` when absent,
   * `null` when the artifact exists but failed the bounded read — the parser
   * records an explicit ingestion issue rather than trusting nothing.
   */
  const readOptionalArtifact = async (
    name: string,
    maxBytes: number
  ): Promise<string | null | undefined> => {
    // Artifact names are fixed constants joined to a validated run directory.
    const artifactPath = join(outputDir, name)
    try {
      return await readTextFileBounded(artifactPath, maxBytes)
    } catch (error) {
      try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        const artifactStat = await lstat(artifactPath)
        if (artifactStat.isFile() || artifactStat.isSymbolicLink()) {
          logger.warn(`${name} present but unreadable or oversized`, {
            outputDir,
            error: error instanceof Error ? error.message : String(error),
          })
          return null
        }
      } catch {
        // absent
      }
      return undefined
    }
  }

  const threatModelRaw = await readOptionalArtifact(
    "threat_model.json",
    MAX_ENGINE_THREAT_MODEL_BYTES
  )
  // The singular owned artifact only exists under run.json 1.1. An absent or
  // older receipt cannot bind its bytes; legacy plural evidence is separate.
  let verifiedThreatModelRaw = runJsonRaw || threatModelRaw === undefined ? threatModelRaw : null
  let allowLegacyPlural = runJsonRaw === undefined
  if (runJsonRaw) {
    try {
      const run = JSON.parse(runJsonRaw) as {
        schema_version?: unknown
        result_manifest?: { schema_version?: unknown; artifacts?: Record<string, unknown> }
      }
      allowLegacyPlural = run.schema_version === "1.0" && run.result_manifest === undefined
      if (run.schema_version !== "1.1" && threatModelRaw !== undefined) {
        verifiedThreatModelRaw = null
      } else if (run.schema_version === "1.1" || run.result_manifest !== undefined) {
        const entry = run.result_manifest?.artifacts?.["threat_model.json"] as
          { path?: unknown; bytes?: unknown; sha256?: unknown } | undefined
        if (entry !== undefined || threatModelRaw !== undefined) {
          const digest =
            typeof threatModelRaw === "string"
              ? createHash("sha256").update(threatModelRaw, "utf8").digest("hex")
              : null
          if (
            run.result_manifest?.schema_version !== 1 ||
            entry?.path !== "threat_model.json" ||
            entry?.bytes !== Buffer.byteLength(threatModelRaw ?? "", "utf8") ||
            typeof entry?.sha256 !== "string" ||
            entry.sha256 !== digest
          ) {
            verifiedThreatModelRaw = null
            logger.warn("threat_model.json missing or differs from run manifest", { outputDir })
          }
        }
      }
    } catch {
      // The run parser reports malformed run.json; never accept its unbound evidence.
      verifiedThreatModelRaw = null
    }
  }
  const artifacts: EngineArtifactInput = {
    coverageRaw: await readOptionalArtifact("coverage.json", MAX_ENGINE_COVERAGE_BYTES),
    // The owned engine exports singular threat_model.json. A plural artifact
    // is read only as an explicit pre-contract compatibility fallback.
    threatModelsRaw:
      allowLegacyPlural && verifiedThreatModelRaw === undefined
        ? await readOptionalArtifact("threat_models.json", MAX_ENGINE_THREAT_MODEL_BYTES)
        : verifiedThreatModelRaw,
    httpExchangesRaw: await readOptionalArtifact(
      "http_exchanges.json",
      MAX_ENGINE_HTTP_EXCHANGES_BYTES
    ),
  }

  return { vulnerabilitiesRaw, runJsonRaw, artifacts }
}
export async function cleanupEngineWorkspace(workDir: string, runName?: string): Promise<void> {
  const targets: string[] = []
  const workspace = resolve(workDir)
  const workspaceFromRoot = relative(ENGINE_WORK_ROOT, workspace)
  if (
    workspaceFromRoot &&
    workspaceFromRoot !== ".." &&
    !workspaceFromRoot.startsWith(`..${sep}`)
  ) {
    targets.push(workspace)
  } else {
    logger.warn("Refusing to clean an engine workspace outside the owned run root", { workDir })
  }

  if (runName && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runName) && !runName.includes("..")) {
    const checkoutPrefix = `repo_${runName}_`
    try {
      // ENGINE_CHECKOUT_ROOT is a fixed worker-owned temporary directory.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      for (const entry of await readdir(ENGINE_CHECKOUT_ROOT)) {
        if (!entry.startsWith(checkoutPrefix)) continue
        const checkoutDir = resolve(ENGINE_CHECKOUT_ROOT, entry)
        if (relative(ENGINE_CHECKOUT_ROOT, checkoutDir) !== entry) continue
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        const checkoutStat = await lstat(checkoutDir)
        if (checkoutStat.isDirectory() && !checkoutStat.isSymbolicLink()) targets.push(checkoutDir)
      }
    } catch {
      // The engine may fail before cloning, so no checkout directory is normal.
    }
  }

  const failures: Error[] = []
  for (const target of targets) {
    try {
      await rm(target, { recursive: true, force: true })
    } catch (err) {
      failures.push(err instanceof Error ? err : new Error(String(err)))
      logger.warn("Failed to clean up engine-owned files", {
        target,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `Failed to remove ${failures.length} engine workspace path(s)`
    )
  }
  logger.info("Engine workspace cleaned up", { workDir, removedPaths: targets.length })
}
