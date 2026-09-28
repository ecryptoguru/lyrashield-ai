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
  getSystemPrisma,
  getAgentConnection,
  hashOperationInput,
  prisma as runtime,
} from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"
import { makeRemoteApprovalGate } from "./remote-approval-gate"

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
      await owner.target.deleteMany({ where: { workspaceId } })
      await owner.workspace.updateMany({
        where: { id: workspaceId },
        data: { deletedAt: new Date() },
      })
      await owner.user.deleteMany({ where: { id: userId } })
      await owner.$disconnect()
      await runtime.$disconnect()
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
