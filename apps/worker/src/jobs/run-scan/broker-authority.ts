import type { Job } from "bullmq"
import { z } from "zod"
import {
  env,
  evaluateAuthAssessmentAdmission,
  resolveWorkerExecutionProvenance,
} from "@lyrashield/config"
import { runWithWorkspaceContext, withWorkspaceRLS } from "@lyrashield/db"
import { getScanQueue } from "@lyrashield/integrations"
import {
  ScanJobDataSchema,
  resolveScanProfile,
  type ScanJobData,
  type ScanJobResult,
} from "@lyrashield/types"
import type { createScanDispatchAuthorityBroker } from "@lyrashield/db/src/scan-dispatch-authority-broker"
import type { createScanQueueOutboxDispatcher } from "@lyrashield/db/src/scan-queue-outbox-dispatcher"
import { serializeScanQueuePayload } from "@lyrashield/db/src/scan-queue-payload"
import { verifyScanJobAuthority, type StoredScanAuthority } from "./authority"
import { verifyScanAdmission } from "./admission"
import { readExecutionPolicy } from "./execution-policy"

const id = z.string().min(1)
export const workerBrokerAuthoritySchema = z
  .object({
    qualificationDigest: z.string().regex(/^[a-f0-9]{64}$/),
    productRevision: z.string().regex(/^[a-f0-9]{40}$/),
    workerImageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    engineRevision: z.string().regex(/^[a-f0-9]{40}$/),
    authorityEpochId: id,
    workerInstanceId: id,
    workerGrantId: id,
    expiresAt: z.date(),
  })
  .strict()
export type WorkerBrokerAuthority = z.infer<typeof workerBrokerAuthoritySchema>

/** Installed by trusted startup code, never deserialized from a job or HTTP input. */
export interface WorkerBrokerInstallation {
  authority: WorkerBrokerAuthority
  /** Must verify the issuer record, current tuple, epoch and revocation over protected IPC. */
  verifyAuthority(authority: WorkerBrokerAuthority): Promise<boolean>
  broker: Pick<
    ReturnType<typeof createScanDispatchAuthorityBroker>,
    "prepare" | "status" | "stop" | "reconcile" | "consumeSupervisorReceipts"
  >
  publication: Pick<ReturnType<typeof createScanQueueOutboxDispatcher>, "verifyDispatch">
}

export function retainedBrokerScanResult(code: string): ScanJobResult {
  // This describes transport disposition only. Never mark the scan terminal,
  // release its holds or present dispatch acceptance as a completed review.
  return {
    status: "failed",
    errorCategory: code,
    errorMessage: "Review authority is retained for control-plane reconciliation.",
  }
}

async function bounded<T>(work: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("broker acknowledgement unavailable")), 5000)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function installationIsCurrent(installation: WorkerBrokerInstallation) {
  const authority = workerBrokerAuthoritySchema.parse(installation.authority)
  const provenance = resolveWorkerExecutionProvenance()
  if (
    !provenance ||
    authority.expiresAt.getTime() <= Date.now() ||
    authority.productRevision !== provenance.productRevision ||
    authority.workerImageDigest !== provenance.workerImageDigest ||
    authority.engineRevision !== provenance.engineRevision
  )
    return false
  return (await bounded(() => installation.verifyAuthority(authority))) === true
}

async function readCurrentAuthority(scan: StoredScanAuthority) {
  return withWorkspaceRLS(
    scan.workspaceId,
    async (tx) => {
      const current = await tx.scan.findFirst({
        where: { id: scan.id, workspaceId: scan.workspaceId },
        select: { status: true, deletedAt: true },
      })
      const workspace = await tx.workspace.findFirst({
        where: { id: scan.workspaceId, deletedAt: null },
        select: { id: true },
      })
      const target = await tx.target.findFirst({
        where: { id: scan.targetId ?? "", workspaceId: scan.workspaceId, deletedAt: null },
        select: { type: true },
      })
      const operation = await tx.scanDispatchOperation.findFirst({
        where: { scanId: scan.id, workspaceId: scan.workspaceId },
        select: { operationId: true, scanId: true, workspaceId: true, requestDigest: true },
      })
      return { current, workspace, target, operation }
    },
    { accountId: scan.sponsorAccountId ?? scan.createdById, maxWait: 2000, timeout: 5000 }
  )
}

