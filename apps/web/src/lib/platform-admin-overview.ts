import { getSystemPrisma } from "@lyrashield/db"
import { getScanQueue, isScanWorkerAvailable } from "@lyrashield/integrations"

export type PlatformHealthStatus = "healthy" | "degraded" | "unknown"
export const ACTIVATION_MINIMUM_SAMPLE = 20

type ActivationRow = {
  accountsCreated: bigint
  setupStarted: bigint
  validAssessments: bigint
  ttfvMedianMinutes: number | null
  ttfvP90Minutes: number | null
  githubConnectStarted: bigint
  githubConnected: bigint
  targetsZero: bigint
  targetsOne: bigint
  targetsTwo: bigint
  targetsThreePlus: bigint
  recoveryFailures: bigint
  recoverySuccesses: bigint
  completedAccounts: bigint
  repeatSevenDays: bigint
  repeatTwentyEightDays: bigint
}

function sampledRate(numerator: number, denominator: number) {
  return {
    numerator,
    denominator,
    percent:
      denominator >= ACTIVATION_MINIMUM_SAMPLE
        ? Math.round((numerator / denominator) * 1_000) / 10
        : null,
  }
}

async function getActivationMetrics(prisma: ReturnType<typeof getSystemPrisma>) {
  const [row] = await prisma.$queryRaw<ActivationRow[]>`
    WITH first_scan AS (
      SELECT "createdById" AS user_id, MIN("createdAt") AS started_at
      FROM "Scan"
      WHERE "deletedAt" IS NULL
      GROUP BY "createdById"
    ),
    first_valid AS (
      SELECT "createdById" AS user_id, MIN("endedAt") AS completed_at
      FROM "Scan"
      WHERE "deletedAt" IS NULL
        AND status::text IN ('COMPLETED', 'PARTIAL')
        AND "endedAt" IS NOT NULL
      GROUP BY "createdById"
    ),
    completed_ranked AS (
      SELECT "createdById" AS user_id, "endedAt" AS completed_at,
        ROW_NUMBER() OVER (PARTITION BY "createdById" ORDER BY "endedAt", id) AS ordinal
      FROM "Scan"
      WHERE "deletedAt" IS NULL AND status::text = 'COMPLETED' AND "endedAt" IS NOT NULL
    ),
    completed_pairs AS (
      SELECT first.user_id, first.completed_at AS first_at, second.completed_at AS second_at
      FROM completed_ranked first
      LEFT JOIN completed_ranked second ON second.user_id = first.user_id AND second.ordinal = 2
      WHERE first.ordinal = 1
    ),
    target_counts AS (
      SELECT users.id AS user_id, COUNT(DISTINCT target.id) AS target_count
      FROM users
      LEFT JOIN "WorkspaceMember" member ON member."userId" = users.id AND member.status = 'active'
      LEFT JOIN "Target" target ON target."workspaceId" = member."workspaceId"
        AND target."deletedAt" IS NULL
        AND target."createdAt" <= users."createdAt" + INTERVAL '30 minutes'
      GROUP BY users.id
    ),
    connection_events AS (
      SELECT action, COUNT(DISTINCT "actorUserId") AS actors
      FROM "AuditLog"
      WHERE action IN ('integration.github.connect_started', 'integration.github.connected')
        AND "actorUserId" IS NOT NULL
      GROUP BY action
    ),
    failed_operations AS (
      SELECT * FROM agent_operations
      WHERE status::text = 'FAILED' AND error IS NOT NULL AND error <> ''
    )
    SELECT
      COUNT(DISTINCT users.id)::bigint AS "accountsCreated",
      COUNT(DISTINCT first_scan.user_id)::bigint AS "setupStarted",
      COUNT(DISTINCT first_valid.user_id)::bigint AS "validAssessments",
      PERCENTILE_CONT(0.5) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM (first_valid.completed_at - users."createdAt")) / 60
      ) FILTER (WHERE first_valid.completed_at IS NOT NULL)::double precision AS "ttfvMedianMinutes",
      PERCENTILE_CONT(0.9) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM (first_valid.completed_at - users."createdAt")) / 60
      ) FILTER (WHERE first_valid.completed_at IS NOT NULL)::double precision AS "ttfvP90Minutes",
      COALESCE((SELECT actors FROM connection_events WHERE action = 'integration.github.connect_started'), 0)::bigint AS "githubConnectStarted",
      COALESCE((SELECT actors FROM connection_events WHERE action = 'integration.github.connected'), 0)::bigint AS "githubConnected",
      COUNT(*) FILTER (WHERE target_counts.target_count = 0)::bigint AS "targetsZero",
      COUNT(*) FILTER (WHERE target_counts.target_count = 1)::bigint AS "targetsOne",
      COUNT(*) FILTER (WHERE target_counts.target_count = 2)::bigint AS "targetsTwo",
      COUNT(*) FILTER (WHERE target_counts.target_count >= 3)::bigint AS "targetsThreePlus",
      (SELECT COUNT(*) FROM failed_operations)::bigint AS "recoveryFailures",
      (SELECT COUNT(*) FROM failed_operations failed WHERE EXISTS (
        SELECT 1 FROM agent_operations recovered
        WHERE recovered."workspaceId" = failed."workspaceId"
          AND recovered."principalType" = failed."principalType"
          AND recovered."principalId" = failed."principalId"
          AND recovered."operationName" = failed."operationName"
          AND recovered.status::text = 'COMPLETED'
          AND recovered."createdAt" > failed."createdAt"
          AND recovered."createdAt" <= failed."createdAt" + INTERVAL '30 minutes'
      ))::bigint AS "recoverySuccesses",
      (SELECT COUNT(*) FROM completed_pairs)::bigint AS "completedAccounts",
      (SELECT COUNT(*) FROM completed_pairs WHERE second_at <= first_at + INTERVAL '7 days')::bigint AS "repeatSevenDays",
      (SELECT COUNT(*) FROM completed_pairs WHERE second_at <= first_at + INTERVAL '28 days')::bigint AS "repeatTwentyEightDays"
    FROM users
    LEFT JOIN first_scan ON first_scan.user_id = users.id
    LEFT JOIN first_valid ON first_valid.user_id = users.id
    LEFT JOIN target_counts ON target_counts.user_id = users.id
  `

  if (!row) throw new Error("Activation metrics query returned no row")
  const accountsCreated = Number(row.accountsCreated)
  const validAssessments = Number(row.validAssessments)
  const targetDistribution = {
    denominator: accountsCreated,
    zero: Number(row.targetsZero),
    one: Number(row.targetsOne),
    two: Number(row.targetsTwo),
    threePlus: Number(row.targetsThreePlus),
    sufficient: accountsCreated >= ACTIVATION_MINIMUM_SAMPLE,
  }

  return {
    minimumSample: ACTIVATION_MINIMUM_SAMPLE,
    activation: sampledRate(validAssessments, accountsCreated),
    setupAbandonment: sampledRate(accountsCreated - Number(row.setupStarted), accountsCreated),
    timeToFirstValidAssessment: {
      denominator: validAssessments,
      medianMinutes: validAssessments >= ACTIVATION_MINIMUM_SAMPLE ? row.ttfvMedianMinutes : null,
      p90Minutes: validAssessments >= ACTIVATION_MINIMUM_SAMPLE ? row.ttfvP90Minutes : null,
    },
    connectionSuccess: sampledRate(Number(row.githubConnected), Number(row.githubConnectStarted)),
    repeatedInput: targetDistribution,
    recoverySuccess: sampledRate(Number(row.recoverySuccesses), Number(row.recoveryFailures)),
    repeatAssessment: {
      sevenDays: sampledRate(Number(row.repeatSevenDays), Number(row.completedAccounts)),
      twentyEightDays: sampledRate(
        Number(row.repeatTwentyEightDays),
        Number(row.completedAccounts)
      ),
    },
  }
}

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
  const activationPromise = getActivationMetrics(prisma)

  const [database, scans, billing, affiliates, worker, queue, activation] =
    await Promise.allSettled([
      databasePromise,
      scansPromise,
      billingPromise,
      affiliatesPromise,
      workerPromise,
      queuePromise,
      activationPromise,
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
    activation: activation.status === "fulfilled" ? activation.value : null,
    generatedAt: new Date().toISOString(),
  }
}

export type PlatformAdminOverview = Awaited<ReturnType<typeof getPlatformAdminOverview>>
