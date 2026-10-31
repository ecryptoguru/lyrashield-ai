import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { PrismaPg } from "@prisma/adapter-pg"
import { PrismaClient } from "./generated/prisma"

// Hoisting runs this guard before imports can construct the runtime client.
await vi.hoisted(async () => {
  if (process.env.LYRASHIELD_TEST_DB_DISPOSABLE === "1" && process.env.RLS_RUNTIME_DATABASE_URL) {
    const { assertDisposableDatabasePair } =
      await import("../../../.github/scripts/vitest-database-env.mjs")
    assertDisposableDatabasePair(process.env)
  }
})

vi.mock("@lyrashield/config", async (original) => {
  const actual = await original<typeof import("@lyrashield/config")>()
  return {
    ...actual,
    env: {
      ...actual.env,
      DATABASE_URL: process.env.RLS_RUNTIME_DATABASE_URL ?? actual.env.DATABASE_URL,
    },
  }
})

import { prisma } from "./client"
import { withWorkspaceRLS } from "./rls"
import { claimApprovalExecution, findOrCreatePendingApproval } from "./agent-approval-service"

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
})
const workspaceId = `approval-race-${randomUUID()}`
describe.skipIf(!process.env.RLS_RUNTIME_DATABASE_URL)(
  "pending approval PostgreSQL concurrency",
  () => {
    beforeAll(async () => {
      await owner.workspace.create({
        data: { id: workspaceId, name: "Approval test", slug: workspaceId },
      })
    })
    afterAll(async () => {
      await owner.agentApproval.deleteMany({ where: { workspaceId } })
      await owner.workspace.deleteMany({ where: { id: workspaceId } })
      await owner.$disconnect()
      await prisma.$disconnect()
    })

    it("returns one live approval for concurrent identical requests, then replaces it after expiry", async () => {
      const input = {
        workspaceId,
        actionName: "fix_pr.open",
        input: { fixProposalId: "proposal" },
        requestedById: "requester",
        expiresAt: new Date(Date.now() + 60_000),
      }
      const approvals = await Promise.all(
        Array.from({ length: 12 }, () => findOrCreatePendingApproval(input))
      )
      expect(new Set(approvals.map((approval) => approval.id)).size).toBe(1)
      expect(
        await withWorkspaceRLS(workspaceId, (tx) =>
          tx.agentApproval.count({ where: { workspaceId, status: "PENDING" } })
        )
      ).toBe(1)
      await withWorkspaceRLS(workspaceId, (tx) =>
        tx.agentApproval.updateMany({
          where: { id: approvals[0]!.id, workspaceId },
          data: { expiresAt: new Date(0) },
        })
      )
      const replacement = await findOrCreatePendingApproval(input)
      expect(replacement.id).not.toBe(approvals[0]!.id)
    })

    it("rejects expired, changed-input and foreign-workspace claims before one concurrent winner", async () => {
      const inputHash = "immutable-patch-and-scanned-base"
      const approval = await owner.agentApproval.create({
        data: {
          workspaceId,
          actionName: "fix_pr.open",
          inputHash,
          input: { fixProposalId: "proposal" },
          status: "APPROVED",
          requestedById: "requester",
          expiresAt: new Date(0),
        },
      })
      expect(await claimApprovalExecution(approval.id, workspaceId, inputHash)).toBe(false)
      await owner.agentApproval.update({
        where: { id: approval.id },
        data: { expiresAt: new Date(Date.now() + 60_000) },
      })
      expect(await claimApprovalExecution(approval.id, workspaceId, "changed-patch-or-base")).toBe(
        false
      )
      expect(await claimApprovalExecution(approval.id, `foreign-${workspaceId}`, inputHash)).toBe(
        false
      )
      const unchanged = await owner.agentApproval.findUniqueOrThrow({ where: { id: approval.id } })
      expect(unchanged.status).toBe("APPROVED")
      expect(unchanged.attempts).toBe(0)
      const claims = await Promise.all(
        Array.from({ length: 8 }, () => claimApprovalExecution(approval.id, workspaceId, inputHash))
      )
      expect(claims.filter(Boolean)).toHaveLength(1)
      const executed = await owner.agentApproval.findUniqueOrThrow({ where: { id: approval.id } })
      expect(executed.status).toBe("EXECUTING")
      expect(executed.attempts).toBe(1)
    })
  }
)
