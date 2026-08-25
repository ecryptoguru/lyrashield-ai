import { createHash, randomUUID } from "node:crypto"
import { execFile as nodeExecFile } from "node:child_process"
import { parseArgs, promisify } from "node:util"
import { pathToFileURL } from "node:url"
import {
  cancelScan,
  createScan,
  deleteUserAccount,
  getAccountDeletionPlan,
  getSystemPrisma,
  isTerminalScanStatus,
  prisma,
  removeScan,
  TERMINAL_SCAN_STATUSES,
  withWorkspaceRLS,
  type ScanStatus,
} from "@lyrashield/db"
import {
  resolveWorkerExecutionProvenanceFrom,
  type WorkerExecutionProvenance,
} from "@lyrashield/config"
import {
  closeRedis,
  getRedis,
  getWebhookTrackRetryQueue,
  isScanWorkerAvailable,
  SCAN_ADMISSION_STOP_KEY,
} from "@lyrashield/integrations"
import { getScanQueue } from "../queue"
import { QUEUE_ORPHAN_GRACE_MS, reconcileExactQueuedScanOrphan } from "../queue-reconciliation"

const nodeExecFileAsync = promisify(nodeExecFile)
let runtimeQueuesOpened = false

const CONFIRMATION_PHRASE = "I AUTHORIZE LYRASHIELD QUEUE ORPHAN FIXTURE"
const FIXTURE_WAIT_MS = QUEUE_ORPHAN_GRACE_MS + 5_000

export interface QueueOrphanFixtureOptions {
  environment?: string
  confirmProduction?: string
}

interface FixtureIds {
  userId: string
  workspaceId: string
  workspaceName: string
  targetId: string
  scanId: string
}

interface FixtureDeletionPlan {
  deletable: Array<{ id: string; name: string }>
  blocked: Array<{ id: string; name: string }>
  retained: Array<{ id: string; name: string }>
}

interface FixtureState {
  status: ScanStatus
  errorCategory: string | null
  errorMessage: string | null
  engineStartCount: number
  auditCount: number
  jobExists: boolean
  queueDepth: number
}

interface FixturePreflight {
  admissionStopped: boolean
  workerAvailable: boolean
  serviceState: string
  containerRunning: boolean
  imageReference: string
  provenance: WorkerExecutionProvenance
  runtimeBindingFingerprints: {
    database: string
    systemDatabase: string
    redis: string
  }
  activeScanIds: string[]
  enabledScheduleCount: number
  queueDepth: number
}

export interface QueueOrphanFixtureDeps {
  preflight(): Promise<FixturePreflight>
  createFixture(): Promise<FixtureIds>
  wait(ms: number): Promise<void>
  reconcile(
    fixture: FixtureIds,
    now: Date
  ): Promise<{
    leaseAcquired: boolean
    reconciled: boolean
    jobState: string | null
  }>
  inspectFixture(fixture: FixtureIds): Promise<FixtureState>
  cleanupFixture(fixture: FixtureIds): Promise<void>
  retainAuditReceipt(
    fixture: FixtureIds,
    preflight: FixturePreflight,
    state: FixtureState,
    reconciledAt: Date
  ): Promise<string>
  retainCleanupAuditReceipt(
    fixture: FixtureIds,
    verificationReceiptId: string,
    cleanedUpAt: Date
  ): Promise<string>
  now(): Date
}

export interface QueueOrphanFixtureReceipt {
  overall: "passed"
  timestamp: string
  workspaceId: string
  scanId: string
  waitedMs: number
  provenance: WorkerExecutionProvenance
  runtimeStopProof: {
    serviceState: string
    containerRunning: false
    imageReference: string
  }
  runtimeBindingFingerprints: FixturePreflight["runtimeBindingFingerprints"]
  retainedAuditReceiptId: string
  retainedCleanupAuditReceiptId: string
  reconciliation: {
    reconciled: true
    jobState: "missing" | "failed" | "completed"
  }
  cleanup: "passed"
}

export function parseQueueOrphanFixtureOptions(
  values: Record<string, unknown>
): QueueOrphanFixtureOptions {
  const options = {
    environment: typeof values.environment === "string" ? values.environment : undefined,
    confirmProduction:
      typeof values["confirm-production"] === "string" ? values["confirm-production"] : undefined,
  }
  if (options.environment !== "production") {
    throw new Error("queue orphan fixture requires --environment production")
  }
  if (options.confirmProduction !== CONFIRMATION_PHRASE) {
    throw new Error("queue orphan fixture requires the exact --confirm-production phrase")
  }
  return options
}

