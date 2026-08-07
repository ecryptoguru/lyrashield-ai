import { freemem, cpus, tmpdir } from "os"
import { statfs } from "fs/promises"
import { prisma } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import { addScanEvent } from "@lyrashield/db"
import { checkScanUrlSafe } from "@lyrashield/security"

export interface PreflightResult {
  passed: boolean
  checks: PreflightCheck[]
  errorCategory?: string
  errorMessage?: string
}

export interface PreflightCheck {
  name: string
  passed: boolean
  message: string
}

/**
 * Parse a Docker-style memory limit string (e.g. "4g", "512m", "1024k", "b")
 * into bytes. Returns null for unparseable input.
 */
function parseMemoryLimit(limit: string): number | null {
  const match = /^(\d+(?:\.\d+)?)\s*([kmgt]?b?)$/i.exec(limit.trim())
  if (!match || match[1] === undefined || match[2] === undefined) return null
  const value = parseFloat(match[1])
  if (!Number.isFinite(value) || value <= 0) return null
  const unit = match[2].toLowerCase()
  const multipliers: Record<string, number> = {
    b: 1,
    kb: 1024,
    k: 1024,
    mb: 1024 ** 2,
    m: 1024 ** 2,
    gb: 1024 ** 3,
    g: 1024 ** 3,
    tb: 1024 ** 4,
    t: 1024 ** 4,
  }
  const multiplier = multipliers[unit]
  if (!multiplier) return null
  return Math.floor(value * multiplier)
}

/**
 * Pre-flight resource check: verify the host has enough free memory, CPU
 * cores, and disk space to run a Docker sandbox without oversubscribing.
 * Returns a PreflightCheck — the check is advisory (warns but does not block)
 * when resources are marginal, and fails when critically insufficient.
 */
async function checkSandboxResources(): Promise<PreflightCheck> {
  const memLimitStr = process.env.STRIX_SANDBOX_MEM_LIMIT?.trim() || "4g"
  const cpuLimitStr = process.env.STRIX_SANDBOX_CPUS?.trim() || "2"
  const requiredMemBytes = parseMemoryLimit(memLimitStr)
  const requiredCpus = parseInt(cpuLimitStr, 10)

  const issues: string[] = []

  // Memory: require at least the sandbox limit in free memory.
  const freeMemBytes = freemem()
  if (requiredMemBytes && freeMemBytes < requiredMemBytes) {
    issues.push(
      `free memory ${Math.round(freeMemBytes / 1024 / 1024)}MB < sandbox limit ${Math.round(requiredMemBytes / 1024 / 1024)}MB`
    )
  }

  // CPU: require at least the sandbox CPU allocation in available cores.
  const availableCpus = cpus().length
  if (Number.isFinite(requiredCpus) && requiredCpus > 0 && availableCpus < requiredCpus) {
    issues.push(`available CPUs ${availableCpus} < sandbox limit ${requiredCpus}`)
  }

  // Disk: require at least the configured minimum free in the temp directory
  // for engine workspaces. Default 2GB; override via STRIX_SANDBOX_MIN_DISK_MB.
  const minDiskMb = parseInt(process.env.STRIX_SANDBOX_MIN_DISK_MB?.trim() || "2048", 10)
  const minDiskBytes = (Number.isFinite(minDiskMb) && minDiskMb > 0 ? minDiskMb : 2048) * 1024 ** 2
  try {
    const stats = await statfs(tmpdir())
    const freeDiskBytes = stats.bavail * stats.bsize
    if (freeDiskBytes < minDiskBytes) {
      issues.push(
        `free disk ${Math.round(freeDiskBytes / 1024 / 1024)}MB < minimum ${Math.round(minDiskBytes / 1024 / 1024)}MB`
      )
    }
  } catch {
    // statfs may fail on some filesystems; treat as a non-blocking warning.
    issues.push("disk space check could not be completed")
  }

  if (issues.length > 0) {
    return {
      name: "sandbox_resources",
      passed: false,
      message: `Insufficient host resources for sandbox: ${issues.join("; ")}`,
    }
  }

  return {
    name: "sandbox_resources",
    passed: true,
    message: `Host resources OK (free mem ${Math.round(freeMemBytes / 1024 / 1024)}MB, CPUs ${availableCpus})`,
  }
}

