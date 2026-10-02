import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { randomUUID } from "node:crypto"

const requirePermissionMock = vi.hoisted(() => vi.fn().mockResolvedValue({}))
const requireOAuthPermissionMock = vi.hoisted(() => vi.fn().mockResolvedValue({}))
vi.mock("@lyrashield/auth/server", () => ({
  requirePermission: requirePermissionMock,
  requireOAuthPermission: requireOAuthPermissionMock,
}))
vi.mock("@lyrashield/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@lyrashield/config")>()
  return {
    ...actual,
    env: {
      ...actual.env,
      DATABASE_URL: process.env.RLS_RUNTIME_DATABASE_URL ?? actual.env.DATABASE_URL,
      DATABASE_SYSTEM_URL: process.env.DATABASE_URL ?? actual.env.DATABASE_SYSTEM_URL,
    },
  }
})

import {
  CANONICAL_OPERATIONS,
  claimOrGetAgentOperation,
  createAgentConnection,
  completeAgentOperation,
  getSystemPrisma,
  getAgentConnection,
  hashOperationInput,
  prisma as runtime,
} from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"
import { makeRemoteApprovalGate } from "./remote-approval-gate"
import { makeHostedMcpTaskBackend } from "../../../lib/mcp-tasks"
import { GET as getOperationStatusRoute } from "../agent-operations/[id]/route"

const databaseUrl = process.env.DATABASE_URL
const runtimeUrl = process.env.RLS_RUNTIME_DATABASE_URL
const owner = getSystemPrisma()
const suffix = randomUUID().replace(/-/g, "")
const workspaceId = `mcp-hash-ws-${suffix}`
const userId = `mcp-hash-user-${suffix}`
const idempotencyKey = `mcp-hash-${suffix}`

