import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { randomUUID } from "node:crypto"
import { PrismaClient } from "./generated/prisma"
import { PrismaPg } from "@prisma/adapter-pg"

/**
 * Deep Review v16 P1-7 and P1-8 regression tests — the two money defects the
 * 2.2 tripwire surfaced, proven under the restricted NOBYPASSRLS runtime role
 * exactly like rls-fail-closed.test.ts (same harness pattern, same
 * skip-loudly rule when RLS_RUNTIME_DATABASE_URL is absent).
 *
 * P1-7: the hourly billing downgrade sweep reads BillingAccount with no
 * workspace context — a cross-workspace system operation. Through the plain
 * client under the runtime role, FORCE RLS strict returns zero rows, so
 * canceled/past-due workspaces keep their allowance, target cap and Deep
 * eligibility forever. The sweep must run through getSystemPrisma and still
 * see an expired account.
 *
 * P1-8: the scheduled-scan "target already has an active scan" guard counts
 * Scan rows for the schedule's workspace+target. Under the runtime role the
 * count must see the running scan (explicit workspaceId in the where, the
 * extension binding the RLS transaction) — a guard that counts zero lets a
 * scheduled scan start on top of a running one and double-spends the
 * customer's agent-minutes.
 */

vi.mock("@lyrashield/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@lyrashield/config")>()
  return {
    ...actual,
    env: {
      ...actual.env,
      DATABASE_URL: process.env.RLS_RUNTIME_DATABASE_URL ?? actual.env.DATABASE_URL,
    },
  }
})

import { processBillingDowngradeJob } from "../../../apps/worker/src/jobs/billing-downgrade.job"
import { prisma as runtime } from "./client"
import { runWithWorkspaceContext } from "./scoping"

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
})
const runtimeUrl = process.env.RLS_RUNTIME_DATABASE_URL
const suffix = randomUUID().replace(/-/g, "")

const p17WorkspaceId = `p17-ws-${suffix}`
const p17UserId = `p17-user-${suffix}`
const p18WorkspaceId = `p18-ws-${suffix}`
const p18UserId = `p18-user-${suffix}`
let p18TargetId = ""

describe.skipIf(!runtimeUrl)(
  "P1-7 billing downgrade sweep under the restricted runtime role",
  () => {
    beforeAll(async () => {
      const [role] = await runtime.$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
      expect(role).toEqual({ rolsuper: false, rolbypassrls: false })

      await owner.user.create({
        data: { id: p17UserId, name: "P17", email: `${p17UserId}@example.invalid` },
      })
      await owner.workspace.create({
        data: {
          id: p17WorkspaceId,
          name: "P17 Expired",
          slug: `p17-${suffix}`,
          plan: "PRO",
          deepAllowed: true,
        },
      })
      await owner.workspaceMember.create({
        data: { workspaceId: p17WorkspaceId, userId: p17UserId, role: "OWNER", status: "active" },
      })
      await owner.billingAccount.create({
        data: {
          workspaceId: p17WorkspaceId,
          status: "canceled",
          currentPlan: "PRO",
          currentPeriodEnd: new Date(Date.now() - 24 * 60 * 60 * 1000),
        },
      })
    })

    afterAll(async () => {
      await owner.workspace
        .updateMany({ where: { id: p17WorkspaceId }, data: { deletedAt: new Date() } })
        .catch(() => {})
      await owner.user.deleteMany({ where: { id: p17UserId } }).catch(() => {})
      await owner.$disconnect()
      await runtime.$disconnect()
    })

    it("sees the expired account and downgrades the workspace (getSystemPrisma sweep)", async () => {
      // The defect: through the plain client the sweep sees zero rows under
      // the runtime role and nobody is ever downgraded.
      const eligibleAccounts = await owner.billingAccount.count({
        where: {
          status: { in: ["canceled", "past_due"] },
          currentPeriodEnd: { lt: new Date() },
        },
      })
      const result = await processBillingDowngradeJob({ scheduledAt: new Date().toISOString() })

      expect(eligibleAccounts).toBeGreaterThanOrEqual(1)
      expect(result.downgraded).toBe(eligibleAccounts)
      const workspace = await owner.workspace.findUniqueOrThrow({
        where: { id: p17WorkspaceId },
      })
      expect(workspace.plan).toBe("FREE")
      expect(workspace.deepAllowed).toBe(false)
      const account = await owner.billingAccount.findUniqueOrThrow({
        where: { workspaceId: p17WorkspaceId },
      })
      expect(account.status).toBe("downgraded")
      expect(account.currentPlan).toBe("FREE")
    })
  }
)

describe.skipIf(!runtimeUrl)(
  "P1-8 scheduled-scan active-target guard under the restricted runtime role",
  () => {
    beforeAll(async () => {
      await owner.user.create({
        data: { id: p18UserId, name: "P18", email: `${p18UserId}@example.invalid` },
      })
      await owner.workspace.create({
        data: { id: p18WorkspaceId, name: "P18 Guard", slug: `p18-${suffix}` },
      })
      await owner.workspaceMember.create({
        data: { workspaceId: p18WorkspaceId, userId: p18UserId, role: "OWNER", status: "active" },
      })
      const target = await owner.target.create({
        data: {
          workspaceId: p18WorkspaceId,
          name: "P18 target",
          type: "REPO",
          repoFullName: "test/p18",
        },
      })
      p18TargetId = target.id
      await owner.scan.create({
        data: {
          workspaceId: p18WorkspaceId,
          targetId: p18TargetId,
          goal: "LAUNCH_REVIEW",
          mode: "SAFE",
          status: "RUNNING",
          createdById: p18UserId,
        },
      })
    })

    afterAll(async () => {
      await owner.scan.deleteMany({ where: { workspaceId: p18WorkspaceId } }).catch(() => {})
      await owner.target.deleteMany({ where: { workspaceId: p18WorkspaceId } }).catch(() => {})
      await owner.workspace
        .updateMany({ where: { id: p18WorkspaceId }, data: { deletedAt: new Date() } })
        .catch(() => {})
      await owner.user.deleteMany({ where: { id: p18UserId } }).catch(() => {})
    })

    it("the guard count sees the running scan for the schedule's workspace+target", async () => {
      // The exact read processDueSchedules performs (workspaceId now passed
      // explicitly), inside the same runWithWorkspaceContext the runner uses,
      // through the restricted runtime client.
      const ACTIVE_SCAN_STATUSES = [
        "QUEUED",
        "PREFLIGHT",
        "RUNNING",
        "VERIFYING",
        "REQUIRES_APPROVAL",
      ]
      const activeScans = await runWithWorkspaceContext(p18WorkspaceId, async () =>
        runtime.scan.count({
          where: {
            workspaceId: p18WorkspaceId,
            targetId: p18TargetId,
            status: { in: [...ACTIVE_SCAN_STATUSES] },
          },
        })
      )

      // The guard must fire: a count of zero here means a scheduled scan would
      // start on top of the running one and double-spend agent-minutes.
      expect(activeScans).toBe(1)
    })
  }
)
