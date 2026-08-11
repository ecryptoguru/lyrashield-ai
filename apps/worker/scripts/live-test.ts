import { randomUUID } from "node:crypto"
import { execFileSync } from "node:child_process"
import { cancelScan, isTerminalScanStatus, prisma, withWorkspaceRLS } from "@lyrashield/db"
import { closeRedis, enqueueScan, getScanQueue } from "@lyrashield/integrations"
import { resolveScanProfile } from "@lyrashield/types"

type ScanMode = "SAFE" | "STANDARD" | "DEEP" | "CUSTOM" | "QUICK"
type LiveTargetType = "REPO" | "WEB_APP" | "API"
type ScanGoal =
  | "LAUNCH_REVIEW"
  | "CHECK_PR"
  | "TEST_APP"
  | "WEEKLY_MONITOR"
  | "FULL_PENTEST"
  | "COMPLIANCE_REVIEW"
const SCAN_MODE = (process.env.SCAN_MODE || "STANDARD").toUpperCase() as ScanMode
const SCAN_GOAL = (process.env.SCAN_GOAL || "LAUNCH_REVIEW") as ScanGoal
const TARGET_TYPE = (process.env.TARGET_TYPE || "REPO").toUpperCase() as LiveTargetType
const TARGET_URL = process.env.TARGET_URL?.trim()
const API_SPEC_URL = process.env.API_SPEC_URL?.trim()
const REPO_OWNER = process.env.REPO_OWNER?.trim() || "ecryptoguru"
const REPO_NAME = process.env.REPO_NAME?.trim() || "OnboardingAI2"
const REPO_BRANCH = process.env.REPO_BRANCH?.trim() || "main"
if (!["REPO", "WEB_APP", "API"].includes(TARGET_TYPE)) {
  throw new Error(`TARGET_TYPE must be REPO, WEB_APP, or API; received ${TARGET_TYPE}`)
}
if (TARGET_TYPE !== "REPO" && !TARGET_URL) {
  throw new Error(`TARGET_URL is required for ${TARGET_TYPE} live tests`)
}
const scanProfile = resolveScanProfile({ targetType: TARGET_TYPE, mode: SCAN_MODE })
const requestedBudgetUsd = parseFloat(process.env.MAX_BUDGET_USD || "0")
const requestedDurationMinutes = parseInt(process.env.MAX_DURATION_MINUTES || "0", 10)
const CANCEL_AFTER_SECONDS = parseInt(process.env.CANCEL_AFTER_SECONDS || "0", 10)
const MAX_BUDGET_USD = Math.min(
  requestedBudgetUsd > 0 ? requestedBudgetUsd : scanProfile.maxBudgetUsd,
  scanProfile.maxBudgetUsd
)
const MAX_DURATION_MINUTES = Math.min(
  requestedDurationMinutes > 0 ? requestedDurationMinutes : scanProfile.maxDurationMinutes,
  scanProfile.maxDurationMinutes
)

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main() {
  const suffix = `${Date.now()}`
  const userId = randomUUID()
  const email = `live-test-${suffix}@example.com`

  console.log(`[setup] creating test user and workspace...`)
  const user = await prisma.user.create({
    data: { id: userId, name: "Live Test User", email, emailVerified: true },
  })

  const workspace = await prisma.workspace.create({
    data: {
      name: `Live Test ${suffix}`,
      slug: `live-test-${suffix}`,
      mode: "VIBE",
      plan: "FREE",
    },
  })

  await prisma.workspaceMember.create({
    data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" },
  })

  console.log(`[setup] workspace=${workspace.id} user=${user.id}`)

  const policy = await withWorkspaceRLS(workspace.id, async (tx) =>
    tx.policy.create({
      data: {
        workspaceId: workspace.id,
        name: "Default Policy",
        description: "Live-test cost cap",
        networkEgressPolicy: "target_only",
        destructiveTestsAllowed: false,
        approvalRequired: false,
        maxBudgetUsd: MAX_BUDGET_USD,
        maxDurationMinutes: MAX_DURATION_MINUTES,
        piiRedactionEnabled: true,
        evidenceRetentionDays: 1,
      },
    })
  )

  const target = await withWorkspaceRLS(workspace.id, async (tx) =>
    tx.target.create({
      data:
        TARGET_TYPE === "REPO"
          ? {
              workspaceId: workspace.id,
              type: "REPO",
              name: `${REPO_OWNER}/${REPO_NAME}`,
              repoProvider: "github",
              repoOwner: REPO_OWNER,
              repoName: REPO_NAME,
              repoFullName: `${REPO_OWNER}/${REPO_NAME}`,
              branch: REPO_BRANCH,
              environment: "STAGING",
            }
          : {
              workspaceId: workspace.id,
              type: TARGET_TYPE,
              name: TARGET_URL!,
              url: TARGET_URL!,
              ...(API_SPEC_URL ? { apiSpecUrl: API_SPEC_URL } : {}),
              environment: "STAGING",
            },
    })
  )

  const scan = await withWorkspaceRLS(workspace.id, async (tx) =>
    tx.scan.create({
      data: {
        workspaceId: workspace.id,
        targetId: target.id,
        policyId: policy.id,
        goal: SCAN_GOAL,
        mode: SCAN_MODE,
        createdById: user.id,
        status: "QUEUED",
      },
    })
  )

  console.log(`[setup] policy=${policy.id} target=${target.id} scan=${scan.id}`)
  console.log(
    `[setup] cost cap $${MAX_BUDGET_USD} duration ${MAX_DURATION_MINUTES}min mode=${SCAN_MODE}`
  )

  const startTime = new Date()
  const startIso = startTime.toISOString()

  await enqueueScan({
    scanId: scan.id,
    workspaceId: workspace.id,
    targetId: target.id,
    goal: SCAN_GOAL,
    mode: SCAN_MODE,
    policyId: policy.id,
  })

  console.log(`[scan] enqueued at ${startIso}`)
  console.log(`[scan] polling until terminal...`)

  let terminal = false
  let lastStatus = "QUEUED"
  let cancellationRequested = false
  while (!terminal) {
    await sleep(5_000)
    const current = await withWorkspaceRLS(workspace.id, async (tx) =>
      tx.scan.findFirst({
        where: { id: scan.id },
        select: {
          status: true,
          startedAt: true,
          endedAt: true,
          summary: true,
          errorCategory: true,
          errorMessage: true,
          actualCostCents: true,
          providerCostUsd: true,
          billedCostUsd: true,
          llmRequestCount: true,
          llmInputTokens: true,
          llmCachedInputTokens: true,
          llmOutputTokens: true,
        },
      })
    )
    if (!current) {
      console.log("[scan] scan record disappeared, aborting")
      process.exit(1)
    }
    if (current.status !== lastStatus) {
      console.log(`[scan] ${new Date().toISOString()} status=${current.status}`)
      lastStatus = current.status as string
    }
    terminal = isTerminalScanStatus(current.status)
    if (
      !terminal &&
      !cancellationRequested &&
      CANCEL_AFTER_SECONDS > 0 &&
      Date.now() - startTime.getTime() >= CANCEL_AFTER_SECONDS * 1000
    ) {
      await cancelScan(scan.id, workspace.id)
      cancellationRequested = true
      console.log(`[scan] cancellation requested after ${CANCEL_AFTER_SECONDS}s`)
      continue
    }
    if (terminal) {
      const findingCount = await withWorkspaceRLS(workspace.id, async (tx) =>
        tx.finding.count({ where: { scanId: scan.id, deletedAt: null } })
      )
      const endTime = current.endedAt ? new Date(current.endedAt) : new Date()
      const latencyMs = endTime.getTime() - startTime.getTime()
      const startedAt = current.startedAt ? new Date(current.startedAt) : null
      const engineLatencyMs =
        startedAt && current.endedAt
          ? new Date(current.endedAt).getTime() - startedAt.getTime()
          : null

      console.log("\n=== LIVE TEST RESULT ===\n")
      console.log(`scanId:        ${scan.id}`)
      console.log(`workspaceId:   ${workspace.id}`)
      console.log(`targetId:      ${target.id}`)
      console.log(
        `${TARGET_TYPE === "REPO" ? "repo" : "url"}:          ${TARGET_TYPE === "REPO" ? `${REPO_OWNER}/${REPO_NAME}` : TARGET_URL}`
      )
      console.log(`targetType:    ${TARGET_TYPE}`)
      console.log(`mode:          ${SCAN_MODE}`)
      console.log(`status:        ${current.status}`)
      console.log(`total latency: ${(latencyMs / 1000).toFixed(1)}s`)
      console.log(
        `engine latency:${engineLatencyMs ? (engineLatencyMs / 1000).toFixed(1) : "n/a"}s`
      )
      console.log(`providerCost:  ${current.providerCostUsd ?? "n/a"}`)
      console.log(`billedCost:    ${current.billedCostUsd ?? "n/a"}`)
      console.log(`actualCostCents:${current.actualCostCents ?? "n/a"}`)
      console.log(`llmRequests:   ${current.llmRequestCount ?? "n/a"}`)
      console.log(`llmInput:      ${current.llmInputTokens ?? "n/a"}`)
      console.log(`llmCached:     ${current.llmCachedInputTokens ?? "n/a"}`)
      console.log(`llmOutput:     ${current.llmOutputTokens ?? "n/a"}`)
      console.log(`findingCount:  ${findingCount}`)
      console.log(`summary:       ${current.summary ?? "n/a"}`)
      if (current.errorCategory) {
        console.log(`errorCategory: ${current.errorCategory}`)
        console.log(`errorMessage:  ${current.errorMessage ?? "n/a"}`)
      }

      console.log("\n[logs] collecting worker logs since scan start...")
      try {
        const logs = execFileSync(
          "docker",
          ["logs", "--since", startIso, process.env.HOSTNAME || "lyrashield-worker"],
          {
            encoding: "utf8",
            maxBuffer: 50 * 1024 * 1024,
            timeout: 30_000,
          }
        )
        console.log("\n=== WORKER LOGS (tail 80 lines) ===\n")
        const lines = logs.split("\n")
        console.log(lines.slice(-80).join("\n"))
      } catch (logErr) {
        console.log(
          `[logs] failed to collect logs: ${logErr instanceof Error ? logErr.message : String(logErr)}`
        )
      }
    }
  }
}

main()
  .catch((err) => {
    console.error("[fatal]", err)
    process.exit(1)
  })
  .finally(async () => {
    await Promise.allSettled([prisma.$disconnect(), getScanQueue().close(), closeRedis()])
  })
