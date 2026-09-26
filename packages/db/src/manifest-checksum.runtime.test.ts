import { createHash, randomUUID } from "node:crypto"
import { PrismaPg } from "@prisma/adapter-pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { PrismaClient } from "./generated/prisma"
import { verifyStoredManifestChecksum } from "./manifest-checksum"

const databaseUrl = process.env.DATABASE_URL
const runtimeUrl = process.env.RLS_RUNTIME_DATABASE_URL
const owner = databaseUrl
  ? new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) })
  : undefined
const suffix = randomUUID().replace(/-/g, "")
const workspaceId = `manifest-checksum-${suffix}`
const scanIds: string[] = []
let targetId: string | undefined

if (!runtimeUrl || !databaseUrl) {
  console.warn(
    "[manifest-checksum.runtime] SKIPPED: requires disposable DATABASE_URL and RLS_RUNTIME_DATABASE_URL"
  )
}

describe.skipIf(!runtimeUrl || !databaseUrl)(
  "stored manifest checksum PostgreSQL round-trip",
  () => {
    beforeAll(async () => {
      if (!owner || !databaseUrl || !runtimeUrl) return
      if (new URL(databaseUrl).pathname !== new URL(runtimeUrl).pathname) {
        throw new Error("DATABASE_URL and RLS_RUNTIME_DATABASE_URL must name the same disposable DB")
      }
      const [column] = await owner.$queryRaw<Array<{ available: boolean }>>`
        SELECT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'ScanResultManifest'
            AND column_name = 'checksumInput'
        ) AS available`
      if (!column?.available) {
        throw new Error("Apply manifest checksum input migration before this runtime test")
      }

      await owner.workspace.create({
        data: { id: workspaceId, name: "Manifest checksum test", slug: workspaceId },
      })
      const target = await owner.target.create({
        data: {
          workspaceId,
          type: "REPO",
          name: "Manifest checksum test",
          repoFullName: `manifest-checksum/${suffix}`,
        },
      })
      targetId = target.id
      for (let index = 0; index < 2; index++) {
        const scan = await owner.scan.create({
          data: {
            workspaceId,
            targetId,
            goal: "TEST_APP",
            mode: "SAFE",
            createdById: `manifest-checksum-${suffix}`,
          },
        })
        scanIds.push(scan.id)
      }
    })

    afterAll(async () => {
      if (!owner) return
      try {
        if (scanIds.length > 0) await owner.scan.deleteMany({ where: { id: { in: scanIds } } })
        if (targetId) await owner.target.deleteMany({ where: { id: targetId } })
        await owner.workspace.deleteMany({ where: { id: workspaceId } })
      } finally {
        await owner.$disconnect()
      }
    })

    it("round-trips reordered JSONB, detects tampering, and leaves legacy hashes unavailable", async () => {
      if (!owner || scanIds.length !== 2) throw new Error("PostgreSQL fixtures were not created")
      const manifest = { zz: { b: 2, a: 1 }, a: [{ y: true, x: false }, 3] }
      const checksumInput = JSON.stringify(manifest)
      const checksum = createHash("sha256").update(checksumInput).digest("hex")
      const scanId = scanIds[0]!

      await owner.scanResultManifest.create({
        data: { scanId, version: 7, manifest, checksum, checksumInput },
      })
      const roundTrip = await owner.scanResultManifest.findUniqueOrThrow({ where: { scanId } })
      expect(JSON.stringify(roundTrip.manifest)).not.toBe(checksumInput)
      expect(roundTrip.checksumInput).toBe(checksumInput)
      expect(verifyStoredManifestChecksum(roundTrip)).toBe("MATCH")

      const tamperedInput = JSON.stringify({ ...manifest, zz: { b: 99, a: 1 } })
      await owner.scanResultManifest.update({
        where: { scanId },
        data: { checksumInput: tamperedInput },
      })
      const tampered = await owner.scanResultManifest.findUniqueOrThrow({ where: { scanId } })
      expect(tampered.checksum).toBe(checksum)
      expect(verifyStoredManifestChecksum(tampered)).toBe("MISMATCH")

      const legacyManifest = { legacy: ["historical"] }
      const legacyChecksumInput = JSON.stringify(legacyManifest)
      const legacyChecksum = createHash("sha256").update(legacyChecksumInput).digest("hex")
      const legacyScanId = scanIds[1]!
      await owner.scanResultManifest.create({
        data: {
          scanId: legacyScanId,
          version: 6,
          manifest: legacyManifest,
          checksum: legacyChecksum,
          checksumInput: null,
        },
      })
      const legacy = await owner.scanResultManifest.findUniqueOrThrow({
        where: { scanId: legacyScanId },
      })
      expect(verifyStoredManifestChecksum(legacy)).toBe("UNAVAILABLE")
      expect(legacy.checksum).toBe(legacyChecksum)
    })
  }
)
