import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { randomUUID } from "node:crypto"
import { prisma } from "./client"
import { getSystemPrisma } from "./system-client"
import { createScan } from "./scan-service"
import { hashDelegatedAdmissionProof } from "./agent-operation-hash"
import { getDelegatedOperationStatus } from "./delegated-operation-status"
import { withWorkspaceRLS } from "./rls"
import type { Prisma } from "./generated/prisma"
import {
  getCurrentDelegatedScanAuthority,
  getDelegatedActiveTargetIds,
  getDelegatedScanAccess,
  withDelegatedReadAuthority,
} from "./delegated-read-access"

// Hoisting runs this guard before imports can construct a client from ambient
// env. The fixture pairs the privileged DATABASE_SYSTEM_URL role with the
// restricted DATABASE_URL role, so bind those two through the shared guard.
await vi.hoisted(async () => {
  const owner = process.env.DATABASE_SYSTEM_URL
  const runtime = process.env.DATABASE_URL
  if (process.env.LYRASHIELD_TEST_DB_DISPOSABLE !== "1" || !owner || !runtime) return
  const { assertDisposableDatabasePair } =
    await import("../../../.github/scripts/vitest-database-env.mjs")
  assertDisposableDatabasePair({
    ...process.env,
    DATABASE_URL: owner,
    RLS_RUNTIME_DATABASE_URL: runtime,
  })
})

const enabled =
  process.env.DELEGATED_PROVENANCE_POSTGRES_TEST === "1" &&
  process.env.LYRASHIELD_TEST_DB_DISPOSABLE === "1"

const owner = enabled ? getSystemPrisma() : prisma
const suffix = randomUUID()
const workspaceId = `delegated-provenance-ws-${suffix}`
const userOneId = `delegated-provenance-user-a-${suffix}`
const userTwoId = `delegated-provenance-user-b-${suffix}`
const connectionOneId = `delegated-provenance-conn-a-${suffix}`
const connectionTwoId = `delegated-provenance-conn-b-${suffix}`
const operationOneId = `delegated-provenance-op-a-${suffix}`
const operationTwoId = `delegated-provenance-op-b-${suffix}`
const operationThreeId = `delegated-provenance-op-c-${suffix}`
const targetOneId = `delegated-provenance-target-a-${suffix}`
const targetTwoId = `delegated-provenance-target-b-${suffix}`
const policyId = `delegated-provenance-policy-${suffix}`
const proof = `server-proof-${suffix}`
let memberOneUpdatedAt: Date
let memberOneId: string

async function createOperation(id: string, connectionId: string, key: string) {
  return owner.agentOperation.create({
    data: {
      id,
      workspaceId,
      connectionId,
      principalType: "OAUTH_CONNECTION",
      principalId: connectionId,
      operationName: "scan.create",
      idempotencyKey: key,
      inputHash: `input-hash-${id}`,
      admissionProofHash: hashDelegatedAdmissionProof(proof),
      authorizationVersion: 2,
      status: "EXECUTING",
    },
  })
}

