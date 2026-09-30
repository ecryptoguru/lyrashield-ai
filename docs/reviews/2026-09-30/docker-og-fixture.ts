import assert from "node:assert/strict"
import { createRequire } from "node:module"

const databaseUrl = process.env.DATABASE_URL
assert(databaseUrl, "DATABASE_URL must name the disposable Docker fixture")
const destination = new URL(databaseUrl)
assert(["127.0.0.1", "localhost"].includes(destination.hostname), "Loopback DB only")
assert.equal(destination.port, "55439")
assert.equal(destination.pathname, "/ls_hardening")
assert.equal(destination.username, "ls_test_owner")
const action = process.argv[2] ?? "seed"
assert(["seed", "revoke", "expire", "cleanup"].includes(action), "Unknown action")
process.env.BETTER_AUTH_SECRET ??= "disposable-next-og-fixture-secret-32chars"
process.env.BETTER_AUTH_URL ??= "http://127.0.0.1:33009"
process.env.NEXT_PUBLIC_APP_URL ??= "http://127.0.0.1:33009"
const { PrismaClient } = await import("../../../packages/db/src/generated/prisma")
const { buildScorecardPayload } = await import("../../../packages/db/src/score-service")
const require = createRequire(new URL("../../../packages/db/package.json", import.meta.url))
const { PrismaPg } = require("@prisma/adapter-pg")
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) })
const slug = "next-og-disposable-fixture"
const workspaceSlug = "next-og-disposable-workspace"
try {
  if (action === "seed") {
    const record = await prisma.$transaction(async (tx) => {
      assert.equal(
        await tx.workspace.findUnique({ where: { slug: workspaceSlug } }),
        null,
        "Fixture exists; cleanup only this fixture before reseeding"
      )
      const workspace = await tx.workspace.create({
        data: { name: "Disposable OG fixture", slug: workspaceSlug },
      })
      const target = await tx.target.create({
        data: { workspaceId: workspace.id, type: "REPO", name: "Disposable OG target" },
      })
      const scan = await tx.scan.create({
        data: {
          workspaceId: workspace.id,
          targetId: target.id,
          goal: "CHECK_PR",
          mode: "STANDARD",
          status: "COMPLETED",
          createdById: workspace.id,
        },
      })
      const snapshot = await tx.scoreSnapshot.create({
        data: {
          workspaceId: workspace.id,
          targetId: target.id,
          scanId: scan.id,
          modelVersion: "lyrashield-score/1.0.0",
          score: 96,
          grade: "A_PLUS",
          breakdown: {},
          scanMode: "STANDARD",
          shareEligible: true,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      })
      const share = await tx.scorecardShare.create({
        data: {
          snapshotId: snapshot.id,
          slug,
          createdById: workspace.id,
          publicPayload: buildScorecardPayload(snapshot, 2),
        },
      })
      return { shareId: share.id, snapshotId: snapshot.id, workspaceId: workspace.id, slug }
    })
    console.log(JSON.stringify(record))
  } else if (action === "revoke") {
    const share = await prisma.scorecardShare.findUniqueOrThrow({
      where: { slug },
      include: { snapshot: true },
    })
    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { slug: workspaceSlug } })
    assert.equal(share.snapshot.workspaceId, workspace.id)
    await prisma.scorecardShare.update({ where: { id: share.id }, data: { revokedAt: new Date() } })
    console.log(JSON.stringify({ slug, revoked: true }))
  } else if (action === "expire") {
    const share = await prisma.scorecardShare.findUniqueOrThrow({
      where: { slug },
      include: { snapshot: true },
    })
    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { slug: workspaceSlug } })
    assert.equal(share.snapshot.workspaceId, workspace.id)
    await prisma.scoreSnapshot.update({
      where: { id: share.snapshot.id },
      data: { expiresAt: new Date(0) },
    })
    console.log(JSON.stringify({ slug, expired: true }))
  } else {
    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { slug: workspaceSlug } })
    await prisma.workspace.delete({ where: { id: workspace.id } })
    console.log(JSON.stringify({ slug, cleaned: true }))
  }
} finally {
  await prisma.$disconnect()
}
