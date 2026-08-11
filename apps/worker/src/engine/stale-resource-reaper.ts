import { execFile } from "child_process"
import { lstat, readdir, rm, stat } from "fs/promises"
import { tmpdir } from "os"
import { join, resolve } from "path"
import { promisify } from "util"
import { getSystemPrisma, type ScanStatus } from "@lyrashield/db"
import { env } from "@lyrashield/config"
import { logger } from "@lyrashield/logger"

const execFileAsync = promisify(execFile)
const ACTIVE_SCAN_STATUSES: ScanStatus[] = ["QUEUED", "PREFLIGHT", "RUNNING", "VERIFYING"]
const CHECKOUT_ROOT = resolve(tmpdir(), "strix_repos")
const RUN_ROOT = resolve(env.LYRASHIELD_ENGINE_WORK_ROOT?.trim() || process.cwd(), "lyrashield_runs")
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const CUID_RUN_ID = /^c[a-z0-9]{24}$/

export interface StaleContainer {
  id: string
  scanId: string
  createdAt: number
  running: boolean
}

export interface StaleDirectory {
  path: string
  scanId: string
  modifiedAt: number
}

export interface StaleResourceReaperDependencies {
  activeScanIds: () => Promise<Set<string>>
  containers: () => Promise<StaleContainer[]>
  removeContainer: (containerId: string) => Promise<void>
  directories: (activeScanIds: Set<string>) => Promise<StaleDirectory[]>
  removeDirectory: (path: string) => Promise<void>
}

export interface StaleResourceReaperResult {
  containersRemoved: number
  directoriesRemoved: number
  skippedActive: number
  skippedRunning: number
}

function isOwnedRunId(value: string): boolean {
  return RUN_ID.test(value) && !value.includes("..")
}

async function activeScanIds(): Promise<Set<string>> {
  const scans = await getSystemPrisma().scan.findMany({
    where: { status: { in: ACTIVE_SCAN_STATUSES } },
    select: { id: true },
  })
  return new Set(scans.map((scan) => scan.id))
}

async function containers(): Promise<StaleContainer[]> {
  const { stdout } = await execFileAsync(
    "docker",
    ["container", "ls", "--all", "--quiet", "--filter", "label=strix-run-id"],
    { timeout: 10_000, maxBuffer: 64 * 1024 }
  )
  const ids = stdout.split(/\s+/).filter(Boolean)
  if (ids.length === 0) return []

  const inspected = await execFileAsync("docker", ["container", "inspect", ...ids], {
    timeout: 10_000,
    maxBuffer: 512 * 1024,
  })
  const records = JSON.parse(inspected.stdout) as Array<{
    Id?: unknown
    Created?: unknown
    State?: { Running?: unknown }
    Config?: { Labels?: Record<string, unknown> }
  }>
  return records.flatMap((record) => {
    const id = typeof record.Id === "string" ? record.Id : ""
    const scanId = record.Config?.Labels?.["strix-run-id"]
    const createdAt = typeof record.Created === "string" ? Date.parse(record.Created) : Number.NaN
    if (!id || typeof scanId !== "string" || !isOwnedRunId(scanId) || Number.isNaN(createdAt)) return []
    return [{ id, scanId, createdAt, running: record.State?.Running === true }]
  })
}

async function ownedDirectory(
  path: string,
  scanId: string
): Promise<StaleDirectory | null> {
  try {
    // path is constructed only from the fixed reaper roots and a readdir entry.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const metadata = await lstat(path)
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return null
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    return { path, scanId, modifiedAt: (await stat(path)).mtimeMs }
  } catch {
    return null
  }
}

async function directories(activeIds: Set<string>): Promise<StaleDirectory[]> {
  const result: StaleDirectory[] = []
  try {
    // RUN_ROOT is fixed by worker configuration, never scan input.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    for (const entry of await readdir(RUN_ROOT)) {
      if (!isOwnedRunId(entry)) continue
      const item = await ownedDirectory(join(RUN_ROOT, entry), entry)
      if (item) result.push(item)
    }
  } catch {
    // No run directory yet is normal for a new worker.
  }

  try {
    // CHECKOUT_ROOT is the engine's fixed temporary root.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    for (const entry of await readdir(CHECKOUT_ROOT)) {
      const match = /^repo_(c[a-z0-9]{24})_/.exec(entry)
      const activeScanId = [...activeIds].find((scanId) => entry.startsWith(`repo_${scanId}_`))
      const scanId = activeScanId ?? match?.[1]
      if (!scanId || (!activeScanId && !CUID_RUN_ID.test(scanId))) continue
      const item = await ownedDirectory(join(CHECKOUT_ROOT, entry), scanId)
      if (item) result.push(item)
    }
  } catch {
    // The engine creates this temporary root only after the first repository clone.
  }
  return result
}

async function removeContainer(containerId: string): Promise<void> {
  await execFileAsync("docker", ["container", "rm", "--force", containerId], {
    timeout: 20_000,
    maxBuffer: 64 * 1024,
  })
}

async function removeDirectory(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true })
}

const defaults: StaleResourceReaperDependencies = {
  activeScanIds,
  containers,
  removeContainer,
  directories,
  removeDirectory,
}

/**
 * Bounded recovery for resources left behind by a worker/process crash. A
 * database read is the ownership authority: if it fails, no cleanup occurs.
 */
export async function reapStaleScanResources({
  dependencies = defaults,
  now = Date.now(),
  minimumAgeMs,
}: {
  dependencies?: StaleResourceReaperDependencies
  now?: number
  minimumAgeMs: number
}): Promise<StaleResourceReaperResult> {
  const empty = { containersRemoved: 0, directoriesRemoved: 0, skippedActive: 0, skippedRunning: 0 }
  let activeIds: Set<string>
  try {
    activeIds = await dependencies.activeScanIds()
  } catch (error) {
    logger.warn("Stale-resource reaper skipped because active scan ownership is unavailable", {
      error: error instanceof Error ? error.message : String(error),
    })
    return empty
  }

  const staleBefore = now - minimumAgeMs
  const result = { ...empty }
  for (const container of await dependencies.containers()) {
    if (container.running) {
      result.skippedRunning += 1
      continue
    }
    if (activeIds.has(container.scanId)) {
      result.skippedActive += 1
      continue
    }
    if (container.createdAt > staleBefore) continue
    try {
      await dependencies.removeContainer(container.id)
      result.containersRemoved += 1
    } catch (error) {
      logger.warn("Stale-resource reaper could not remove container", {
        containerId: container.id,
        scanId: container.scanId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  for (const directory of await dependencies.directories(activeIds)) {
    if (activeIds.has(directory.scanId)) {
      result.skippedActive += 1
      continue
    }
    if (directory.modifiedAt > staleBefore) continue
    try {
      await dependencies.removeDirectory(directory.path)
      result.directoriesRemoved += 1
    } catch (error) {
      logger.warn("Stale-resource reaper could not remove directory", {
        path: directory.path,
        scanId: directory.scanId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return result
}
