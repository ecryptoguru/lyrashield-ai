import { createHash } from "node:crypto"
import type { Job } from "bullmq"
import { z } from "zod"
import {
  env,
  evaluateAuthAssessmentAdmission,
  resolveWorkerExecutionProvenance,
} from "@lyrashield/config"
import {
  runWithWorkspaceContext,
  withWorkspaceRLS,
  releaseStoppedScanSlot,
  updateScanStatus,
  TERMINAL_SCAN_STATUSES,
} from "@lyrashield/db"
import { confirmScanCapacityStopped } from "@lyrashield/billing"
import { readScanDispatchCleanupProof } from "@lyrashield/db/src/scan-dispatch-cleanup-proof"
import { getScanQueue } from "@lyrashield/integrations"
import {
  ScanJobDataSchema,
  resolveScanProfile,
  type ScanJobData,
  type ScanJobResult,
} from "@lyrashield/types"
import type { createScanDispatchAuthorityBroker } from "@lyrashield/db/src/scan-dispatch-authority-broker"
import type { QueueOutboxRow } from "@lyrashield/db/src/scan-queue-outbox-store"
import type { ScanQueueJobSnapshot } from "@lyrashield/db/src/scan-queue-publication-proof"
import { serializeScanQueuePayload } from "@lyrashield/db/src/scan-queue-payload"
import { verifyScanJobAuthority, type StoredScanAuthority } from "./authority"
import { verifyScanAdmission } from "./admission"
import { readExecutionPolicy } from "./execution-policy"
import { processScanJob, processNativeScanResult } from "../run-scan.job"
import {
  verifyNativeEngineResult,
  type NativeEngineResultProof,
  type VerifiedNativeEngineResult,
} from "./native-engine-result"

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
  /** Root verifies only the original installed assignment; no new execution/output authority. */
  cleanup?: {
    inventory(cursor?: string): Promise<
      Array<{
        operationId: string
        workspaceId: string
        scanId: string
        attemptId: string
        state: string
      }>
    >
  }
  broker: Pick<
    ReturnType<typeof createScanDispatchAuthorityBroker>,
    "prepare" | "dispatchPrepared" | "status" | "stop" | "reconcile" | "consumeSupervisorReceipts"
  >
  results?: {
    read(operationId: string, attemptId: string): Promise<Buffer | null>
    proof(operationId: string): Promise<NativeEngineResultProof>
    inventory(cursor?: string): Promise<
      Array<{
        operationId: string
        workspaceId: string
        scanId: string
        attemptId: string
        state: string
      }>
    >
  }
  publication: {
    verifyDispatch(
      input: { operationId: string; workspaceId: string },
      snapshot: ScanQueueJobSnapshot
    ): Promise<
      | {
          kind: "published"
          row: Pick<
            QueueOutboxRow,
            | "operationId"
            | "id"
            | "workspaceId"
            | "executionPlanHash"
            | "requestDigest"
            | "payloadInputJson"
          >
        }
      | { kind: "closed" | "unknown" | "busy" | "missing" | "leased" | "recoverable" }
    >
  }
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

