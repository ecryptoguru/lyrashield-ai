// Executed as stdin inside the exact running worker with its normal runtime DB role.
// No service credentials are supplied as arguments or emitted in the receipt.
import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import {
  prisma,
  withWorkspaceRLS,
  verifyStoredManifestChecksum,
  verifyStoredScanExecutionPlan,
} from "@lyrashield/db"

const fail = () => {
  throw new Error("CANARY_PROOF_REJECTED")
}
const sha = (value) => createHash("sha256").update(value).digest("hex")
const id = /^[A-Za-z0-9_-]{1,128}$/
const hex = /^[a-f0-9]{64}$/

try {
  const raw = process.argv[2]
  if (!raw || !/^[A-Za-z0-9_-]{1,8192}$/.test(raw)) fail()
  const p = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"))
  if (
    p.version !== 1 ||
    ![p.workspaceId, p.targetId, p.scanId, p.operationId].every((x) => id.test(x ?? "")) ||
    !hex.test(p.checksum ?? "") ||
    !/^[a-f0-9]{40}$/.test(p.productRevision ?? "") ||
    !/^[a-f0-9]{40}$/.test(p.engineRevision ?? "") ||
    !/^sha256:[a-f0-9]{64}$/.test(p.workerDigest ?? "") ||
    !/^cold-canary:[0-9]{1,20}:[a-f0-9]{40}$/.test(p.idempotencyKey ?? "") ||
    !p.idempotencyKey.endsWith(`:${p.productRevision}`)
  )
    fail()
  if (
    process.env.LYRASHIELD_PRODUCT_REVISION !== p.productRevision ||
    process.env.LYRASHIELD_ENGINE_REVISION !== p.engineRevision ||
    process.env.LYRASHIELD_WORKER_IMAGE_DIGEST !== p.workerDigest
  )
    fail()

  const snapshot = await withWorkspaceRLS(p.workspaceId, async (tx) => {
    const scan = await tx.scan.findFirst({
      where: { id: p.scanId, workspaceId: p.workspaceId, deletedAt: null },
      include: { resultManifest: true, coverageReceipts: true },
    })
    if (!scan?.sponsorAccountId) fail()
    const target = await tx.target.findFirst({
      where: { id: p.targetId, workspaceId: p.workspaceId, deletedAt: null },
    })
    const operation = await tx.agentOperation.findFirst({
      where: { id: p.operationId, workspaceId: p.workspaceId },
    })
    const key =
      operation?.principalType === "API_KEY"
        ? await tx.apiKey.findFirst({
            where: {
              id: operation.principalId,
              workspaceId: p.workspaceId,
              deletedAt: null,
              revokedAt: null,
            },
          })
        : null
    const member = await tx.workspaceMember.findFirst({
      where: {
        workspaceId: p.workspaceId,
        userId: scan.createdById,
        status: "active",
        role: "OWNER",
      },
    })
    return { scan, target, operation, key, member }
  })
  const { scan, target, operation, key, member } = snapshot
  if (
    !target ||
    target.status !== "active" ||
    target.type !== "WEB_APP" ||
    target.url !== p.targetUrl ||
    scan.targetId !== target.id ||
    scan.status !== "COMPLETED" ||
    scan.mode !== "SAFE" ||
    scan.goal !== "TEST_APP" ||
    scan.accountingVersion !== 2 ||
    !member ||
    !key ||
    key.createdById !== scan.createdById ||
    !key.scopes.includes("write") ||
    (key.expiresAt && key.expiresAt <= new Date()) ||
    scan.sponsorAccountId !== scan.createdById
  )
    fail()
  if (
    !operation ||
    operation.operationName !== "scan.create" ||
    operation.idempotencyKey !== p.idempotencyKey ||
    operation.status !== "COMPLETED" ||
    operation.resultReference !== scan.id
  )
    fail()
  const plan = verifyStoredScanExecutionPlan(scan.executionPlan, scan.executionPlanHash)
  if (
    !plan.ok ||
    plan.plan.targetType !== "WEB_APP" ||
    plan.plan.workflow !== "REVIEW_TARGET" ||
    plan.plan.limits.maxBudgetUsd !== 0 ||
    plan.plan.limits.maxEngineMs !== 0 ||
    !isDeepStrictEqual(plan.plan.capabilities, ["url"])
  )
    fail()
  const stored = scan.resultManifest
  if (!stored || stored.checksum !== p.checksum || verifyStoredManifestChecksum(stored) !== "MATCH")
    fail()
  const m = stored.manifest
  if (
    !m ||
    m.target?.id !== target.id ||
    m.target?.type !== "WEB_APP" ||
    m.target?.urlChecksum !== sha(JSON.stringify(target.url)) ||
    m.engineExecution !== null ||
    m.terminalOutcome?.status !== "COMPLETED" ||
    m.workerExecution?.productRevision !== p.productRevision ||
    m.workerExecution?.engineRevision !== p.engineRevision ||
    m.workerExecution?.workerImageDigest !== p.workerDigest
  )
    fail()
  const urlCoverage = m.coverage?.filter((r) => r.controlId === "url")
  const engineCoverage = m.coverage?.filter((r) => r.controlId === "engine")
  const urlRow = scan.coverageReceipts.filter((r) => r.controlId === "url")
  const engineRow = scan.coverageReceipts.filter((r) => r.controlId === "engine")
  if (
    urlCoverage?.length !== 1 ||
    urlCoverage[0].status !== "COMPLETED" ||
    engineCoverage?.length !== 1 ||
    engineCoverage[0].status !== "NOT_APPLICABLE" ||
    urlRow.length !== 1 ||
    urlRow[0].status !== urlCoverage[0].status ||
    engineRow.length !== 1 ||
    engineRow[0].status !== engineCoverage[0].status
  )
    fail()
  const funding = await withWorkspaceRLS(
    p.workspaceId,
    async (tx) => {
      const reservation = await tx.scanCapacityReservation.findUnique({
        where: { scanId: scan.id },
      })
      const billableEvents = await tx.scanEvent.count({
        where: { scanId: scan.id, stage: "billable_boundary", deletedAt: null },
      })
      const billedUsage = await tx.usageRecord.count({
        where: {
          accountId: scan.sponsorAccountId,
          idempotencyKey: `${p.workspaceId}:${scan.id}:engine_run`,
          kind: "agent_minutes",
        },
      })
      return { reservation, billableEvents, billedUsage }
    },
    { accountId: scan.sponsorAccountId }
  )
  const reservation = funding.reservation
  if (
    !reservation ||
    reservation.accountId !== scan.sponsorAccountId ||
    reservation.workspaceId !== p.workspaceId ||
    reservation.userId !== scan.createdById ||
    reservation.state !== "RELEASED" ||
    !reservation.stoppedAt ||
    reservation.fundedMinutes !== 0 ||
    reservation.poolMinutes !== 0 ||
    reservation.packMinutes !== 0 ||
    reservation.graceMinutes !== 0 ||
    reservation.overageMinutes !== 0 ||
    reservation.chargedMinutes !== 0 ||
    funding.billableEvents !== 0 ||
    funding.billedUsage !== 0 ||
    (scan.llmRequestCount ?? 0) !== 0 ||
    (scan.providerCostUsd && !scan.providerCostUsd.isZero()) ||
    (scan.billedCostUsd && !scan.billedCostUsd.isZero())
  )
    fail()
  console.log(
    JSON.stringify({
      version: 1,
      result: "MATCH",
      scanId: p.scanId,
      operationId: p.operationId,
      checksum: p.checksum,
      productRevision: p.productRevision,
      engineRevision: p.engineRevision,
      workerDigest: p.workerDigest,
    })
  )
} catch {
  console.error("CANARY_PROOF_REJECTED")
  process.exitCode = 1
} finally {
  await prisma.$disconnect().catch(() => {})
}