export async function verifyQueueOrphanFixture(
  options: QueueOrphanFixtureOptions,
  deps: QueueOrphanFixtureDeps
): Promise<QueueOrphanFixtureReceipt> {
  parseQueueOrphanFixtureOptions({
    environment: options.environment,
    "confirm-production": options.confirmProduction,
  })
  const preflight = await deps.preflight()
  assertFixturePreflight(preflight, [])

  const fixture = await deps.createFixture()
  let cleanupCompleted = false
  try {
    await deps.wait(FIXTURE_WAIT_MS)
    const finalPreflight = await deps.preflight()
    assertFixturePreflight(finalPreflight, [fixture.scanId])
    if (
      JSON.stringify(finalPreflight.provenance) !== JSON.stringify(preflight.provenance) ||
      finalPreflight.imageReference !== preflight.imageReference ||
      JSON.stringify(finalPreflight.runtimeBindingFingerprints) !==
        JSON.stringify(preflight.runtimeBindingFingerprints)
    ) {
      throw new Error("worker provenance changed during fixture wait")
    }
    const reconciliation = await deps.reconcile(fixture, deps.now())
    if (!reconciliation.leaseAcquired) throw new Error("queue reconciliation lease not acquired")
    if (!reconciliation.reconciled) {
      throw new Error(`fixture was not reconciled (job state ${reconciliation.jobState ?? "none"})`)
    }
    if (
      reconciliation.jobState !== "missing" &&
      reconciliation.jobState !== "failed" &&
      reconciliation.jobState !== "completed"
    ) {
      throw new Error(`unexpected reconciled job state ${reconciliation.jobState ?? "none"}`)
    }
    const postReconciliationPreflight = await deps.preflight()
    assertFixturePreflight(postReconciliationPreflight, [])
    if (
      JSON.stringify(postReconciliationPreflight.provenance) !==
        JSON.stringify(preflight.provenance) ||
      postReconciliationPreflight.imageReference !== preflight.imageReference ||
      JSON.stringify(postReconciliationPreflight.runtimeBindingFingerprints) !==
        JSON.stringify(preflight.runtimeBindingFingerprints)
    ) {
      throw new Error("worker provenance changed during reconciliation")
    }

    const state = await deps.inspectFixture(fixture)
    if (
      state.status !== "FAILED" ||
      state.errorCategory !== "QUEUE" ||
      !state.errorMessage?.startsWith("QUEUE_ORPHANED:")
    ) {
      throw new Error(`fixture did not fail closed (${state.status})`)
    }
    if (state.engineStartCount !== 0) throw new Error("fixture reached engine execution")
    if (state.auditCount !== 1) throw new Error("fixture creation audit is missing or duplicated")
    if (state.jobExists || state.queueDepth !== 0) {
      throw new Error("queue is not empty after targeted reconciliation")
    }

    const reconciledAt = deps.now()
    const retainedAuditReceiptId = await deps.retainAuditReceipt(
      fixture,
      preflight,
      state,
      reconciledAt
    )
    await deps.cleanupFixture(fixture)
    cleanupCompleted = true
    const cleanedUpAt = deps.now()
    const retainedCleanupAuditReceiptId = await deps.retainCleanupAuditReceipt(
      fixture,
      retainedAuditReceiptId,
      cleanedUpAt
    )
    return {
      overall: "passed",
      timestamp: reconciledAt.toISOString(),
      workspaceId: fixture.workspaceId,
      scanId: fixture.scanId,
      waitedMs: FIXTURE_WAIT_MS,
      provenance: preflight.provenance,
      runtimeStopProof: {
        serviceState: preflight.serviceState,
        containerRunning: false,
        imageReference: preflight.imageReference,
      },
      runtimeBindingFingerprints: preflight.runtimeBindingFingerprints,
      retainedAuditReceiptId,
      retainedCleanupAuditReceiptId,
      reconciliation: {
        reconciled: true,
        jobState: reconciliation.jobState,
      },
      cleanup: "passed",
    }
  } finally {
    if (!cleanupCompleted) await deps.cleanupFixture(fixture)
  }
}

function endpointFingerprint(raw: string, name: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`${name} is not a valid URL`)
  }
  const endpoint = `${url.protocol}//${url.hostname.toLowerCase()}:${url.port || "default"}${url.pathname}`
  return createHash("sha256").update(endpoint, "utf8").digest("hex")
}