async function bounded<T>(work: () => Promise<T>, command = false): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("broker acknowledgement unavailable")),
          command ? 40_000 : 5000
        )
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
          status: z.enum(["HELD", "UNKNOWN", "PREPARED", "STARTED", "STOPPED", "NEVER_DISPATCHED"]),
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
  installation: WorkerBrokerInstallation,
  remainingTransitions = 3,
  afterCommitState?: string
): Promise<ScanJobResult> {
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
    if (afterCommitState === status.state && status.state !== "ACTIVE")
      return retainedBrokerScanResult(
        ["QUEUED", "WAITING_CAPACITY"].includes(status.state)
          ? "BROKER_DISPATCH_PREPARED"
          : "BROKER_START_PENDING"
      )
    if (status.state === "TERMINATED" && current && TERMINAL_SCAN_STATUSES.has(current.status)) {
      // Receipt ingestion has settled its private execution fence. The normal
      // runtime writer releases holds only against the immutable physical
      // cleanup proof; a paid intent still requires canonical settlement.
      const proof = await bounded(() =>
        readScanDispatchCleanupProof(authority.workspaceId, authority.data.scanId)
      )
      if (!proof) return retainedBrokerScanResult("BROKER_CLEANUP_PROOF_UNAVAILABLE")
      await confirmScanCapacityStopped(
        authority.workspaceId,
        authority.data.scanId,
        proof.noBillableWork,
        proof.billingDisposition
      )
      await releaseStoppedScanSlot(authority.workspaceId, authority.data.scanId)
      return retainedBrokerScanResult(
        proof.noBillableWork ? "BROKER_DISPATCH_STOPPED" : "BROKER_SETTLEMENT_REQUIRED"
      )
    }
    if (current?.status === "CANCELLED") {
      if (!status.attemptId) return retainedBrokerScanResult("BROKER_CANCELLED_RETAINED")
      const stopped = await bounded(
        () =>
          status.state === "UNKNOWN"
            ? installation.broker.reconcile({ ...identity, attemptId: status.attemptId! })
            : installation.broker.stop({
                ...identity,
                attemptId: status.attemptId!,
                reasonCode: "SCAN_CANCELLED",
              }),
        true
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
    ) {
      if (status.state === "UNKNOWN" && status.attemptId)
        await bounded(
          () => installation.broker.reconcile({ ...identity, attemptId: status.attemptId! }),
          true
        )
      return retainedBrokerScanResult("BROKER_OUTCOME_UNKNOWN")
    }
    const stopRevokedAdmission = async () => {
      if (
        status.attemptId &&
        ["PREPARING", "PREPARED", "START_PENDING", "ACTIVE", "STOPPING"].includes(status.state)
      )
        await bounded(
          () =>
            installation.broker.stop({
              ...identity,
              attemptId: status.attemptId!,
              reasonCode: "SCAN_AUTHORIZATION_REVOKED",
            }),
          true
        )
    }
    if (
      !current ||
      current.deletedAt ||
      !workspace ||
      !target ||
      target.type !== authority.executionPlan!.targetType
    ) {
      await stopRevokedAdmission()
      return retainedBrokerScanResult("SCAN_AUTHORIZATION_REVOKED")
    }
    const admission = await bounded(() => validateCurrentAdmission(authority, target.type))
    if (!admission.ok) {
      await stopRevokedAdmission()
      return admission.result
    }
    if (
      target.type === "REPO" &&
      ["START_PENDING", "ACTIVE", "STOPPING", "TERMINATED"].includes(status.state)
    ) {
      if (!status.attemptId || !installation.results)
        return retainedBrokerScanResult("BROKER_RESULT_PENDING")
      const raw = await installation.results.read(operation.operationId, status.attemptId)
      if (raw) {
        const proof = await installation.results.proof(operation.operationId)
        let native: VerifiedNativeEngineResult
        try {
          native = verifyNativeEngineResult(raw, proof, {
            operationId: operation.operationId,
            attemptId: status.attemptId,
            workspaceId: authority.workspaceId,
            scanId: authority.data.scanId,
            authorityEpochId: installation.authority.authorityEpochId,
            productRevision: installation.authority.productRevision,
            engineRevision: installation.authority.engineRevision,
            sourceRevision: authority.executionPlan!.source?.revision ?? "",
          })
        } catch {
          // Root authenticated finished bytes still permit exact signed cleanup when the output cannot be finalized.
          if (
            proof.action.operationId === operation.operationId &&
            proof.action.attemptId === status.attemptId &&
            proof.action.scanId === authority.data.scanId &&
            proof.action.workspaceId === authority.workspaceId &&
            proof.action.authorityEpochId === installation.authority.authorityEpochId &&
            proof.action.phase === "EXECUTOR_CREATE" &&
            proof.action.executorKey === "engine" &&
            raw.length === proof.totalBytes &&
            `sha256:${createHash("sha256").update(raw).digest("hex")}` === proof.sha256 &&
            !["STOPPING", "TERMINATED"].includes(status.state)
          ) {
            await installation.broker.stop({
              ...identity,
              attemptId: status.attemptId,
              reasonCode: "ENGINE_OUTPUT_INCOMPLETE",
            })
          }
          return retainedBrokerScanResult("BROKER_RESULT_INCOMPLETE")
        }
        const cleanup = await readScanDispatchCleanupProof(
          authority.workspaceId,
          authority.data.scanId
        )
        if (
          !cleanup ||
          cleanup.operationId !== native.action.operationId ||
          cleanup.attemptId !== native.action.attemptId ||
          cleanup.authorityEpochId !== native.action.authorityEpochId
        ) {
          native.cleanup()
          if (!["STOPPING", "TERMINATED"].includes(status.state))
            await installation.broker.stop({
              ...identity,
              attemptId: status.attemptId,
              reasonCode: "ENGINE_OUTPUT_CAPTURED",
            })
          return retainedBrokerScanResult("BROKER_STOP_PENDING")
        }
        return processNativeScanResult(job, native)
      }
      if (status.state === "ACTIVE") {
        if (afterCommitState === "ACTIVE") return retainedBrokerScanResult("BROKER_START_PENDING")
        const next = await bounded(
          () => installation.broker.dispatchPrepared({ ...identity, attemptId: status.attemptId! }),
          true
        )
        if (next.kind === "committed" && remainingTransitions > 0)
          return dispatchBoundJob(job, installation, remainingTransitions - 1, status.state)
        return retainedBrokerScanResult(
          next.kind === "committed" ? "BROKER_START_PENDING" : "BROKER_RESULT_PENDING"
        )
      }
      return retainedBrokerScanResult("BROKER_RESULT_PENDING")
    }
    if (!["QUEUED", "WAITING_CAPACITY", "PREPARED"].includes(status.state))
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
    // The canonical pipeline persists deterministic surface receipts and the
    // result manifest. Its stored plan is rechecked before every scanner; these
    // two launch tiers have no repository executor or model-backed work.
    if (
      (target.type === "WEB_APP" || target.type === "API") &&
      (authority.data.mode === "SAFE" || authority.data.mode === "QUICK") &&
      !resolveScanProfile({ targetType: target.type, mode: authority.data.mode }).usesAi
    ) {
      if (!["QUEUED", "WAITING_CAPACITY"].includes(status.state))
        return retainedBrokerScanResult("BROKER_DISPATCH_PENDING")
      return processScanJob(job)
    }
    if (status.state === "PREPARED") {
      if (!status.attemptId) return retainedBrokerScanResult("BROKER_OUTCOME_UNKNOWN")
      const dispatched = await bounded(
        () => installation.broker.dispatchPrepared({ ...identity, attemptId: status.attemptId! }),
        true
      )
      if (
        dispatched.operationId !== operation.operationId ||
        ("attemptId" in dispatched && dispatched.attemptId !== status.attemptId)
      )
        return retainedBrokerScanResult("BROKER_OUTCOME_UNKNOWN")
      if (dispatched.kind === "committed" && remainingTransitions > 0)
        return dispatchBoundJob(job, installation, remainingTransitions - 1, status.state)
      return retainedBrokerScanResult(
        dispatched.kind === "committed"
          ? "BROKER_START_PENDING"
          : dispatched.kind === "idle"
            ? "BROKER_RESULT_PENDING"
            : "BROKER_OUTCOME_UNKNOWN"
      )
    }
    // The rechecks above are advisory snapshots. The fence is the broker's own
    // transaction: it re-locks the operation, re-reads the live grant FOR SHARE
    // and runs the SQL authority function, so a revocation between the snapshot
    // and the write cannot be prepared.
    const prepared = await bounded(
      () =>
        installation.broker.prepare({
          operationId: operation.operationId,
          workerInstanceId: installation.authority.workerInstanceId,
          workerGrantId: installation.authority.workerGrantId,
          authorityEpochId: installation.authority.authorityEpochId,
          // SQL clamps this to now+10s; the grant must already cover it.
          expiresAt: installation.authority.expiresAt,
        }),
      true
    )
    if (prepared.operationId !== operation.operationId)
      return retainedBrokerScanResult("BROKER_OUTCOME_UNKNOWN")
    if (prepared.kind === "waiting") return retainedBrokerScanResult("BROKER_CAPACITY_PENDING")
    // A prepared command is transport state. Execution and result finalization
    // require their independently authenticated native and output receipts.
    if (prepared.kind === "committed" && remainingTransitions > 0)
      return dispatchBoundJob(job, installation, remainingTransitions - 1, status.state)
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
  let reconciliationRunning = false
  let reconciliationCursor: string | undefined
  const cleanupRetained = async (scanId?: string, workspaceId?: string) => {
    if (!installed?.cleanup) return
    const operations = await installed.cleanup.inventory(reconciliationCursor)
    reconciliationCursor = operations.length === 32 ? operations.at(-1)!.operationId : undefined
    for (const operation of operations) {
      if (scanId && (operation.scanId !== scanId || operation.workspaceId !== workspaceId)) continue
      const input = {
        operationId: operation.operationId,
        attemptId: operation.attemptId,
        authorityEpochId: installed.authority.authorityEpochId,
        workerInstanceId: installed.authority.workerInstanceId,
        workerGrantId: installed.authority.workerGrantId,
      }
      if (
        ["PREPARING", "PREPARED", "START_PENDING", "ACTIVE", "STOPPING"].includes(operation.state)
      )
        await installed.broker
          .stop({ ...input, reasonCode: "SCAN_AUTHORIZATION_REVOKED" })
          .catch(() => undefined)
      else if (operation.state === "UNKNOWN")
        await installed.broker.reconcile(input).catch(() => undefined)
      else if (operation.state === "TERMINATED") {
        const proof = await readScanDispatchCleanupProof(operation.workspaceId, operation.scanId)
        if (
          proof?.operationId !== operation.operationId ||
          proof.attemptId !== operation.attemptId ||
          proof.authorityEpochId !== input.authorityEpochId
        )
          continue
        const scan = await withWorkspaceRLS(operation.workspaceId, (tx) =>
          tx.scan.findFirst({
            where: { id: operation.scanId, workspaceId: operation.workspaceId },
            select: { status: true, finalizationStartedAt: true },
          })
        )
        if (!scan || (!TERMINAL_SCAN_STATUSES.has(scan.status) && scan.finalizationStartedAt))
          continue
        if (!TERMINAL_SCAN_STATUSES.has(scan.status))
          await updateScanStatus(
            operation.scanId,
            "FAILED",
            {
              errorCategory: "SCAN_AUTHORIZATION_REVOKED",
              errorMessage: "Scan authorization ended after execution was stopped.",
            },
            operation.workspaceId
          )
        await confirmScanCapacityStopped(
          operation.workspaceId,
          operation.scanId,
          proof.noBillableWork,
          proof.billingDisposition
        )
        await releaseStoppedScanSlot(operation.workspaceId, operation.scanId)
      }
    }
  }
  return {
    async isCurrent(): Promise<boolean> {
      if (!installed) return false
      try {
        return await installationIsCurrent(installed)
      } catch {
        return false
      }
    },
    async reconcileRetained(): Promise<void> {
      if (reconciliationRunning || !installed) return
      reconciliationRunning = true
      try {
        if (!(await installationIsCurrent(installed))) {
          await cleanupRetained()
          return
        }
        if (!installed.results) return
        const operations = await installed.results.inventory(reconciliationCursor)
        reconciliationCursor = operations.length === 32 ? operations.at(-1)!.operationId : undefined
        for (const operation of operations) {
          const job = await getScanQueue().getJob(operation.scanId)
          if (
            job &&
            job.id === operation.scanId &&
            job.data.workspaceId === operation.workspaceId
          ) {
            // One ambiguous result must not prevent the remaining exact assigned operations from being reconciled.
            await dispatchBoundJob(job, installed).catch(() => undefined)
          }
        }
      } finally {
        reconciliationRunning = false
      }
    },
    async process(job: Job<ScanJobData, ScanJobResult>): Promise<ScanJobResult> {
      if (!installed) return retainedBrokerScanResult("BROKER_AUTHORITY_CLOSED")
      try {
        if (!(await installationIsCurrent(installed))) {
          const parsed = ScanJobDataSchema.strict().safeParse(job.data)
          if (parsed.success && job.id === parsed.data.scanId)
            await cleanupRetained(parsed.data.scanId, parsed.data.workspaceId)
          return retainedBrokerScanResult("BROKER_AUTHORITY_UNAVAILABLE")
        }
        return await dispatchBoundJob(job, installed)
      } catch {
        return retainedBrokerScanResult("BROKER_OUTCOME_UNKNOWN")
      }
    },
  }
}
