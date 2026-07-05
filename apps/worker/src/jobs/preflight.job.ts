import { prisma } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import { addScanEvent } from "@lyrashield/db"

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

export async function runPreflight(scanId: string, targetId: string): Promise<PreflightResult> {
  const checks: PreflightCheck[] = []

  const target = await prisma.target.findFirst({
    where: { id: targetId, deletedAt: null },
  })

  if (!target) {
    checks.push({ name: "target_exists", passed: false, message: "Target not found or deleted" })
    return { passed: false, checks, errorCategory: "PREFLIGHT", errorMessage: "Target not found" }
  }
  checks.push({ name: "target_exists", passed: true, message: `Target: ${target.name} (${target.type})` })

  if (target.type === "REPO") {
    if (!target.repoFullName) {
      checks.push({ name: "repo_configured", passed: false, message: "Repository full name not set" })
      return { passed: false, checks, errorCategory: "PREFLIGHT", errorMessage: "Repository not configured" }
    }
    checks.push({ name: "repo_configured", passed: true, message: `Repo: ${target.repoFullName}` })
  } else if (target.type === "WEB_APP" || target.type === "API" || target.type === "CLOUD_ACCOUNT" || target.type === "CONTAINER" || target.type === "IAC") {
    if (!target.url) {
      checks.push({ name: "url_configured", passed: false, message: "URL not set" })
      return { passed: false, checks, errorCategory: "PREFLIGHT", errorMessage: "URL not configured" }
    }
    checks.push({ name: "url_configured", passed: true, message: `URL: ${target.url}` })
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
    return { passed: false, checks, errorCategory: "PREFLIGHT", errorMessage: "Concurrent scan already running" }
  }
  checks.push({ name: "no_concurrent_scan", passed: true, message: "No concurrent scans" })

  try {
    await addScanEvent(scanId, "preflight", "info", `Preflight completed: ${checks.length} checks, all passed`, {
      checks: checks.map((c) => ({ name: c.name, passed: c.passed })),
    })
  } catch (eventErr) {
    logger.warn("Failed to persist preflight event", {
      scanId,
      error: eventErr instanceof Error ? eventErr.message : String(eventErr),
    })
  }

  logger.info("Preflight passed", { scanId, targetId, checks: checks.length })
  return { passed: true, checks }
}