function bindRuntimeEndpoint(
  containerEnv: Record<string, string>,
  name: "DATABASE_URL" | "DATABASE_SYSTEM_URL" | "REDIS_URL"
): string {
  const containerValue = containerEnv[name]
  const processValue = process.env[name]
  if (!containerValue || !processValue || containerValue !== processValue) {
    throw new Error(`${name} does not exactly match the stopped worker container`)
  }
  return endpointFingerprint(processValue, name)
}

export function parseContainerEnvironment(output: string): Record<string, string> {
  return Object.fromEntries(
    output.split("\n").flatMap((line) => {
      const separator = line.indexOf("=")
      return separator > 0 ? [[line.slice(0, separator), line.slice(separator + 1)]] : []
    })
  )
}

function assertFixturePreflight(
  preflight: FixturePreflight,
  expectedActiveScanIds: string[]
): void {
  if (!preflight.admissionStopped) throw new Error("scan admission must be stopped")
  if (preflight.workerAvailable) throw new Error("scan worker readiness lease still exists")
  if (preflight.serviceState !== "inactive" || preflight.containerRunning) {
    throw new Error("worker service and container must both be stopped")
  }
  if (preflight.enabledScheduleCount !== 0) throw new Error("enabled schedules exist")
  if (preflight.queueDepth !== 0) throw new Error("scan queue is not empty")
  if (
    preflight.activeScanIds.length !== expectedActiveScanIds.length ||
    preflight.activeScanIds.some((id, index) => id !== expectedActiveScanIds[index])
  ) {
    throw new Error("unexpected active scans exist")
  }
}

export function assertExactFixtureDeletionPlan(
  plan: FixtureDeletionPlan,
  fixture: Pick<FixtureIds, "workspaceId" | "workspaceName">
): void {
  const exactWorkspace = plan.deletable[0]
  if (
    plan.deletable.length !== 1 ||
    exactWorkspace?.id !== fixture.workspaceId ||
    exactWorkspace.name !== fixture.workspaceName ||
    plan.blocked.length !== 0 ||
    plan.retained.length !== 0
  ) {
    throw new Error("fixture deletion plan changed; manual cleanup is required")
  }
}

async function deleteExactFixtureAccount(
  userId: string,
  fixture: Pick<FixtureIds, "workspaceId" | "workspaceName">
): Promise<void> {
  const plan = await getAccountDeletionPlan(userId)
  assertExactFixtureDeletionPlan(plan, fixture)
  await deleteUserAccount(userId, fixture.workspaceName)
}

async function runtimePreflight(): Promise<FixturePreflight> {
  const redis = getRedis()
  if (!redis) throw new Error("REDIS_URL is required")
  const queue = getScanQueue()
  const webhookRetryQueue = getWebhookTrackRetryQueue()
  runtimeQueuesOpened = true
  const [serviceStateResult, containerStateResult, containerEnvResult, imageResult] =
    await Promise.all([
      nodeExecFileAsync("systemctl", [
        "show",
        "--property",
        "ActiveState",
        "--value",
        "lyrashield-worker.service",
      ]),
      nodeExecFileAsync("docker", [
        "inspect",
        "--format",
        "{{.State.Running}}",
        "lyrashield-worker",
      ]),
      nodeExecFileAsync("docker", [
        "inspect",
        "--format",
        "{{range .Config.Env}}{{println .}}{{end}}",
        "lyrashield-worker",
      ]),
      nodeExecFileAsync("docker", [
        "inspect",
        "--format",
        "{{.Config.Image}}",
        "lyrashield-worker",
      ]),
    ])
  const containerEnv = parseContainerEnvironment(String(containerEnvResult.stdout))
  const provenance = resolveWorkerExecutionProvenanceFrom({
    NODE_ENV: containerEnv.NODE_ENV,
    LYRASHIELD_PRODUCT_REVISION: containerEnv.LYRASHIELD_PRODUCT_REVISION,
    LYRASHIELD_WORKER_IMAGE_DIGEST: containerEnv.LYRASHIELD_WORKER_IMAGE_DIGEST,
    LYRASHIELD_ENGINE_REVISION: containerEnv.LYRASHIELD_ENGINE_REVISION,
  })
  if (!provenance) throw new Error("stopped worker container is not a production runtime")
  const imageReference = String(imageResult.stdout).trim()
  if (!imageReference.endsWith(`@${provenance.workerImageDigest}`)) {
    throw new Error("stopped worker image does not match its immutable provenance")
  }
  const runtimeBindingFingerprints = {
    database: bindRuntimeEndpoint(containerEnv, "DATABASE_URL"),
    systemDatabase: bindRuntimeEndpoint(containerEnv, "DATABASE_SYSTEM_URL"),
    redis: bindRuntimeEndpoint(containerEnv, "REDIS_URL"),
  }

  const [
    admissionStopped,
    workerAvailable,
    activeScans,
    enabledScheduleCount,
    scanCounts,
    webhookRetryCounts,
  ] = await Promise.all([
    redis.exists(SCAN_ADMISSION_STOP_KEY),
    isScanWorkerAvailable(),
    getSystemPrisma().scan.findMany({
      where: { deletedAt: null, status: { notIn: [...TERMINAL_SCAN_STATUSES] } },
      select: { id: true },
      orderBy: { id: "asc" },
    }),
    getSystemPrisma().schedule.count({ where: { enabled: true } }),
    queue.getJobCounts("wait", "active", "delayed", "prioritized"),
    webhookRetryQueue.getJobCounts("wait", "active", "delayed", "prioritized"),
  ])
  return {
    admissionStopped: admissionStopped === 1,
    workerAvailable,
    serviceState: String(serviceStateResult.stdout).trim(),
    containerRunning: String(containerStateResult.stdout).trim() === "true",
    imageReference,
    provenance,
    runtimeBindingFingerprints,
    activeScanIds: activeScans.map((scan) => scan.id),
    enabledScheduleCount,
    queueDepth: [...Object.values(scanCounts), ...Object.values(webhookRetryCounts)].reduce(
      (sum, count) => sum + count,
      0
    ),
  }
}

