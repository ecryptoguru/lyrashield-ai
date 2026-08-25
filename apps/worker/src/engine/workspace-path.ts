import { tmpdir } from "node:os"
import { relative, resolve, sep } from "node:path"
import { env } from "@lyrashield/config"

const configuredRoot = env.LYRASHIELD_ENGINE_WORK_ROOT?.trim() || process.cwd()
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export const ENGINE_WORK_ROOT = resolve(configuredRoot, "lyrashield_runs")
export const ENGINE_CHECKOUT_ROOT = resolve(tmpdir(), "strix_repos")

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
