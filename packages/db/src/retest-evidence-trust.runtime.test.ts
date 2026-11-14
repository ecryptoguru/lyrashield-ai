import { createHash, randomUUID } from "node:crypto"
import { PrismaPg } from "@prisma/adapter-pg"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { Prisma, PrismaClient } from "./generated/prisma"
import { loadReceiptBackedRetestFindingIds } from "./retest-evidence-trust"
import { withWorkspaceRLS } from "./rls"

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

const enabled = process.env.RETEST_TRUST_RLS_RUNTIME_TEST === "1"
const ownerUrl = process.env.DATABASE_SYSTEM_URL
const runtimeUrl = process.env.DATABASE_URL
const suffix = randomUUID()
const workspaceId = `retest-trust-${suffix}`
const otherWorkspaceId = `retest-other-${suffix}`
const owner = new PrismaClient({ adapter: new PrismaPg({ connectionString: ownerUrl }) })
const runtime = new PrismaClient({ adapter: new PrismaPg({ connectionString: runtimeUrl }) })
let targetId = ""
let findingId = ""
let baselineId = ""
let retestScanId = ""
let retestCoverageId = ""
let fixtureCreated = false

describe.skipIf(!enabled)("receipt-backed retests with workspace RLS", () => {
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
        { id: workspaceId, name: "Retest trust", slug: workspaceId },
        { id: otherWorkspaceId, name: "Other workspace", slug: otherWorkspaceId },
      ],
    })
    fixtureCreated = true
    const target = await owner.target.create({
      data: { workspaceId, name: "Retest", type: "REPO" },
    })
    targetId = target.id
    const scan = async () =>
      owner.scan.create({
        data: {
          workspaceId,
          targetId,
          createdById: `fixture-${suffix}`,
          goal: "TEST_APP",
          mode: "SAFE",
          status: "COMPLETED",
        },
      })
    baselineId = (await scan()).id
    retestScanId = (await scan()).id
    const finding = await owner.finding.create({
      data: {
        workspaceId,
        targetId,
        scanId: baselineId,
        title: "Fixture",
        summary: "Fixture",
        severity: "HIGH",
        status: "FIXED",
        dedupeKey: `finding-${suffix}`,
      },
    })
    findingId = finding.id
    await owner.findingCandidate.create({
      data: {
        workspaceId,
        targetId,
        scanId: baselineId,
        findingId,
        scannerSource: "sca",
        dedupeKey: finding.dedupeKey,
        payload: {},
        evidenceHash: "a".repeat(64),
      },
    })
    const identities = []
    const coverageIds = []
    for (const [scanId, revision] of [
      [baselineId, "b".repeat(40)],
      [retestScanId, "c".repeat(40)],
    ]) {
      const manifest = {
        target: { id: targetId, type: "REPO" },
        sourceExecution: { sourceRevision: revision },
        terminalOutcome: { status: "COMPLETED" },
        coverage: [{ scanner: "sca", controlId: "sca", status: "COMPLETED" }],
      }
      const checksumInput = JSON.stringify(manifest)
      const checksum = createHash("sha256").update(checksumInput).digest("hex")
      await owner.scanResultManifest.create({ data: { scanId, checksum, checksumInput, manifest } })
      const coverage = await owner.scanCoverageReceipt.create({
        data: { scanId, scanner: "sca", controlId: "sca", status: "COMPLETED" },
      })
      coverageIds.push(coverage.id)
      identities.push({
        scanId,
        manifestChecksum: checksum,
        sourceRevision: revision,
        targetUrlChecksum: null,
      })
    }
    retestCoverageId = coverageIds[1]!
    const retest = await owner.retest.create({
      data: { workspaceId, findingId, scanId: retestScanId, status: "passed" },
    })
    const evidence: Prisma.InputJsonObject = {
      retestId: retest.id,
      scannerSource: "sca",
      baseline: identities[0]!,
      retest: identities[1]!,
      coverageReceiptIds: coverageIds,
    }
    await owner.findingVerification.create({
      data: {
        workspaceId,
        findingId,
        scanId: retestScanId,
        status: "VALIDATED",
        method: "RETEST",
        reason: "Fixture",
        verifierVersion: "result-integrity-v3",
        idempotencyKey: `retest-trust-${suffix}`,
        evidence,
      },
    })
  })

  afterAll(async () => {
    if (fixtureCreated)
      await owner.workspace.deleteMany({ where: { id: { in: [workspaceId, otherWorkspaceId] } } })
    await owner.$disconnect()
    await runtime.$disconnect()
  })

  it("accepts complete evidence only inside its workspace", async () => {
    const finding = await owner.finding.findUniqueOrThrow({
      where: { id: findingId },
      select: {
        id: true,
        scanId: true,
        dedupeKey: true,
        verificationReceipts: {
          select: {
            status: true,
            method: true,
            scanId: true,
            verifierVersion: true,
            evidence: true,
          },
        },
      },
    })
    const read = (scope: string) =>
      withWorkspaceRLS(scope, (tx) =>
        loadReceiptBackedRetestFindingIds(tx, {
          workspaceId: scope,
          targetId,
          findings: [finding],
        })
      )
    expect(await read(workspaceId)).toEqual(new Set([findingId]))
    expect(await read(otherWorkspaceId)).toEqual(new Set())
    await owner.scanCoverageReceipt.update({
      where: { id: retestCoverageId },
      data: { status: "PARTIAL" },
    })
    expect(await read(workspaceId)).toEqual(new Set())
  })
})