describe.skipIf(!enabled)("delegated scan provenance with PostgreSQL", () => {
  beforeAll(async () => {
    const ownerUrl = new URL(process.env.DATABASE_SYSTEM_URL ?? "")
    const runtimeUrl = new URL(process.env.DATABASE_URL ?? "")
    if (
      ownerUrl.hostname !== "127.0.0.1" ||
      runtimeUrl.hostname !== ownerUrl.hostname ||
      ownerUrl.host !== runtimeUrl.host ||
      ownerUrl.pathname !== "/lyrashield_test" ||
      runtimeUrl.pathname !== ownerUrl.pathname ||
      ownerUrl.username !== "postgres" ||
      runtimeUrl.username !== "delegated_provenance_runtime"
    ) {
      throw new Error("expected the task-owned disposable database and fixture roles")
    }
    const [role] = await prisma.$queryRaw<
      Array<{ rolsuper: boolean; rolbypassrls: boolean }>
    >`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false })

    await owner.user.createMany({
      data: [
        { id: userOneId, name: "Delegated provenance A", email: `${userOneId}@example.invalid` },
        { id: userTwoId, name: "Delegated provenance B", email: `${userTwoId}@example.invalid` },
      ],
    })
    await owner.workspace.create({
      data: { id: workspaceId, name: "Delegated provenance", slug: workspaceId },
    })
    const memberOne = await owner.workspaceMember.create({
      data: { workspaceId, userId: userOneId, status: "active", role: "OWNER" },
    })
    memberOneId = memberOne.id
    memberOneUpdatedAt = memberOne.updatedAt
    await owner.policy.create({
      data: { id: policyId, workspaceId, name: "Provenance fixture" },
    })
    await owner.target.createMany({
      data: [
        { id: targetOneId, workspaceId, type: "REPO", name: "target-a" },
        { id: targetTwoId, workspaceId, type: "REPO", name: "target-b" },
      ],
    })
    await owner.agentConnection.createMany({
      data: [
        {
          id: connectionOneId,
          workspaceId,
          userId: userOneId,
          clientType: "mcp",
          authorizationVersion: 2,
          scopes: ["lyrashield.read", "lyrashield.write"],
          allowedOperations: ["scan.create"],
          allowedProfiles: ["STANDARD", "QUICK"],
          allTargets: true,
        },
        {
          id: connectionTwoId,
          workspaceId,
          userId: userTwoId,
          clientType: "mcp",
          authorizationVersion: 2,
          scopes: ["lyrashield.read", "lyrashield.write"],
          allowedOperations: ["scan.create"],
          allowedProfiles: ["STANDARD", "QUICK"],
          allTargets: true,
        },
      ],
    })
    await createOperation(operationOneId, connectionOneId, "key-a")
    await createOperation(operationTwoId, connectionTwoId, "key-b")
    await createOperation(operationThreeId, connectionOneId, "key-c")
  })

  afterAll(async () => {
    await owner.userScanSlot.deleteMany({ where: { workspaceId } })
    await owner.scanCapacityReservation.deleteMany({ where: { workspaceId } })
    await owner.workspace.deleteMany({ where: { id: workspaceId } })
    await owner.user.deleteMany({ where: { id: { in: [userOneId, userTwoId] } } })
    await owner.$disconnect()
    await prisma.$disconnect()
  })

  it("commits scan, funding and immutable provenance together and rejects updates", async () => {
    const scan = await createScan(
      {
        workspaceId,
        targetId: targetOneId,
        policyId,
        goal: "TEST_APP",
        mode: "STANDARD",
        createdById: userOneId,
        delegatedConnection: { connectionId: connectionOneId, authorizationVersion: 2 },
        delegatedOperation: {
          operationId: operationOneId,
          admissionProof: proof,
          connectionId: connectionOneId,
          authorizationVersion: 2,
        },
      },
      undefined
    )

    const [operation, provenance, reservation] = await Promise.all([
      owner.agentOperation.findUniqueOrThrow({ where: { id: operationOneId } }),
      owner.delegatedScanProvenance.findUniqueOrThrow({ where: { operationId: operationOneId } }),
      owner.scanCapacityReservation.findUniqueOrThrow({ where: { scanId: scan.id } }),
    ])
    expect(operation.resultReference).toBe(scan.id)
    expect(provenance).toMatchObject({
      workspaceId,
      scanId: scan.id,
      targetId: targetOneId,
      connectionId: connectionOneId,
      authorizationVersion: 2,
      operationInputHash: `input-hash-${operationOneId}`,
    })
    expect(reservation.state).toBe("WAITING")

    await expect(
      owner.delegatedScanProvenance.update({
        where: { operationId: operationOneId },
        data: { authorizationVersion: 3 },
      })
    ).rejects.toThrow(/immutable/)
  })

  it("rolls back the scan and slot when a forged proof fails the binding", async () => {
    await expect(
      createScan({
        workspaceId,
        targetId: targetTwoId,
        policyId,
        goal: "TEST_APP",
        mode: "STANDARD",
        createdById: userTwoId,
        delegatedConnection: { connectionId: connectionTwoId, authorizationVersion: 2 },
        delegatedOperation: {
          operationId: operationTwoId,
          admissionProof: "forged-proof",
          connectionId: connectionTwoId,
          authorizationVersion: 2,
        },
      })
    ).rejects.toThrow("Delegated scan admission is no longer valid")

    expect(await owner.scan.findFirst({ where: { targetId: targetTwoId } })).toBeNull()
    expect(await owner.userScanSlot.findFirst({ where: { userId: userTwoId } })).toBeNull()
    expect(
      await owner.agentOperation.findUniqueOrThrow({ where: { id: operationTwoId } })
    ).toMatchObject({ status: "EXECUTING", resultReference: null })
  })

  it("enforces one scan per provenance row", async () => {
    const scan = await owner.scan.findFirstOrThrow({ where: { targetId: targetOneId } })
    await expect(
      owner.delegatedScanProvenance.create({
        data: {
          operationId: operationThreeId,
          workspaceId,
          scanId: scan.id,
          targetId: targetOneId,
          connectionId: connectionOneId,
          authorizationVersion: 2,
          operationInputHash: `input-hash-${operationThreeId}`,
          scanExecutionPlanHash: scan.executionPlanHash!,
        },
      })
    ).rejects.toMatchObject({ code: "P2002" })
  })

  it("authorizes and projects operation status in one RLS snapshot", async () => {
    const scan = await owner.scan.findFirstOrThrow({ where: { targetId: targetOneId } })
    await owner.agentOperation.update({
      where: { id: operationOneId },
      data: { status: "COMPLETED", error: "raw provider body" },
    })
    const status = await getDelegatedOperationStatus({
      operationId: operationOneId,
      workspaceId,
      userId: userOneId,
      memberId: (await owner.workspaceMember.findFirstOrThrow({ where: { userId: userOneId } })).id,
      memberRole: "OWNER",
      memberUpdatedAt: memberOneUpdatedAt,
      connectionId: connectionOneId,
      authorizationVersion: 2,
    })
    expect(status).toMatchObject({
      operationId: operationOneId,
      status: "COMPLETED",
      reasonCode: "OPERATION_FAILED",
      resultLocation: scan.id,
      recovery: "none",
    })
    expect(
      await getDelegatedActiveTargetIds({
        workspaceId,
        userId: userOneId,
        memberId: (await owner.workspaceMember.findFirstOrThrow({ where: { userId: userOneId } }))
          .id,
        memberRole: "OWNER",
        memberUpdatedAt: memberOneUpdatedAt,
        connectionId: connectionOneId,
        authorizationVersion: 2,
      })
    ).toEqual([targetOneId, targetTwoId].sort())
    expect(
      await getDelegatedScanAccess({
        scanId: scan.id,
        workspaceId,
        userId: userOneId,
        memberId: (await owner.workspaceMember.findFirstOrThrow({ where: { userId: userOneId } }))
          .id,
        memberRole: "OWNER",
        memberUpdatedAt: memberOneUpdatedAt,
        connectionId: connectionOneId,
        authorizationVersion: 2,
      })
    ).toMatchObject({ scanId: scan.id, status: "QUEUED", statusOnly: false })

    await owner.target.update({ where: { id: targetOneId }, data: { deletedAt: new Date() } })
    try {
      const deleted = await getDelegatedOperationStatus({
        operationId: operationOneId,
        workspaceId,
        userId: userOneId,
        memberId: (await owner.workspaceMember.findFirstOrThrow({ where: { userId: userOneId } }))
          .id,
        memberRole: "OWNER",
        memberUpdatedAt: memberOneUpdatedAt,
        connectionId: connectionOneId,
        authorizationVersion: 2,
      })
      expect(deleted).toMatchObject({
        operationId: operationOneId,
        status: "COMPLETED",
        reasonCode: null,
        resultLocation: scan.id,
        recovery: "none",
      })
      expect(
        await getDelegatedScanAccess({
          scanId: scan.id,
          workspaceId,
          userId: userOneId,
          memberId: (await owner.workspaceMember.findFirstOrThrow({ where: { userId: userOneId } }))
            .id,
          memberRole: "OWNER",
          memberUpdatedAt: memberOneUpdatedAt,
          connectionId: connectionOneId,
          authorizationVersion: 2,
        })
      ).toMatchObject({ scanId: scan.id, status: "QUEUED", statusOnly: true })
      expect(
        await getDelegatedActiveTargetIds({
          targetId: targetOneId,
          workspaceId,
          userId: userOneId,
          memberId: (await owner.workspaceMember.findFirstOrThrow({ where: { userId: userOneId } }))
            .id,
          memberRole: "OWNER",
          memberUpdatedAt: memberOneUpdatedAt,
          connectionId: connectionOneId,
          authorizationVersion: 2,
        })
      ).toBeNull()

      await owner.agentConnection.update({
        where: { id: connectionOneId },
        data: { allTargets: false, allowedTargetIds: [] },
      })
      expect(
        await getDelegatedOperationStatus({
          operationId: operationOneId,
          workspaceId,
          userId: userOneId,
          memberId: (await owner.workspaceMember.findFirstOrThrow({ where: { userId: userOneId } }))
            .id,
          memberRole: "OWNER",
          memberUpdatedAt: memberOneUpdatedAt,
          connectionId: connectionOneId,
          authorizationVersion: 2,
        })
      ).toBeNull()
      expect(
        await getDelegatedScanAccess({
          scanId: scan.id,
          workspaceId,
          userId: userOneId,
          memberId: (await owner.workspaceMember.findFirstOrThrow({ where: { userId: userOneId } }))
            .id,
          memberRole: "OWNER",
          memberUpdatedAt: memberOneUpdatedAt,
          connectionId: connectionOneId,
          authorizationVersion: 2,
        })
      ).toBeNull()
    } finally {
      await owner.agentConnection.update({
        where: { id: connectionOneId },
        data: { allTargets: true, allowedTargetIds: [] },
      })
      await owner.target.update({ where: { id: targetOneId }, data: { deletedAt: null } })
    }

    const legacy = await getDelegatedOperationStatus({
      operationId: operationThreeId,
      workspaceId,
      userId: userOneId,
      memberId: (await owner.workspaceMember.findFirstOrThrow({ where: { userId: userOneId } })).id,
      memberRole: "OWNER",
      memberUpdatedAt: memberOneUpdatedAt,
      connectionId: connectionOneId,
      authorizationVersion: 2,
    })
    expect(legacy).toMatchObject({
      operationId: operationThreeId,
      status: "EXECUTING",
      reasonCode: null,
      resultLocation: null,
      recovery: "poll",
    })
  })

  async function currentPrincipal() {
    const member = await owner.workspaceMember.findUniqueOrThrow({ where: { id: memberOneId } })
    return {
      workspaceId,
      userId: userOneId,
      memberId: member.id,
      memberRole: member.role,
      memberUpdatedAt: member.updatedAt,
      connectionId: connectionOneId,
      authorizationVersion: 2,
      targetId: targetOneId,
      requiredOperation: "scan.create",
      requiredProfile: "STANDARD",
    }
  }

  async function expectMutationFenced(
    mutate: (tx: Prisma.TransactionClient) => Promise<unknown>,
    restore: () => Promise<unknown>
  ) {
    const principal = await currentPrincipal()
    let markEntered!: () => void
    let release!: () => void
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve
    })
    const hold = new Promise<void>((resolve) => {
      release = resolve
    })
    const heldRead = withDelegatedReadAuthority(principal, async (_tx, authority) => {
      markEntered()
      await hold
      return authority
    })

    try {
      await entered
      await expect(
        owner.$transaction(async (tx) => {
          await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '100ms'")
          await mutate(tx)
        })
      ).rejects.toThrow()
      release()
      await expect(heldRead).resolves.toMatchObject({ targetId: targetOneId })
      await owner.$transaction(mutate)
      await expect(withDelegatedReadAuthority(principal, async () => null)).rejects.toThrow(
        "FORBIDDEN"
      )
    } finally {
      release()
      await heldRead.catch(() => undefined)
      await restore()
    }
  }

  it("serializes delegated reads with revocation and denies the next read", async () => {
    await expectMutationFenced(
      (tx) =>
        tx.agentConnection.update({ where: { id: connectionOneId }, data: { status: "REVOKED" } }),
      () =>
        owner.agentConnection.update({ where: { id: connectionOneId }, data: { status: "ACTIVE" } })
    )
  })

  it("serializes delegated reads with target narrowing and denies the next read", async () => {
    await expectMutationFenced(
      (tx) =>
        tx.agentConnection.update({
          where: { id: connectionOneId },
          data: { allTargets: false, allowedTargetIds: [] },
        }),
      () =>
        owner.agentConnection.update({
          where: { id: connectionOneId },
          data: { allTargets: true, allowedTargetIds: [] },
        })
    )
  })

  it("serializes delegated reads with member role changes and denies the next read", async () => {
    await expectMutationFenced(
      (tx) => tx.workspaceMember.update({ where: { id: memberOneId }, data: { role: "VIEWER" } }),
      () => owner.workspaceMember.update({ where: { id: memberOneId }, data: { role: "OWNER" } })
    )
  })

  it("serializes delegated reads with target deletion and denies the next read", async () => {
    await expectMutationFenced(
      (tx) => tx.target.update({ where: { id: targetOneId }, data: { deletedAt: new Date() } }),
      () => owner.target.update({ where: { id: targetOneId }, data: { deletedAt: null } })
    )
  })

  it("returns an empty page for an authorized connection with zero active targets", async () => {
    const member = await owner.workspaceMember.findUniqueOrThrow({ where: { id: memberOneId } })
    await owner.target.updateMany({ where: { workspaceId }, data: { deletedAt: new Date() } })
    try {
      const authority = await withDelegatedReadAuthority(
        {
          workspaceId,
          userId: userOneId,
          memberId: member.id,
          memberRole: member.role,
          memberUpdatedAt: member.updatedAt,
          connectionId: connectionOneId,
          authorizationVersion: 2,
        },
        async (_tx, active) => active
      )
      expect(authority).toMatchObject({ targetIds: [] })
    } finally {
      await owner.target.updateMany({ where: { workspaceId }, data: { deletedAt: null } })
    }
  })

  it("serializes delegated reads with operation and profile narrowing", async () => {
    await expectMutationFenced(
      (tx) =>
        tx.agentConnection.update({
          where: { id: connectionOneId },
          data: { allowedOperations: [], allowedProfiles: ["DEEP"] },
        }),
      () =>
        owner.agentConnection.update({
          where: { id: connectionOneId },
          data: { allowedOperations: ["scan.create"], allowedProfiles: ["STANDARD", "QUICK"] },
        })
    )
  })

  it.each(["enqueue then revoke", "revoke then enqueue"])(
    "rejects queued delegated fix work when %s",
    async (order) => {
      const scan = await owner.scan.findFirstOrThrow({ where: { targetId: targetOneId } })
      const recheck = () =>
        withWorkspaceRLS(workspaceId, (tx) =>
          getCurrentDelegatedScanAuthority(tx, {
            workspaceId,
            userId: userOneId,
            scanId: scan.id,
            targetId: targetOneId,
            connectionId: connectionOneId,
            authorizationVersion: 2,
            operationName: "fix_proposal.create",
            profile: scan.mode,
          })
        )
      const queue: string[] = []
      try {
        await owner.agentConnection.update({
          where: { id: connectionOneId },
          data: { allowedOperations: ["scan.create", "fix_proposal.create"] },
        })
        if (order === "revoke then enqueue") {
          await owner.agentConnection.update({
            where: { id: connectionOneId },
            data: { status: "REVOKED" },
          })
        } else {
          expect(await recheck()).not.toBeNull()
        }
        queue.push(`fix:${scan.id}`)
        if (order === "enqueue then revoke") {
          await owner.agentConnection.update({
            where: { id: connectionOneId },
            data: { status: "REVOKED" },
          })
        }
        expect(await recheck()).toBeNull()
        expect(queue).toEqual([`fix:${scan.id}`])
      } finally {
        await owner.agentConnection.update({
          where: { id: connectionOneId },
          data: { status: "ACTIVE", allowedOperations: ["scan.create"] },
        })
      }
    }
  )
})
