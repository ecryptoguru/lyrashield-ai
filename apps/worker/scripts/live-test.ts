import { randomUUID } from "node:crypto"
import { execSync } from "node:child_process"
import { prisma, withWorkspaceRLS } from "@lyrashield/db"
import { enqueueScan } from "@lyrashield/integrations"

const REPO_OWNER = "ecryptoguru"
const REPO_NAME = "OnboardingAI2"
const REPO_BRANCH = "main"
type ScanMode = "SAFE" | "STANDARD" | "DEEP" | "CUSTOM" | "QUICK"
type ScanGoal =
  | "LAUNCH_REVIEW"
  | "CHECK_PR"
  | "TEST_APP"
  | "WEEKLY_MONITOR"
  | "FULL_PENTEST"
  | "COMPLIANCE_REVIEW"
const SCAN_MODE = (process.env.SCAN_MODE || "STANDARD").toUpperCase() as ScanMode
const SCAN_GOAL = (process.env.SCAN_GOAL || "LAUNCH_REVIEW") as ScanGoal
const DEFAULT_BUDGET: Record<string, number> = {
  SAFE: 1.2,
  STANDARD: 3.2,
  DEEP: 15,
  CUSTOM: 15,
}
const MAX_BUDGET_USD =
  parseFloat(process.env.MAX_BUDGET_USD || "0") || DEFAULT_BUDGET[SCAN_MODE] || 3.2
const MAX_DURATION_MINUTES = parseInt(process.env.MAX_DURATION_MINUTES || "30", 10)

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
      data: {
        workspaceId: workspace.id,
        type: "REPO",
        name: `${REPO_OWNER}/${REPO_NAME}`,
        repoProvider: "github",
        repoOwner: REPO_OWNER,
        repoName: REPO_NAME,
        repoFullName: `${REPO_OWNER}/${REPO_NAME}`,
        branch: REPO_BRANCH,
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
    terminal = ["COMPLETED", "FAILED", "CANCELLED", "STOPPED_BUDGET", "TIMED_OUT"].includes(
      current.status as string
    )
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
      console.log(`repo:          ${REPO_OWNER}/${REPO_NAME}`)
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
        const logs = execSync(
          `cd /Users/defiankit/Desktop/lyrashieldai && docker compose logs worker --since "${startIso}" 2>&1`,
          { encoding: "utf8", maxBuffer: 50 * 1024 * 1024, timeout: 30_000 }
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
    await prisma.$disconnect()
  })
