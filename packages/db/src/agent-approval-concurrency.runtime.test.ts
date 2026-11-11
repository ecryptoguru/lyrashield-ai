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
import {
  approveApproval,
  claimApprovalExecution,
  findOrCreatePendingApproval,
  hashInput,
} from "./agent-approval-service"

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
      const inputHash = hashInput("fix_pr.open", { fixProposalId: "proposal" })
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

    it("rejects legacy lossy input and revalidates a changed row under its lock", async () => {
      const actionName = "connector.invoke"
      const cleanInput = { metadata: { value: 1 } }
      const inputHash = hashInput(actionName, cleanInput)
      const alteredInput = JSON.parse('{"metadata":{"value":1,"__proto__":{"forged":true}}}')
      const approval = await owner.agentApproval.create({
        data: {
          workspaceId,
          actionName,
          inputHash,
          input: cleanInput,
          requestedById: "requester",
          expiresAt: new Date(Date.now() + 60_000),
        },
      })
      await owner.$executeRaw`UPDATE "AgentApproval" SET "input" = ${JSON.stringify(alteredInput)}::jsonb WHERE "id" = ${approval.id}`
      await expect(
        approveApproval(approval.id, workspaceId, "reviewer", inputHash)
      ).rejects.toMatchObject({ code: "INPUT_MISMATCH" })

      const reviewedHash = hashInput(actionName, alteredInput)
      await owner.agentApproval.update({
        where: { id: approval.id },
        data: { inputHash: reviewedHash },
      })
      let decision!: Promise<unknown>
      await owner.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "AgentApproval" WHERE "id" = ${approval.id} FOR UPDATE`
        decision = approveApproval(approval.id, workspaceId, "reviewer", reviewedHash).catch(
          (error: unknown) => error
        )
        const runtimeUser = new URL(process.env.RLS_RUNTIME_DATABASE_URL!).username
        let waiting = false
        for (let attempt = 0; attempt < 100 && !waiting; attempt += 1) {
          const rows = await tx.$queryRaw<Array<{ waiting: boolean }>>`
            SELECT EXISTS (
              SELECT 1 FROM pg_stat_activity
              WHERE usename = ${runtimeUser} AND wait_event_type = 'Lock'
                AND query LIKE '%AgentApproval%FOR UPDATE%'
            ) AS waiting`
          waiting = rows[0]?.waiting === true
          if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10))
        }
        expect(waiting).toBe(true)
        await tx.$executeRaw`UPDATE "AgentApproval" SET "input" = ${JSON.stringify(cleanInput)}::jsonb WHERE "id" = ${approval.id}`
      })
      expect(await decision).toMatchObject({ code: "INPUT_MISMATCH" })
      await owner.agentApproval.update({ where: { id: approval.id }, data: { inputHash } })
      const approved = await approveApproval(approval.id, workspaceId, "reviewer", inputHash)
      expect(approved.status).toBe("APPROVED")
    })
  }
)