async function retainRuntimeAuditReceipt(
  fixture: FixtureIds,
  preflight: FixturePreflight,
  state: FixtureState,
  reconciledAt: Date
): Promise<string> {
  const receipt = await getSystemPrisma().platformAdminAudit.create({
    data: {
      actorUserId: "offline-queue-recovery-drill",
      sessionId: "offline-queue-recovery-drill",
      action: "queue_orphan_fixture.verified",
      resourceType: "scan",
      resourceId: fixture.scanId,
      metadata: {
        workspaceId: fixture.workspaceId,
        status: state.status,
        errorCategory: state.errorCategory,
        errorMessage: state.errorMessage,
        engineStartCount: state.engineStartCount,
        finalJobExists: state.jobExists,
        finalQueueDepth: state.queueDepth,
        productRevision: preflight.provenance.productRevision,
        workerImageDigest: preflight.provenance.workerImageDigest,
        engineRevision: preflight.provenance.engineRevision,
        imageReference: preflight.imageReference,
        runtimeBindingFingerprints: preflight.runtimeBindingFingerprints,
        reconciledAt: reconciledAt.toISOString(),
        cleanupState: "pending",
      },
    },
    select: { id: true },
  })
  return receipt.id
}

async function retainRuntimeCleanupAuditReceipt(
  fixture: FixtureIds,
  verificationReceiptId: string,
  cleanedUpAt: Date
): Promise<string> {
  const receipt = await getSystemPrisma().platformAdminAudit.create({
    data: {
      actorUserId: "offline-queue-recovery-drill",
      sessionId: "offline-queue-recovery-drill",
      action: "queue_orphan_fixture.cleanup_verified",
      resourceType: "platform_admin_audit",
      resourceId: verificationReceiptId,
      metadata: {
        verificationReceiptId,
        workspaceId: fixture.workspaceId,
        scanId: fixture.scanId,
        cleanupState: "passed",
        cleanedUpAt: cleanedUpAt.toISOString(),
      },
    },
    select: { id: true },
  })
  return receipt.id
}

