import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { randomUUID } from "node:crypto"
import { PrismaClient } from "./generated/prisma"
import { PrismaPg } from "@prisma/adapter-pg"

/**
 * Workstream E2 runtime test — proves the MCP task binding is durable under
 * the restricted NOBYPASSRLS runtime role, exactly like the hosted path runs
 * it: the stateless MCP endpoint constructs a fresh server (and a fresh task
 * backend) on EVERY request, so "process replacement" is not a simulation —
 * it is the steady state. A task id `lst_<operationId>` must resolve the same
 * operation/scan rows for every fresh instance, a foreign workspace must see
 * nothing, and the recorded boundary must never replay paid work.
 *
 * Skips loudly when RLS_RUNTIME_DATABASE_URL is not configured.
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

import { prisma as runtime } from "./client"
import {
  claimOrGetAgentOperation,
  completeAgentOperation,
  getAgentOperation,
  getOperationStatus,
  listAgentOperationsForTasks,
  cancelScan,
  createAgentConnection,
  CANONICAL_OPERATIONS,
} from "./index"
import { withWorkspaceRLS } from "./index"

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
})
const runtimeUrl = process.env.RLS_RUNTIME_DATABASE_URL
const suffix = randomUUID().replace(/-/g, "")
const wsId = `e2t-ws-${suffix}`
const ws2Id = `e2t-ws2-${suffix}`
const userId = `e2t-user-${suffix}`

describe.skipIf(!runtimeUrl)(
  "E2 durable MCP task bindings under the restricted runtime role",
  () => {
    let connectionId = ""
    let targetId = ""
    let scanId = ""
    let operationId = ""

    beforeAll(async () => {
      const [role] = await runtime.$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
      expect(role).toEqual({ rolsuper: false, rolbypassrls: false })

      await owner.user.create({
        data: { id: userId, name: "E2T", email: `${userId}@example.invalid` },
      })
      await owner.workspace.create({ data: { id: wsId, name: "E2T WS", slug: `e2t-${suffix}` } })
      await owner.workspace.create({
        data: { id: ws2Id, name: "E2T WS2", slug: `e2t2-${suffix}` },
      })
      await owner.workspaceMember.create({
        data: { workspaceId: wsId, userId, role: "OWNER", status: "active" },
      })
      const target = await owner.target.create({
        data: { workspaceId: wsId, name: "t", type: "REPO", repoFullName: "o/e2t" },
      })
      targetId = target.id
      const scan = await owner.scan.create({
        data: {
          workspaceId: wsId,
          targetId,
          goal: "TEST_APP",
          mode: "STANDARD",
          status: "RUNNING",
          createdById: userId,
          startedAt: new Date(),
        },
      })
      scanId = scan.id

      const connection = await createAgentConnection({
        workspaceId: wsId,
        userId,
        clientType: "mcp",
        clientName: "e2t",
        allowedOperations: [CANONICAL_OPERATIONS.SCAN_CREATE, CANONICAL_OPERATIONS.SCAN_CANCEL],
        allTargets: true,
        allowedProfiles: ["STANDARD"],
        authorizationVersion: 7,
      })
      connectionId = connection.id
    })

    afterAll(async () => {
      await owner.agentOperation.deleteMany({ where: { workspaceId: { in: [wsId, ws2Id] } } })
      await owner.agentConnection.deleteMany({ where: { workspaceId: wsId } })
      await owner.scan.deleteMany({ where: { workspaceId: wsId } })
      await owner.target.deleteMany({ where: { workspaceId: wsId } })
      for (const id of [wsId, ws2Id]) {
        await owner.workspace.updateMany({ where: { id }, data: { deletedAt: new Date() } })
      }
      await owner.user.deleteMany({ where: { id: userId } })
      await owner.$disconnect()
      await runtime.$disconnect()
    })

    it("binds a task to the recorded operation row — and resolves it fresh every time", async () => {
      // 1) The same claim boundary the remote approval gate uses for tools/call.
      const input = { workspaceId: wsId, targetId, goal: "TEST_APP" }
      const claim = await claimOrGetAgentOperation({
        connectionId,
        workspaceId: wsId,
        operationName: CANONICAL_OPERATIONS.SCAN_CREATE,
        idempotencyKey: `e2t-${suffix}`,
        authorizationVersion: 7,
        input,
      })
      expect(claim.status).toBe("NEW")
      operationId = claim.operation.id

      // 2) The gate completes the operation with the scan reference + stamped result.
      const recordedResult = {
        content: [{ type: "text", text: '{"action":"scan_triggered"}' }],
        structuredContent: {
          action: "scan_triggered",
          operationId,
          scan: { id: scanId, status: "QUEUED" },
        },
      }
      await completeAgentOperation(operationId, wsId, {
        resultReference: scanId,
        result: recordedResult,
      })

      // 3) "Process replacement": a fresh resolution path reads rows only —
      //    the state a new server instance would need for tasks/get.
      const resolved = await getAgentOperation(operationId, wsId)
      expect(resolved).not.toBeNull()
      expect(resolved!.principalType).toBe("OAUTH_CONNECTION")
      expect(resolved!.principalId).toBe(connectionId)
      expect(resolved!.connectionId).toBe(connectionId)
      expect(resolved!.authorizationVersion).toBe(7)
      expect(resolved!.status).toBe("COMPLETED")
      // The task→scan link is durable, not remembered.
      expect(resolved!.resultReference).toBe(scanId)

      const statusView = await getOperationStatus(operationId, wsId, {
        principalType: "OAUTH_CONNECTION",
        principalId: connectionId,
      })
      expect(statusView?.resultLocation).toBe(scanId)

      // 4) The scan row the task result would be reconstructed from.
      const scan = await withWorkspaceRLS(wsId, (tx) =>
        tx.scan.findFirst({ where: { id: resolved!.resultReference, workspaceId: wsId } })
      )
      expect(scan?.status).toBe("RUNNING")

      // 5) tasks/list stays principal-scoped on a fresh instance.
      const ops = await listAgentOperationsForTasks({
        workspaceId: wsId,
        principalType: "OAUTH_CONNECTION",
        principalId: connectionId,
        operationName: CANONICAL_OPERATIONS.SCAN_CREATE,
      })
      expect(ops.map((o) => o.id)).toContain(operationId)
      const foreign = await listAgentOperationsForTasks({
        workspaceId: wsId,
        principalType: "OAUTH_CONNECTION",
        principalId: "conn-other",
        operationName: CANONICAL_OPERATIONS.SCAN_CREATE,
      })
      expect(foreign).toHaveLength(0)

      // 6) The recorded boundary still refuses a second paid submission.
      const again = await claimOrGetAgentOperation({
        connectionId,
        workspaceId: wsId,
        operationName: CANONICAL_OPERATIONS.SCAN_CREATE,
        idempotencyKey: `e2t-${suffix}`,
        authorizationVersion: 7,
        input,
      })
      expect(again.status).toBe("REPLAY")
      expect(again.operation.id).toBe(operationId)

      // 7) A task id is not a capability: the foreign workspace sees nothing.
      expect(await getAgentOperation(operationId, ws2Id)).toBeNull()
    })

    it("routes task cancellation into the durable scan.cancel transition", async () => {
      // The hosted backend resolves the scan from the binding, then calls the
      // canonical cancelScan — the exact path this exercises.
      const cancelled = await cancelScan(scanId, wsId)
      expect(cancelled.status).toBe("CANCELLED")

      // A fresh getTask-resolution sees the terminal row.
      const resolved = await getAgentOperation(operationId, wsId)
      expect(resolved!.resultReference).toBe(scanId)
      const scan = await withWorkspaceRLS(wsId, (tx) =>
        tx.scan.findFirst({ where: { id: scanId, workspaceId: wsId } })
      )
      expect(scan?.status).toBe("CANCELLED")
    })
  }
)
