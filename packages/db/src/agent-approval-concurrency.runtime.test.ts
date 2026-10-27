import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { PrismaPg } from "@prisma/adapter-pg"
import { PrismaClient } from "./generated/prisma"

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
import { findOrCreatePendingApproval } from "./agent-approval-service"

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
  }
)