async function currentQueueSnapshot(scanId: string) {
  const queue = getScanQueue()
  const job = await queue.getJob(scanId)
  return job
    ? {
        id: job.id!,
        queueName: queue.name,
        name: job.name,
        data: job.data,
        state: await job.getState(),
      }
    : null
}

async function validateCurrentAdmission(
  authority: Extract<Awaited<ReturnType<typeof verifyScanJobAuthority>>, { ok: true }>,
  targetType: string
) {
  const { scanRecord, executionPlan, workspaceId, data } = authority
  const policy = await readExecutionPolicy(data.policyId, workspaceId)
  const engineBacked =
    targetType === "REPO" || resolveScanProfile({ targetType, mode: data.mode }).usesAi
  return verifyScanAdmission({
    scanId: data.scanId,
    workspaceId,
    targetId: data.targetId,
    mode: data.mode,
    scanRecord,
    executionPlan,
    targetType,
    engineBacked,
    deterministicRetest: targetType === "REPO" && scanRecord.determinismMode === "targeted_scanner",
    currentPolicy: policy,
    planRequired: true,
    recordFailure: false,
    authAssessmentPermitted: evaluateAuthAssessmentAdmission({
      enabled: env.LYRASHIELD_AUTH_ASSESSMENT_ENABLED === "1",
      allowlist: env.LYRASHIELD_AUTH_ASSESSMENT_ALLOWLIST,
      workspaceId,
      targetId: data.targetId,
    }).allowed,
  })
}

const receiptSnapshotSchema = z
  .object({
    operationId: id,
    confirmedSequence: z.number().int().nonnegative().safe(),
    receipts: z.number().int().nonnegative(),
    dispositions: z.array(
      z
        .object({
          commandId: id,
          status: z.enum(["HELD", "UNKNOWN", "PREPARED"]),
          observedStatus: z.string().min(1).max(128),
        })
        .strict()
    ),
  })
  .strict()

async function syncBrokerReceipts(installation: WorkerBrokerInstallation, operationId: string) {
  const result = receiptSnapshotSchema.parse(
    await bounded(() => installation.broker.consumeSupervisorReceipts(operationId))
  )
  if (result.operationId !== operationId) throw new Error("broker receipt identity unavailable")
  // Only authenticated ingestion can change persisted physical state. Positive
  // observations remain HELD until the qualified native controller is complete.
  return result
}

