import { readFile } from "node:fs/promises"
import { execFile as nodeExecFile } from "node:child_process"
import { promisify, parseArgs } from "node:util"
import { pathToFileURL } from "node:url"
import { getSystemPrisma, prisma, withWorkspaceRLS, type ScanStatus } from "@lyrashield/db"
import {
  getRedis,
  getWebhookTrackRetryQueue,
  SCAN_ADMISSION_STOP_KEY,
} from "@lyrashield/integrations"
import { resolveWorkerExecutionProvenance } from "@lyrashield/config"
import { reconcileScanQueue } from "../queue-reconciliation"
import { findOldestTerminalUnreconciledCost } from "../operational-health"
import { getScanQueue } from "../queue"
import {
  ACTIVE_SCAN_STATUSES,
  DEFAULT_STEP_TIMEOUT_MS,
  parseLaunchAssuranceOptions,
  type LaunchAssuranceDeps,
} from "./verify-launch-assurance-contract"
import { verifyLaunchAssurance } from "./verify-launch-assurance-run"

export type {
  LaunchAssuranceDeps,
  LaunchAssuranceOptions,
  LaunchAssuranceReceipt,
  StepRecord,
  StepStatus,
} from "./verify-launch-assurance-contract"
export { parseLaunchAssuranceOptions } from "./verify-launch-assurance-contract"
export { assertSelectedScanQueueIsolation } from "./verify-launch-assurance-steps"
export { verifyLaunchAssurance } from "./verify-launch-assurance-run"

const nodeExecFileAsync = promisify(nodeExecFile)

export async function listGlobalActiveScans(): Promise<Array<{ id: string; status: ScanStatus }>> {
  return getSystemPrisma().scan.findMany({
    where: { deletedAt: null, status: { in: [...ACTIVE_SCAN_STATUSES] } },
    select: { id: true, status: true },
  })
}
// ── CLI entrypoint ──────────────────────────────────────────────────────────

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // pnpm forwards a literal "--" before the script args in some shells.
  const forwardedArgs = process.argv.slice(2)
  const args = forwardedArgs[0] === "--" ? forwardedArgs.slice(1) : forwardedArgs
  const { values } = parseArgs({
    args,
    options: {
      "dry-run": { type: "boolean", default: false },
      "allow-storage-proof": { type: "boolean", default: false },
      "worker-image": { type: "string" },
      "worker-env-file": { type: "string" },
      "egress-pin-file": { type: "string" },
      "allow-failure-injection": { type: "boolean", default: false },
      "scan-id": { type: "string" },
      "workspace-id": { type: "string" },
      environment: { type: "string" },
      "confirm-production": { type: "string" },
      "incident-commander": { type: "string" },
      "azure-resource-group": { type: "string" },
    },
    strict: true,
  })

  const deps: LaunchAssuranceDeps = {
    fetch: globalThis.fetch,
    execFile: async (command, args) => {
      const { stdout, stderr } = await nodeExecFileAsync(command, args, {
        timeout: DEFAULT_STEP_TIMEOUT_MS,
      })
      return { stdout: String(stdout), stderr: String(stderr) }
    },
    now: () => new Date(),
    // The pin file path is operator-supplied CLI configuration, not attacker input.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    readFile: async (path) => readFile(path, "utf8"),
    reconcile: reconcileScanQueue,
    listActiveScans: listGlobalActiveScans,
    getScanState: async (scanId, workspaceId) => {
      const scan = await prisma.scan.findFirst({
        where: { id: scanId, workspaceId, deletedAt: null },
        select: { id: true, workspaceId: true, status: true },
      })
      if (!scan) throw new Error(`scan not found: ${scanId}`)
      return scan
    },
    countEngineStartsSince: async (scanId, workspaceId, since) =>
      withWorkspaceRLS(workspaceId, (tx) =>
        tx.scanEvent.count({
          where: { scanId, stage: "engine_start", createdAt: { gt: since }, deletedAt: null },
        })
      ),
    hasTerminalCostUncertainty: async (now) =>
      (await findOldestTerminalUnreconciledCost(now)) !== null,
    resolveProvenance: resolveWorkerExecutionProvenance,
    getFailureInjectionOperationalState: async () => {
      const redis = getRedis()
      if (!redis) throw new Error("REDIS_URL is required for failure-injection preflight")
      const scanQueue = getScanQueue()
      const webhookQueue = getWebhookTrackRetryQueue()
      const [
        admissionStopped,
        enabledScheduleCount,
        waitingJobs,
        activeJobs,
        delayedJobs,
        prioritizedJobs,
        webhookCounts,
      ] = await Promise.all([
        redis.exists(SCAN_ADMISSION_STOP_KEY),
        getSystemPrisma().schedule.count({ where: { enabled: true } }),
        scanQueue.getJobs(["wait"], 0, -1, true),
        scanQueue.getJobs(["active"], 0, -1, true),
        scanQueue.getJobs(["delayed"], 0, -1, true),
        scanQueue.getJobs(["prioritized"], 0, -1, true),
        webhookQueue.getJobCounts("wait", "active", "delayed", "prioritized"),
      ])
      return {
        admissionStopped: admissionStopped === 1,
        enabledScheduleCount,
        scanJobs: [
          ...waitingJobs.map((job) => ({ id: String(job.id ?? ""), state: "waiting" as const })),
          ...activeJobs.map((job) => ({ id: String(job.id ?? ""), state: "active" as const })),
          ...delayedJobs.map((job) => ({ id: String(job.id ?? ""), state: "delayed" as const })),
          ...prioritizedJobs.map((job) => ({
            id: String(job.id ?? ""),
            state: "prioritized" as const,
          })),
        ],
        webhookQueueDepth: Object.values(webhookCounts).reduce((sum, count) => sum + count, 0),
      }
    },
  }

  try {
    const options = parseLaunchAssuranceOptions(values)
    verifyLaunchAssurance(options, deps)
      .then((receipt) => {
        console.log(JSON.stringify(receipt, null, 2))
        process.exit(receipt.overall === "failed" ? 1 : 0)
      })
      .catch((error) => {
        console.error(error instanceof Error ? error.message : String(error))
        process.exit(2)
      })
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(2)
  }
}
