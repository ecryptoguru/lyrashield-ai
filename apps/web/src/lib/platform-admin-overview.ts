import { getSystemPrisma } from "@lyrashield/db"
import { getScanQueue, isScanWorkerAvailable } from "@lyrashield/integrations"

export type PlatformHealthStatus = "healthy" | "degraded" | "unknown"

function countStatus(
  groups: Array<{ status: string; _count: { _all: number } }>,
  status: string
): number {
  return groups.find((group) => group.status === status)?._count._all ?? 0
}

export async function getPlatformAdminOverview() {
  const prisma = getSystemPrisma()
  const databasePromise = Promise.all([
    prisma.user.count(),
    prisma.workspace.count(),
    prisma.target.count(),
  ])
  const scansPromise = prisma.scan.groupBy({
    by: ["status"],
    where: { deletedAt: null },
    _count: { _all: true },
  })
  const billingPromise = Promise.all([
    prisma.billingAccount.groupBy({
      by: ["status"],
      where: { deletedAt: null },
      _count: { _all: true },
    }),
    prisma.webhookEventTrack.count({ where: { status: "dead_letter" } }),
  ])
  const affiliatesPromise = Promise.all([
    prisma.affiliate.count({ where: { status: "PENDING" } }),
    prisma.payout.count({ where: { status: { in: ["PENDING", "PROCESSING"] } } }),
  ])
  const workerPromise = isScanWorkerAvailable()
  const queuePromise = getScanQueue().getJobCounts("wait", "active", "delayed", "failed")

  const [database, scans, billing, affiliates, worker, queue] = await Promise.allSettled([
    databasePromise,
    scansPromise,
    billingPromise,
    affiliatesPromise,
    workerPromise,
    queuePromise,
  ])

  const databaseCard =
    database.status === "fulfilled"
      ? {
          status: "healthy" as const,
          users: database.value[0],
          workspaces: database.value[1],
          targets: database.value[2],
        }
      : { status: "unknown" as const, users: null, workspaces: null, targets: null }

  const scanCard =
    scans.status === "fulfilled"
      ? {
          status: "healthy" as const,
          queued: countStatus(scans.value, "QUEUED"),
          active: countStatus(scans.value, "RUNNING"),
          completed: countStatus(scans.value, "COMPLETED"),
          failed: countStatus(scans.value, "FAILED"),
        }
      : {
          status: "unknown" as const,
          queued: null,
          active: null,
          completed: null,
          failed: null,
        }

  const billingCard =
    billing.status === "fulfilled"
      ? {
          status: (billing.value[1] > 0 ? "degraded" : "healthy") as PlatformHealthStatus,
          active: countStatus(billing.value[0], "active"),
          free: countStatus(billing.value[0], "free"),
          deadLetters: billing.value[1],
        }
      : {
          status: "unknown" as const,
          active: null,
          free: null,
          deadLetters: null,
        }

  const affiliateCard =
    affiliates.status === "fulfilled"
      ? {
          status: (affiliates.value.some((count) => count > 0)
            ? "degraded"
            : "healthy") as PlatformHealthStatus,
          pendingApplications: affiliates.value[0],
          pendingPayouts: affiliates.value[1],
        }
      : {
          status: "unknown" as const,
          pendingApplications: null,
          pendingPayouts: null,
        }

  const workerCard =
    worker.status === "fulfilled"
      ? {
          status: (worker.value ? "healthy" : "degraded") as PlatformHealthStatus,
          available: worker.value,
        }
      : { status: "unknown" as const, available: null }

  const queueCard =
    queue.status === "fulfilled"
      ? (() => {
          const waiting = queue.value.wait ?? 0
          const active = queue.value.active ?? 0
          const delayed = queue.value.delayed ?? 0
          const failed = queue.value.failed ?? 0
          return {
            status: (failed > 0 ? "degraded" : "healthy") as PlatformHealthStatus,
            waiting,
            active,
            delayed,
            failed,
          }
        })()
      : {
          status: "unknown" as const,
          waiting: null,
          active: null,
          delayed: null,
          failed: null,
        }

  return {
    database: databaseCard,
    scans: scanCard,
    billing: billingCard,
    affiliates: affiliateCard,
    worker: workerCard,
    queue: queueCard,
    generatedAt: new Date().toISOString(),
  }
}

export type PlatformAdminOverview = Awaited<ReturnType<typeof getPlatformAdminOverview>>