async function dispatchBoundJob(
  job: Job<ScanJobData, ScanJobResult>,
  installation: WorkerBrokerInstallation
) {
  const parsed = ScanJobDataSchema.strict().safeParse(job.data)
  if (!parsed.success || job.id !== parsed.data.scanId)
    return retainedBrokerScanResult("INVALID_JOB")
  const authority = await verifyScanJobAuthority(job, { recordFailure: false })
  if (!authority.ok) return authority.result
  if (!authority.executionPlan) return retainedBrokerScanResult("SCAN_PLAN_REQUIRED")
  return runWithWorkspaceContext(authority.workspaceId, async () => {
    const { current, workspace, target, operation } = await bounded(() =>
      readCurrentAuthority(authority.scanRecord)
    )
    if (!operation) return retainedBrokerScanResult("BROKER_OPERATION_UNAVAILABLE")
    const identity = {
      operationId: operation.operationId,
      authorityEpochId: installation.authority.authorityEpochId,
      workerInstanceId: installation.authority.workerInstanceId,
      workerGrantId: installation.authority.workerGrantId,
    }
    const receipts = await syncBrokerReceipts(installation, operation.operationId)
    const status = await bounded(() => installation.broker.status(operation.operationId))
    if (status.operationId !== operation.operationId || status.kind !== "available")
      return retainedBrokerScanResult("BROKER_OUTCOME_UNKNOWN")
    if (current?.status === "CANCELLED") {
      if (!status.attemptId) return retainedBrokerScanResult("BROKER_CANCELLED_RETAINED")
      const stopped = await bounded(() =>
        installation.broker.stop({
          ...identity,
          attemptId: status.attemptId!,
          reasonCode: "SCAN_CANCELLED",
        })
      )
      return retainedBrokerScanResult(
        stopped.kind === "committed" &&
          stopped.operationId === operation.operationId &&
          stopped.attemptId === status.attemptId
          ? "BROKER_STOP_PENDING"
          : "BROKER_OUTCOME_UNKNOWN"
      )
    }
    if (
      status.state === "UNKNOWN" ||
      receipts.dispositions.some((disposition) => disposition.status === "UNKNOWN")
    )
      return retainedBrokerScanResult("BROKER_OUTCOME_UNKNOWN")
    if (!current || current.deletedAt || !workspace || !target)
      return retainedBrokerScanResult("SCAN_AUTHORIZATION_REVOKED")
    const admission = await bounded(() => validateCurrentAdmission(authority, target.type))
    if (!admission.ok) return admission.result
    if (status.state === "PREPARED")
      return retainedBrokerScanResult("BROKER_RECEIPT_BRIDGE_UNAVAILABLE")
    if (!["QUEUED", "WAITING_CAPACITY"].includes(status.state))
      return retainedBrokerScanResult("BROKER_DISPATCH_PENDING")
    const snapshot = await bounded(() => currentQueueSnapshot(authority.data.scanId))
    if (!snapshot) return retainedBrokerScanResult("BROKER_PUBLICATION_UNAVAILABLE")
    const published = await bounded(() =>
      installation.publication.verifyDispatch(
        {
          operationId: operation.operationId,
          workspaceId: authority.workspaceId,
        },
        snapshot
      )
    )
    if (
      published.kind !== "published" ||
      published.row.operationId !== operation.operationId ||
      published.row.id !== authority.data.scanId ||
      published.row.workspaceId !== authority.workspaceId ||
      published.row.executionPlanHash !== authority.scanRecord.executionPlanHash ||
      published.row.requestDigest !== operation.requestDigest ||
      published.row.payloadInputJson !== serializeScanQueuePayload(parsed.data)
    )
      return retainedBrokerScanResult("BROKER_PUBLICATION_UNAVAILABLE")
    if (!(await installationIsCurrent(installation)))
      return retainedBrokerScanResult("BROKER_AUTHORITY_UNAVAILABLE")
    // The rechecks above are advisory snapshots. The fence is the broker's own
    // transaction: it re-locks the operation, re-reads the live grant FOR SHARE
    // and runs the SQL authority function, so a revocation between the snapshot
    // and the write cannot be prepared.
    const prepared = await bounded(() =>
      installation.broker.prepare({
        operationId: operation.operationId,
        workerInstanceId: installation.authority.workerInstanceId,
        workerGrantId: installation.authority.workerGrantId,
        authorityEpochId: installation.authority.authorityEpochId,
        // SQL clamps this to now+10s; the grant must already cover it.
        expiresAt: installation.authority.expiresAt,
      })
    )
    if (prepared.operationId !== operation.operationId)
      return retainedBrokerScanResult("BROKER_OUTCOME_UNKNOWN")
    if (prepared.kind === "waiting") return retainedBrokerScanResult("BROKER_CAPACITY_PENDING")
    // Checked intent only. Physical executor and provider dispatch are not
    // installed, so a prepared attempt is retained rather than executed.
    return retainedBrokerScanResult(
      prepared.kind === "committed" ? "BROKER_DISPATCH_PREPARED" : "BROKER_OUTCOME_UNKNOWN"
    )
  })
}

export function createBrokerWorkerAuthorityAdapter(installation?: WorkerBrokerInstallation) {
  const installed = installation && {
    ...installation,
    authority: Object.freeze({
      ...installation.authority,
      expiresAt: new Date(installation.authority.expiresAt),
    }),
  }
  return {
    async process(job: Job<ScanJobData, ScanJobResult>): Promise<ScanJobResult> {
      if (!installed) return retainedBrokerScanResult("BROKER_AUTHORITY_CLOSED")
      try {
        if (!(await installationIsCurrent(installed)))
          return retainedBrokerScanResult("BROKER_AUTHORITY_UNAVAILABLE")
        return await dispatchBoundJob(job, installed)
      } catch {
        return retainedBrokerScanResult("BROKER_OUTCOME_UNKNOWN")
      }
    },
  }
}