describe.skipIf(!databaseUrl || !runtimeUrl)(
  "remote delegated operation input-hash mismatch under PostgreSQL RLS",
  () => {
    let connectionId = ""
    let targetId = ""
    let operationId = ""

    beforeAll(async () => {
      const [role] = await runtime.$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>`
        SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
      expect(role).toEqual({ rolsuper: false, rolbypassrls: false })

      await owner.user.create({
        data: { id: userId, name: "MCP hash mismatch test", email: `${userId}@example.invalid` },
      })
      await owner.workspace.create({
        data: { id: workspaceId, name: "MCP hash mismatch test", slug: `mcp-hash-${suffix}` },
      })
      await owner.workspaceMember.create({
        data: { workspaceId, userId, role: "OWNER", status: "active" },
      })
      const target = await owner.target.create({
        data: { workspaceId, name: "Mismatch target", type: "REPO", repoFullName: "o/mismatch" },
      })
      targetId = target.id

      const createdConnection = await createAgentConnection({
        workspaceId,
        userId,
        clientType: "mcp",
        clientName: "input-hash-test",
        scopes: ["write"],
        allowedOperations: [CANONICAL_OPERATIONS.SCAN_CREATE],
        allowedTargetIds: [targetId],
        allowedProfiles: ["STANDARD"],
        authorizationVersion: 4,
      })
      const persistedConnection = await getAgentConnection(createdConnection.id, workspaceId)
      expect(persistedConnection).toMatchObject({
        id: createdConnection.id,
        workspaceId,
        status: "ACTIVE",
        allowedOperations: [CANONICAL_OPERATIONS.SCAN_CREATE],
        allowedTargetIds: [targetId],
        allowedProfiles: ["STANDARD"],
        authorizationVersion: 4,
      })
      connectionId = createdConnection.id

      const originalInput = { targetId, mode: "STANDARD" }
      const claim = await claimOrGetAgentOperation({
        connectionId,
        workspaceId,
        operationName: CANONICAL_OPERATIONS.SCAN_CREATE,
        idempotencyKey,
        authorizationVersion: 4,
        input: originalInput,
      })
      if (claim.status !== "NEW") throw new Error(`Unexpected claim status: ${claim.status}`)
      operationId = claim.operation.id
      expect(claim.operation.inputHash).toBe(
        hashOperationInput(CANONICAL_OPERATIONS.SCAN_CREATE, originalInput)
      )
    })

    afterAll(async () => {
      await owner.agentOperation.deleteMany({ where: { workspaceId } })
      await owner.agentConnection.deleteMany({ where: { workspaceId } })
      await owner.scan.deleteMany({ where: { workspaceId } })
      await owner.target.deleteMany({ where: { workspaceId } })
      await owner.workspace.updateMany({
        where: { id: workspaceId },
        data: { deletedAt: new Date() },
      })
      await owner.user.deleteMany({ where: { id: userId } })
      await owner.$disconnect()
      await runtime.$disconnect()
    })

    it("retains a failed outer outcome after a durable inner result and exposes read-only failed status", async () => {
      const connection = await getAgentConnection(connectionId, workspaceId)
      if (!connection || connection.status !== "ACTIVE") throw new Error("Missing connection")
      let executionRequests = 0
      const key = `lost-response-${suffix}`
      const input = { workspaceId, targetId, mode: "STANDARD", goal: "TEST_APP" }
      const gate = makeRemoteApprovalGate({
        apiKeyInfo: { workspaceId, scopes: ["write"], createdById: userId, keyId: `key-${suffix}` },
        connection: { ...connection, status: "ACTIVE" },
        oauthContext: {
          userId,
          workspaceId,
          scopes: ["lyrashield.read", "lyrashield.write"],
          connectionId,
          authorizationVersion: 4,
          allowedOperations: connection.allowedOperations,
          allowedTargetIds: connection.allowedTargetIds,
          allTargets: connection.allTargets,
          allowedProfiles: connection.allowedProfiles,
          expiresAt: connection.expiresAt,
        },
        toolContext: {
          apiBaseUrl: "http://localhost:3001",
          apiKey: "runtime-test",
          fetchFn: async (_url, init) => {
            executionRequests++
            const innerKey = new Headers(init?.headers).get("Idempotency-Key")
            if (!innerKey) throw new Error("Missing internal key")
            const inner = await claimOrGetAgentOperation({
              connectionId,
              workspaceId,
              operationName: CANONICAL_OPERATIONS.SCAN_CREATE,
              idempotencyKey: innerKey,
              authorizationVersion: 4,
              input: JSON.parse(String(init?.body)),
            })
            if (inner.status === "NEW")
              await completeAgentOperation(inner.operation.id, workspaceId, {
                result: { id: "scan-persisted", status: "QUEUED" },
                resultReference: "scan-persisted",
              })
            throw new Error("Response lost after durable persistence")
          },
        },
      })
      const decision = await gate("lyrashield_scan_target", { ...input, idempotencyKey: key })
      expect(decision).toMatchObject({ approved: true, result: { isError: true } })
      const outer = await owner.agentOperation.findFirstOrThrow({
        where: { workspaceId, idempotencyKey: key },
      })
      expect(outer).toMatchObject({
        status: "FAILED",
        error: "OPERATION_OUTCOME_UNKNOWN",
        result: { isError: true, structuredContent: { operationId: outer.id } },
      })
      const inner = await owner.agentOperation.findFirstOrThrow({
        where: { workspaceId, id: { not: outer.id }, idempotencyKey: { startsWith: "mcp:" } },
      })
      expect(inner).toMatchObject({ status: "COMPLETED", resultReference: "scan-persisted" })
      const requestCount = executionRequests
      expect(await gate("lyrashield_scan_target", { ...input, idempotencyKey: key })).toMatchObject(
        { approved: true, result: { isError: true } }
      )
      expect(executionRequests).toBe(requestCount)
      requirePermissionMock.mockResolvedValue({
        session: { userId, oauth: { connectionId, authorizationVersion: 4 } },
      })
      const response = await getOperationStatusRoute(
        new Request(`http://localhost/api/agent-operations/${outer.id}?workspaceId=${workspaceId}`),
        { params: Promise.resolve({ id: outer.id }) }
      )
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        data: { operationId: outer.id, status: "FAILED", recovery: "wait" },
      })
      expect(await owner.agentOperation.findUniqueOrThrow({ where: { id: outer.id } })).toEqual(
        outer
      )

      // Legacy errors remain honest at the actual route without rewriting historical rows.
      await owner.agentOperation.update({
        where: { id: outer.id },
        data: { status: "COMPLETED", error: null },
      })
      const legacyResponse = await getOperationStatusRoute(
        new Request(`http://localhost/api/agent-operations/${outer.id}?workspaceId=${workspaceId}`),
        { params: Promise.resolve({ id: outer.id }) }
      )
      expect(await legacyResponse.json()).toMatchObject({
        data: { status: "FAILED", reasonCode: "OPERATION_FAILED", recovery: "wait" },
      })
      expect(
        (await owner.agentOperation.findUniqueOrThrow({ where: { id: outer.id } })).status
      ).toBe("COMPLETED")
    })

    it("expires a stale outer execution from an older grant under RLS without replaying live or stale handlers", async () => {
      const connection = await getAgentConnection(connectionId, workspaceId)
      if (!connection || connection.status !== "ACTIVE") throw new Error("Missing connection")
      const input = { targetId, mode: "STANDARD" }
      const key = `stale-outer-${suffix}`
      const claim = await claimOrGetAgentOperation({
        connectionId,
        workspaceId,
        operationName: CANONICAL_OPERATIONS.SCAN_CREATE,
        idempotencyKey: key,
        authorizationVersion: 3,
        input,
      })
      if (claim.status !== "NEW") throw new Error("Missing new operation")
      const fetchFn = vi.fn<typeof fetch>().mockRejectedValue(new Error("Must not execute"))
      const gate = makeRemoteApprovalGate({
        apiKeyInfo: { workspaceId, scopes: ["write"], createdById: userId, keyId: `key-${suffix}` },
        connection: { ...connection, status: "ACTIVE" },
        oauthContext: {
          userId,
          workspaceId,
          scopes: ["lyrashield.read", "lyrashield.write"],
          connectionId,
          authorizationVersion: 4,
          allowedOperations: connection.allowedOperations,
          allowedTargetIds: connection.allowedTargetIds,
          allTargets: connection.allTargets,
          allowedProfiles: connection.allowedProfiles,
          expiresAt: connection.expiresAt,
        },
        toolContext: { apiBaseUrl: "http://localhost:3001", apiKey: "runtime-test", fetchFn },
      })
      expect(await gate("lyrashield_scan_target", { ...input, idempotencyKey: key })).toMatchObject(
        {
          approved: true,
          result: { structuredContent: { status: "EXECUTING", operationId: claim.operation.id } },
        }
      )
      expect(
        await owner.agentOperation.findUniqueOrThrow({ where: { id: claim.operation.id } })
      ).toEqual(claim.operation)
      const staleAt = new Date(Date.now() - 61 * 60_000)
      await owner.agentOperation.update({
        where: { id: claim.operation.id },
        data: { updatedAt: staleAt },
      })
      expect(await gate("lyrashield_scan_target", { ...input, idempotencyKey: key })).toMatchObject(
        {
          approved: true,
          result: {
            isError: true,
            structuredContent: {
              status: "FAILED",
              code: "OPERATION_OUTCOME_UNKNOWN",
              operationId: claim.operation.id,
            },
          },
        }
      )
      const expired = await owner.agentOperation.findUniqueOrThrow({
        where: { id: claim.operation.id },
      })
      expect(expired).toMatchObject({
        status: "FAILED",
        error: "OPERATION_OUTCOME_UNKNOWN",
        authorizationVersion: 3,
      })
      await completeAgentOperation(claim.operation.id, workspaceId, {
        result: { id: "late-result" },
        expectedUpdatedAt: claim.operation.updatedAt,
      })
      expect(
        await owner.agentOperation.findUniqueOrThrow({ where: { id: claim.operation.id } })
      ).toEqual(expired)
      expect(fetchFn).not.toHaveBeenCalled()
    })

    it("retains the original handler's durable late scan after expiry without reviving or replaying it", async () => {
      const connection = await getAgentConnection(connectionId, workspaceId)
      if (!connection || connection.status !== "ACTIVE") throw new Error("Missing connection")
      const oauth = {
        userId,
        workspaceId,
        scopes: ["lyrashield.read", "lyrashield.write"],
        connectionId,
        authorizationVersion: 4,
        allowedOperations: connection.allowedOperations,
        allowedTargetIds: connection.allowedTargetIds,
        allTargets: connection.allTargets,
        allowedProfiles: connection.allowedProfiles,
        expiresAt: connection.expiresAt,
      }
      const key = `late-scan-${suffix}`
      const args = { workspaceId, targetId, mode: "STANDARD", idempotencyKey: key }
      let scanId = ""
      let gate: ReturnType<typeof makeRemoteApprovalGate>
      const fetchFn = vi.fn<typeof fetch>(async () => {
        const scan = await owner.scan.create({
          data: {
            workspaceId,
            targetId,
            goal: "TEST_APP",
            mode: "STANDARD",
            status: "QUEUED",
            createdById: userId,
          },
        })
        scanId = scan.id
        const outer = await owner.agentOperation.findFirstOrThrow({
          where: { workspaceId, idempotencyKey: key },
        })
        await owner.agentOperation.update({
          where: { id: outer.id },
          data: { updatedAt: new Date(Date.now() - 61 * 60_000) },
        })
        expect(await gate("lyrashield_scan_target", args)).toMatchObject({
          approved: true,
          result: { isError: true, structuredContent: { code: "OPERATION_OUTCOME_UNKNOWN" } },
        })
        return new Response(
          JSON.stringify({ success: true, data: { id: scanId, status: "QUEUED" } }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        )
      })
      gate = makeRemoteApprovalGate({
        apiKeyInfo: { workspaceId, scopes: ["write"], createdById: userId, keyId: `key-${suffix}` },
        connection: { ...connection, status: "ACTIVE" },
        oauthContext: oauth,
        toolContext: { apiBaseUrl: "http://localhost:3001", apiKey: "runtime-test", fetchFn },
      })
      expect(await gate("lyrashield_scan_target", args)).toMatchObject({
        approved: true,
        result: { isError: true, structuredContent: { code: "OPERATION_OUTCOME_UNKNOWN" } },
      })
      const retained = await owner.agentOperation.findFirstOrThrow({
        where: { workspaceId, idempotencyKey: key },
      })
      expect(retained).toMatchObject({
        status: "FAILED",
        error: "OPERATION_OUTCOME_UNKNOWN",
        resultReference: scanId,
        result: { structuredContent: { scan: { id: scanId }, operationId: retained.id } },
      })
      expect(await gate("lyrashield_scan_target", args)).toMatchObject({
        approved: true,
        result: { isError: true },
      })
      const backend = makeHostedMcpTaskBackend({
        oauth,
        connection: { ...connection, status: "ACTIVE" },
      })
      expect(await backend.getTask(`lst_${retained.id}`)).toMatchObject({ status: "failed" })
      expect(await backend.getTaskResult(`lst_${retained.id}`)).toMatchObject({ isError: true })
      requirePermissionMock.mockResolvedValue({
        session: { userId, oauth: { connectionId, authorizationVersion: 4 } },
      })
      const response = await getOperationStatusRoute(
        new Request(
          `http://localhost/api/agent-operations/${retained.id}?workspaceId=${workspaceId}`
        ),
        { params: Promise.resolve({ id: retained.id }) }
      )
      expect(await response.json()).toMatchObject({
        data: { status: "FAILED", resultLocation: scanId },
      })
      expect(await owner.agentOperation.findUniqueOrThrow({ where: { id: retained.id } })).toEqual(
        retained
      )
      expect(fetchFn).toHaveBeenCalledOnce()
      expect(await owner.scan.count({ where: { workspaceId } })).toBe(1)
    })

    it("denies a changed input under the same idempotency key without altering the ledger", async () => {
      requirePermissionMock.mockClear()
      expect(vi.isMockFunction(requirePermission)).toBe(true)
      const connection = await getAgentConnection(connectionId, workspaceId)
      if (!connection || connection.status !== "ACTIVE") {
        throw new Error("Persisted delegated connection is unavailable or inactive")
      }

      const gate = makeRemoteApprovalGate({
        apiKeyInfo: {
          workspaceId,
          scopes: ["write"],
          createdById: userId,
          keyId: `key-${suffix}`,
        },
        connection: { ...connection, status: "ACTIVE" },
        oauthContext: {
          userId,
          workspaceId,
          scopes: ["lyrashield.read", "lyrashield.write"],
          connectionId: connection.id,
          authorizationVersion: connection.authorizationVersion,
          allowedOperations: connection.allowedOperations,
          allowedTargetIds: connection.allowedTargetIds,
          allTargets: connection.allTargets,
          allowedProfiles: connection.allowedProfiles,
          expiresAt: connection.expiresAt,
        },
        toolContext: { apiBaseUrl: "http://localhost:3001", apiKey: "runtime-test" },
      })

      const before = await owner.agentOperation.findUniqueOrThrow({ where: { id: operationId } })
      const decision = await gate("lyrashield_scan_target", {
        targetId,
        mode: "STANDARD",
        goal: "TEST_APP",
        idempotencyKey,
      })
      const after = await owner.agentOperation.findUniqueOrThrow({ where: { id: operationId } })

      expect(requireOAuthPermissionMock).toHaveBeenCalledWith(
        expect.objectContaining({ userId, workspaceId, connectionId }),
        "scan:create"
      )
      expect(requirePermissionMock).not.toHaveBeenCalled()
      expect(decision).toMatchObject({
        approved: false,
        reason: expect.stringContaining("Idempotency conflict"),
      })
      expect(after).toMatchObject({
        id: before.id,
        status: "EXECUTING",
        inputHash: before.inputHash,
        result: null,
        resultReference: null,
      })
      expect(after.inputHash).not.toBe(
        hashOperationInput(CANONICAL_OPERATIONS.SCAN_CREATE, {
          targetId,
          mode: "STANDARD",
          goal: "TEST_APP",
        })
      )
    })
  }
)
