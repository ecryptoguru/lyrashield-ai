import { generateKeyPairSync, randomUUID } from "node:crypto"
import { PrismaPg } from "@prisma/adapter-pg"
import {
  computeReleasePacketChecksum,
  RELEASE_PACKET_VERSION,
  ReleasePacketPayloadSchema,
} from "@lyrashield/types"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { Prisma, PrismaClient } from "./generated/prisma"
import { getReleasePacket } from "./release-packet-service"
import { releasePacketSigningKeyId, signReleasePacketChecksum } from "./release-packet-signing"

// Hoisting runs this guard before imports can construct the runtime client.
// The fixture pairs the privileged DATABASE_SYSTEM_URL role with the restricted
// DATABASE_URL role, so bind those two through the shared disposable-pair guard.
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

const enabled = process.env.RELEASE_PACKET_RLS_RUNTIME_TEST === "1"
const ownerUrl = process.env.DATABASE_SYSTEM_URL
const runtimeUrl = process.env.DATABASE_URL
const suffix = randomUUID()
const workspaceId = `packet-${suffix}`
const otherWorkspaceId = `packet-other-${suffix}`
const owner = new PrismaClient({ adapter: new PrismaPg({ connectionString: ownerUrl }) })
const runtime = new PrismaClient({ adapter: new PrismaPg({ connectionString: runtimeUrl }) })
const pair = generateKeyPairSync("ed25519")
const privateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString()
const publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString()
const keyId = releasePacketSigningKeyId(publicKey)
const keys = [{ id: keyId, publicKey, revoked: false }]
const now = new Date("2026-11-06T00:00:00.000Z")
let reportId = ""
let fixtureCreated = false

describe.skipIf(!enabled)("signed release packet reads with workspace RLS", () => {
  beforeAll(async () => {
    expect(process.env.LYRASHIELD_TEST_DB_DISPOSABLE).toBe("1")
    for (const connection of [ownerUrl, runtimeUrl]) {
      const url = new URL(connection ?? "")
      expect(["localhost", "127.0.0.1", "[::1]"]).toContain(url.hostname)
      expect(url.pathname).toBe("/lyrashield")
    }
    const [role] = await runtime.$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false })
    await owner.workspace.createMany({
      data: [
        { id: workspaceId, name: "Packet fixture", slug: workspaceId },
        { id: otherWorkspaceId, name: "Other fixture", slug: otherWorkspaceId },
      ],
    })
    fixtureCreated = true
    const target = await owner.target.create({
      data: { workspaceId, name: "Packet target", type: "REPO" },
    })
    const scan = await owner.scan.create({
      data: {
        workspaceId,
        targetId: target.id,
        createdById: `packet-user-${suffix}`,
        goal: "TEST_APP",
        mode: "SAFE",
        status: "COMPLETED",
      },
    })
    const base = {
      version: RELEASE_PACKET_VERSION,
      generatedAt: now.toISOString(),
      expiresAt: "2026-11-07T00:00:00.000Z",
      signingKeyId: keyId,
      target: { id: target.id, name: target.name, type: target.type, environment: null },
      assessment: {
        verdictId: "fixture-verdict",
        standardVersion: "v1",
        state: "INSUFFICIENT_EVIDENCE" as const,
        historicalState: "INSUFFICIENT_EVIDENCE" as const,
        applicable: false,
        reasons: [],
        evaluatedAt: now.toISOString(),
        assessedIdentity: null,
        coverageStatement: [],
        nonCoverage: [],
      },
      signedAssessment: { state: "UNSIGNED" as const },
      remediation: {
        baselineScanId: null,
        currentScanId: scan.id,
        counts: { newFindings: 0, recurringFindings: 0, resolvedFindings: 0, uncertainMatches: 0 },
        findings: [],
        truncated: false,
      },
      coverage: { completed: [], notApplicable: [], incomplete: [], manifestChecksum: null },
    }
    const packetChecksum = await computeReleasePacketChecksum(base)
    const report = await owner.report.create({
      data: {
        workspaceId,
        scanId: scan.id,
        type: "release_packet",
        title: "Packet fixture",
        createdById: `packet-user-${suffix}`,
        contentJson: {
          ...base,
          packetChecksum,
          packetSignature: signReleasePacketChecksum(packetChecksum, privateKey),
        },
      },
    })
    reportId = report.id
  })

  afterAll(async () => {
    if (fixtureCreated)
      await owner.workspace.deleteMany({ where: { id: { in: [workspaceId, otherWorkspaceId] } } })
    await owner.$disconnect()
    await runtime.$disconnect()
  })

  it("verifies stored bytes inside the owning workspace and rejects cross-workspace and changed data", async () => {
    const read = (scope: string) =>
      getReleasePacket(reportId, scope, { verificationKeys: keys, now })
    expect((await read(workspaceId))?.authenticity.signatureState).toBe("VERIFIED")
    expect(await read(otherWorkspaceId)).toBeNull()
    const foreignRows = await runtime.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${otherWorkspaceId}, true)`
      return tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "Report" WHERE id = ${reportId}`
    })
    expect(foreignRows).toEqual([])
    const stored = await owner.report.findUniqueOrThrow({ where: { id: reportId } })
    const packet = ReleasePacketPayloadSchema.parse(stored.contentJson)
    const changed = {
      ...packet,
      target: { ...packet.target, name: "Altered" },
    }
    const packetChecksum = await computeReleasePacketChecksum(changed)
    const changedContent: Prisma.InputJsonObject = { ...changed, packetChecksum }
    await owner.report.update({
      where: { id: reportId },
      data: { contentJson: changedContent },
    })
    expect((await read(workspaceId))?.authenticity.signatureState).toBe("INVALID")
    expect((await read(workspaceId))?.currentApplicability.state).toBe("UNAVAILABLE")
  })
})
