import { createHash, generateKeyPairSync, randomUUID } from "node:crypto"
import { PrismaPg } from "@prisma/adapter-pg"
import { requiredScannersForTarget } from "@lyrashield/gate"
import { RESULT_MANIFEST_VERSION } from "@lyrashield/types"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

await vi.hoisted(async () => {
  if (process.env.RELEASE_PACKET_ISSUANCE_RUNTIME_TEST === "1") {
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

import { PrismaClient } from "./generated/prisma"
import { prisma } from "./client"
import { withWorkspaceRLS } from "./rls"
import * as gateEvaluation from "./gate-evaluation-service"
import { issueReleasePacket } from "./release-packet-service"
import { releasePacketSigningKeyId } from "./release-packet-signing"

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
})
const enabled = process.env.RELEASE_PACKET_ISSUANCE_RUNTIME_TEST === "1"
const workspaceId = `packet-rr-${randomUUID()}`
const otherWorkspaceId = `${workspaceId}-other`
const revision = "c".repeat(40)
const pair = generateKeyPairSync("ed25519")
const privateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString()
const publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString()
let targetId = ""
let scanId = ""
let originalManifest: {
  target: { id: string; type: string }
  sourceExecution: { sourceRevision: string }
  terminalOutcome: { status: string }
  coverage: Array<{
    scanner: string
    controlId: string
    status: string
    metadata: { fixture: boolean }
  }>
}

async function storeManifest(manifest: typeof originalManifest) {
  const checksumInput = JSON.stringify(manifest)
  await owner.scanResultManifest.upsert({
    where: { scanId },
    create: {
      scanId,
      version: RESULT_MANIFEST_VERSION,
      manifest,
      checksumInput,
      checksum: createHash("sha256").update(checksumInput).digest("hex"),
    },
    update: {
      manifest,
      checksumInput,
      checksum: createHash("sha256").update(checksumInput).digest("hex"),
    },
  })
}

describe.skipIf(!enabled)("release packet PostgreSQL issuance consistency", () => {
  beforeAll(async () => {
    const [role] = await prisma.$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false })
    const policies = await prisma.$queryRaw<
      Array<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>
    >`
      SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE relname IN ('GateVerdict', 'Report', 'ScanCoverageReceipt', 'ScanResultManifest')`
    expect(policies).toHaveLength(4)
    expect(policies.every((table) => table.relrowsecurity && table.relforcerowsecurity)).toBe(true)
    await owner.user.create({
      data: { id: workspaceId, name: "Packet test", email: `${workspaceId}@example.invalid` },
    })
    await owner.workspace.createMany({
      data: [
        { id: workspaceId, name: "Packet test", slug: workspaceId },
        { id: otherWorkspaceId, name: "Other packet test", slug: otherWorkspaceId },
      ],
    })
    await owner.workspaceMember.create({
      data: { workspaceId, userId: workspaceId, role: "OWNER", status: "active" },
    })
    const target = await owner.target.create({
      data: { workspaceId, name: "Packet target", type: "REPO" },
    })
    targetId = target.id
    const policy = await owner.policy.create({ data: { workspaceId, name: "Packet policy" } })
    const scan = await owner.scan.create({
      data: {
        workspaceId,
        targetId,
        policyId: policy.id,
        createdById: workspaceId,
        goal: "LAUNCH_REVIEW",
        mode: "STANDARD",
        status: "COMPLETED",
        endedAt: new Date(),
      },
    })
    scanId = scan.id
    const coverage = requiredScannersForTarget("REPO", "STANDARD").map((scanner) => ({
      scanner,
      controlId: scanner,
      status: "COMPLETED",
      metadata: { fixture: true },
    }))
    originalManifest = {
      target: { id: targetId, type: "REPO" },
      sourceExecution: { sourceRevision: revision },
      terminalOutcome: { status: "COMPLETED" },
      coverage,
    }
    await owner.scanCoverageReceipt.createMany({
      data: coverage.map((row) => ({ ...row, scanId, status: "COMPLETED" })),
    })
    await storeManifest(originalManifest)
  })

  afterAll(async () => {
    vi.restoreAllMocks()
    await owner.workspace.deleteMany({ where: { id: { in: [workspaceId, otherWorkspaceId] } } })
    await owner.user.deleteMany({ where: { id: workspaceId } })
    await owner.$disconnect()
    await prisma.$disconnect()
  })

  it("rolls back contradictory coverage, binds its own snapshot despite a concurrent latest verdict, and enforces RLS", async () => {
    const input = {
      workspaceId,
      targetId,
      actorUserId: workspaceId,
      expectedIdentity: { kind: "COMMIT" as const, value: revision },
      signingPrivateKey: privateKey,
      verificationKeys: [{ id: releasePacketSigningKeyId(publicKey), publicKey, revoked: false }],
    }
    const mismatch = structuredClone(originalManifest)
    mismatch.coverage.find((row) => row.scanner === "engine")!.status = "BLOCKED"
    await storeManifest(mismatch)
    const actualEvaluate = gateEvaluation.evaluateGateForTarget
    let rolledBackVerdictId = ""
    const evaluation = vi
      .spyOn(gateEvaluation, "evaluateGateForTarget")
      .mockImplementation(async (...args) => {
        const result = await actualEvaluate(...args)
        rolledBackVerdictId = result?.gateVerdictId ?? ""
        return result
      })
    await expect(issueReleasePacket(input)).rejects.toMatchObject({ code: "ASSESSMENT_INCOMPLETE" })
    expect(rolledBackVerdictId).not.toBe("")
    expect(await owner.gateVerdict.findUnique({ where: { id: rolledBackVerdictId } })).toBeNull()
    expect(await owner.gateVerdict.count({ where: { workspaceId } })).toBe(0)
    expect(await owner.report.count({ where: { workspaceId } })).toBe(0)
    await storeManifest(originalManifest)

    let release!: () => void
    let reached!: () => void
    const resume = new Promise<void>((resolve) => {
      release = resolve
    })
    const assessed = new Promise<void>((resolve) => {
      reached = resolve
    })
    let ownVerdictId = ""
    let snapshotLatestId = ""
    evaluation.mockImplementation(async (...args) => {
      const result = await actualEvaluate(...args)
      ownVerdictId = result?.gateVerdictId ?? ""
      const tx = args[2]?.transaction
      if (!tx) throw new Error("Packet evaluation did not reuse its transaction")
      const [isolation] = await tx.$queryRaw<
        Array<{ transaction_isolation: string }>
      >`SHOW transaction_isolation`
      expect(isolation?.transaction_isolation).toBe("repeatable read")
      reached()
      await resume
      snapshotLatestId =
        (
          await tx.gateVerdict.findFirst({
            where: { workspaceId, targetId },
            orderBy: [{ evaluatedAt: "desc" }, { id: "desc" }],
          })
        )?.id ?? ""
      return result
    })
    const issuance = issueReleasePacket(input)
    await Promise.race([
      assessed,
      issuance.then(() => {
        throw new Error("Issuance completed before the race barrier")
      }),
    ])
    let racingVerdictId = ""
    try {
      const racing = await owner.gateVerdict.create({
        data: {
          workspaceId,
          targetId,
          scanId,
          standardVersion: "legacy-fixture",
          state: "READY",
          coverageStatement: [],
          nonCoverage: [],
          blockingReasons: [],
          evidenceSummary: {},
          staleness: {},
          inputChecksum: "0".repeat(64),
          verdictChecksum: "0".repeat(64),
          evaluatedAt: new Date(Date.now() + 60_000),
        },
      })
      racingVerdictId = racing.id
    } finally {
      release()
    }
    const packet = await issuance
    expect(packet.payload.assessment.verdictId).toBe(ownVerdictId)
    expect(packet.payload.assessment.verdictId).not.toBe(racingVerdictId)
    expect(snapshotLatestId).toBe(ownVerdictId)
    expect(
      (
        await owner.gateVerdict.findFirst({
          where: { workspaceId, targetId },
          orderBy: [{ evaluatedAt: "desc" }, { id: "desc" }],
        })
      )?.id
    ).toBe(racingVerdictId)
    const foreign = await withWorkspaceRLS(otherWorkspaceId, async (tx) => ({
      verdicts: await tx.$queryRaw<
        Array<{ id: string }>
      >`SELECT id FROM "GateVerdict" WHERE id IN (${ownVerdictId}, ${racingVerdictId})`,
      reports: await tx.$queryRaw<
        Array<{ id: string }>
      >`SELECT id FROM "Report" WHERE id = ${packet.reportId}`,
    }))
    expect(foreign).toEqual({ verdicts: [], reports: [] })
  }, 20_000)
})
