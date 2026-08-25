import { constants } from "node:fs"
import { access, lstat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { relative, resolve, sep } from "node:path"
import { env } from "@lyrashield/config"

const configuredRoot = env.LYRASHIELD_ENGINE_WORK_ROOT?.trim() || process.cwd()
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export const ENGINE_WORK_ROOT = resolve(configuredRoot, "lyrashield_runs")
export const ENGINE_TEMP_ROOT = resolve(tmpdir())
export const ENGINE_CHECKOUT_ROOT = resolve(ENGINE_TEMP_ROOT, "strix_repos")

export async function assertEngineTempRootReady(): Promise<void> {
  // The host Docker daemon consumes checkout paths from this directory. A
  // symlinked or unwritable root could redirect sandbox mounts or fail only
  // after a paid job starts, so reject it before the worker becomes ready.
  // ENGINE_TEMP_ROOT is derived from the process temp-directory contract.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const rootStat = await lstat(ENGINE_TEMP_ROOT)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Engine temp root must be a real directory")
  }
  await access(ENGINE_TEMP_ROOT, constants.W_OK | constants.X_OK)
}

export function engineWorkspacePath(scanId: string): string {
  if (!RUN_ID.test(scanId) || scanId.includes("..")) {
    throw new Error("Invalid engine workspace scan ID")
  }
  const workspace = resolve(ENGINE_WORK_ROOT, scanId)
  const pathFromRoot = relative(ENGINE_WORK_ROOT, workspace)
  if (!pathFromRoot || pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`)) {
    throw new Error("Invalid engine workspace scan ID")
  }
  return workspace
}