export async function runPreflight(scanId: string, targetId: string): Promise<PreflightResult> {
  const checks: PreflightCheck[] = []

  const target = await prisma.target.findFirst({
    where: { id: targetId, deletedAt: null },
    select: { type: true, name: true, url: true, repoFullName: true },
  })

  if (!target) {
    checks.push({ name: "target_exists", passed: false, message: "Target not found or deleted" })
    return { passed: false, checks, errorCategory: "PREFLIGHT", errorMessage: "Target not found" }
  }
  checks.push({
    name: "target_exists",
    passed: true,
    message: `Target: ${target.name} (${target.type})`,
  })

  if (target.type === "REPO") {
    if (!target.repoFullName) {
      checks.push({
        name: "repo_configured",
        passed: false,
        message: "Repository full name not set",
      })
      return {
        passed: false,
        checks,
        errorCategory: "PREFLIGHT",
        errorMessage: "Repository not configured",
      }
    }
    checks.push({ name: "repo_configured", passed: true, message: `Repo: ${target.repoFullName}` })

    // REPO scans run a Docker sandbox with configured resource limits.
    // Verify the host has enough free memory, CPU, and disk before starting.
    const resourceCheck = await checkSandboxResources()
    checks.push(resourceCheck)
    if (!resourceCheck.passed) {
      return {
        passed: false,
        checks,
        errorCategory: "PREFLIGHT",
        errorMessage: resourceCheck.message,
      }
    }
  } else if (
    target.type === "WEB_APP" ||
    target.type === "API" ||
    target.type === "CLOUD_ACCOUNT" ||
    target.type === "CONTAINER" ||
    target.type === "IAC"
  ) {
    if (!target.url) {
      checks.push({ name: "url_configured", passed: false, message: "URL not set" })
      return {
        passed: false,
        checks,
        errorCategory: "PREFLIGHT",
        errorMessage: "URL not configured",
      }
    }
    checks.push({ name: "url_configured", passed: true, message: `URL: ${target.url}` })

    // Re-validate the target URL for SSRF safety at scan time, not just at
    // target-creation time. Guards against a URL that was created before a
    // hardening change, or whose DNS now resolves to a private/metadata/reserved
    // address (rebinding). The worker's fetch layer pins the resolved IP; this
    // check fails fast before the engine ever runs.
    const ssrf = await checkScanUrlSafe(target.url)
    if (!ssrf.safe) {
      checks.push({
        name: "url_ssrf_safe",
        passed: false,
        message: `URL failed SSRF safety check: ${ssrf.reason}`,
      })
      return {
        passed: false,
        checks,
        errorCategory: "PREFLIGHT",
        errorMessage: `Target URL is not safe to scan (${ssrf.reason})`,
      }
    }
    checks.push({ name: "url_ssrf_safe", passed: true, message: "URL passed SSRF safety check" })
  }

  const activeScans = await prisma.scan.count({
    where: {
      targetId,
      status: { in: ["QUEUED", "PREFLIGHT", "RUNNING", "VERIFYING"] },
    },
  })
  if (activeScans > 1) {
    checks.push({
      name: "no_concurrent_scan",
      passed: false,
      message: `Target already has ${activeScans - 1} active scan(s)`,
    })
    return {
      passed: false,
      checks,
      errorCategory: "PREFLIGHT",
      errorMessage: "Concurrent scan already running",
    }
  }
  checks.push({ name: "no_concurrent_scan", passed: true, message: "No concurrent scans" })

  try {
    await addScanEvent(
      scanId,
      "preflight",
      "info",
      `Preflight completed: ${checks.length} checks, all passed`,
      {
        checks: checks.map((c) => ({ name: c.name, passed: c.passed })),
      }
    )
  } catch (eventErr) {
    logger.warn("Failed to persist preflight event", {
      scanId,
      error: eventErr instanceof Error ? eventErr.message : String(eventErr),
    })
  }

  logger.info("Preflight passed", { scanId, targetId, checks: checks.length })
  return { passed: true, checks }
}