async function createRuntimeFixture(): Promise<FixtureIds> {
  const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`
  const workspaceName = `Queue Orphan Fixture ${suffix}`
  const { user, workspace } = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        id: randomUUID(),
        name: "Queue Orphan Fixture",
        email: `queue-orphan-${suffix}@example.invalid`,
        emailVerified: true,
      },
    })
    const workspace = await tx.workspace.create({
      data: { name: workspaceName, slug: `queue-orphan-${suffix}`, mode: "VIBE", plan: "FREE" },
    })
    await tx.workspaceMember.create({
      data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" },
    })
    return { user, workspace }
  })
  try {
    const { policy, target } = await withWorkspaceRLS(workspace.id, async (tx) => {
      const policy = await tx.policy.create({
        data: {
          workspaceId: workspace.id,
          name: "Queue Orphan Fixture Policy",
          description: "Disposable queue recovery proof",
          networkEgressPolicy: "target_only",
          destructiveTestsAllowed: false,
          approvalRequired: false,
          maxBudgetUsd: 0,
          maxDurationMinutes: 1,
          piiRedactionEnabled: true,
          evidenceRetentionDays: 1,
        },
      })
      const target = await tx.target.create({
        data: {
          workspaceId: workspace.id,
          type: "WEB_APP",
          name: "Queue Orphan Fixture",
          url: "https://example.com",
          environment: "STAGING",
        },
      })
      return { policy, target }
    })
    const scan = await createScan({
      workspaceId: workspace.id,
      targetId: target.id,
      goal: "TEST_APP",
      mode: "SAFE",
      policyId: policy.id,
      createdById: user.id,
      triggerType: "operator_queue_orphan_fixture",
    })
    await prisma.auditLog.create({
      data: {
        workspaceId: workspace.id,
        actorUserId: user.id,
        action: "scan.operator_queue_orphan_fixture_created",
        resourceType: "scan",
        resourceId: scan.id,
      },
    })
    return {
      userId: user.id,
      workspaceId: workspace.id,
      workspaceName,
      targetId: target.id,
      scanId: scan.id,
    }
  } catch (error) {
    await deleteExactFixtureAccount(user.id, {
      workspaceId: workspace.id,
      workspaceName,
    })
    throw error
  }
}

async function inspectRuntimeFixture(fixture: FixtureIds): Promise<FixtureState> {
  const queue = getScanQueue()
  const [scan, engineStartCount, auditCount, job, counts] = await Promise.all([
    withWorkspaceRLS(fixture.workspaceId, (tx) =>
      tx.scan.findFirst({
        where: { id: fixture.scanId, workspaceId: fixture.workspaceId, deletedAt: null },
        select: { status: true, errorCategory: true, errorMessage: true },
      })
    ),
    getSystemPrisma().scanEvent.count({
      where: { scanId: fixture.scanId, stage: "engine_start", deletedAt: null },
    }),
    getSystemPrisma().auditLog.count({
      where: {
        workspaceId: fixture.workspaceId,
        resourceId: fixture.scanId,
        action: "scan.operator_queue_orphan_fixture_created",
      },
    }),
    queue.getJob(fixture.scanId),
    queue.getJobCounts("wait", "active", "delayed", "prioritized"),
  ])
  if (!scan) throw new Error("fixture scan disappeared")
  return {
    ...scan,
    engineStartCount,
    auditCount,
    jobExists: job !== undefined && job !== null,
    queueDepth: Object.values(counts).reduce((sum, count) => sum + count, 0),
  }
}

async function cleanupRuntimeFixture(fixture: FixtureIds): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: fixture.userId }, select: { id: true } })
  if (!user) return
  try {
    const scan = await withWorkspaceRLS(fixture.workspaceId, (tx) =>
      tx.scan.findFirst({
        where: { id: fixture.scanId, workspaceId: fixture.workspaceId, deletedAt: null },
        select: { status: true },
      })
    )
    if (scan && !isTerminalScanStatus(scan.status)) {
      await cancelScan(fixture.scanId, fixture.workspaceId)
    }
    if (scan) await removeScan(fixture.scanId, fixture.workspaceId)
  } finally {
    await deleteExactFixtureAccount(fixture.userId, fixture)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const forwardedArgs = process.argv.slice(2)
  const args = forwardedArgs[0] === "--" ? forwardedArgs.slice(1) : forwardedArgs
  const { values } = parseArgs({
    args,
    options: {
      environment: { type: "string" },
      "confirm-production": { type: "string" },
    },
    strict: true,
  })
  try {
    const options = parseQueueOrphanFixtureOptions(values)
    const receipt = await verifyQueueOrphanFixture(options, {
      preflight: runtimePreflight,
      createFixture: createRuntimeFixture,
      wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      reconcile: (fixture, now) =>
        reconcileExactQueuedScanOrphan(fixture.scanId, fixture.workspaceId, now),
      inspectFixture: inspectRuntimeFixture,
      cleanupFixture: cleanupRuntimeFixture,
      retainAuditReceipt: retainRuntimeAuditReceipt,
      retainCleanupAuditReceipt: retainRuntimeCleanupAuditReceipt,
      now: () => new Date(),
    })
    console.log(JSON.stringify(receipt, null, 2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  } finally {
    if (runtimeQueuesOpened) {
      await Promise.all([getScanQueue().close(), getWebhookTrackRetryQueue().close()])
      runtimeQueuesOpened = false
    }
    await closeRedis()
  }
}
