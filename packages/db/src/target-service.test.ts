import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { prisma } from "./client"
import { softDeleteTarget, TargetHasActiveScanError, TargetNotFoundError } from "./target-service"

/**
 * Live-Postgres coverage for target soft delete: history survives, schedules
 * are disabled, the cap count drops, the audit row lands on the chain, and an
 * active scan refuses the delete.
 */

const suffix = randomUUID().replace(/-/g, "").slice(0, 12)
const userId = `sd-user-${suffix}`
const workspaceId = `sd-ws-${suffix}`
const targetId = `sd-target-${suffix}`
const busyTargetId = `sd-busy-${suffix}`
const scanId = `sd-scan-${suffix}`
const busyScanId = `sd-busyscan-${suffix}`
const findingId = `sd-finding-${suffix}`
const verdictId = `sd-verdict-${suffix}`
const scheduleId = `sd-sched-${suffix}`

beforeAll(async () => {
  await prisma.user.create({
    data: { id: userId, name: "SoftDelete", email: `${userId}@example.invalid` },
  })
  await prisma.workspace.create({
    data: { id: workspaceId, name: "SoftDelete", slug: workspaceId },
  })
  await prisma.workspaceMember.create({
    data: { workspaceId, userId, role: "OWNER" },
  })
  await prisma.target.create({
    data: {
      id: targetId,
      workspaceId,
      type: "WEB_APP",
      name: "app.example.com",
      url: "https://app.example.com",
    },
  })
  await prisma.scan.create({
    data: {
      id: scanId,
      workspaceId,
      targetId,
      goal: "TEST_APP",
      mode: "STANDARD",
      status: "COMPLETED",
      createdById: userId,
      startedAt: new Date(),
      endedAt: new Date(),
    },
  })
  await prisma.finding.create({
    data: {
      id: findingId,
      workspaceId,
      scanId,
      targetId,
      title: "Missing header",
      summary: "X-Frame-Options absent",
      severity: "LOW",
      dedupeKey: `dedupe-${suffix}`,
    },
  })
  await prisma.gateVerdict.create({
    data: {
      id: verdictId,
      workspaceId,
      targetId,
      standardVersion: "gate-1",
      state: "NOT_READY",
      coverageStatement: {},
      nonCoverage: {},
      blockingReasons: {},
      evidenceSummary: {},
      staleness: {},
      inputChecksum: `in-${suffix}`,
      verdictChecksum: `out-${suffix}`,
    },
  })
  await prisma.schedule.create({
    data: {
      id: scheduleId,
      workspaceId,
      targetId,
      cron: "0 9 * * 1",
      goal: "TEST_APP",
      mode: "STANDARD",
      enabled: true,
      createdById: userId,
    },
  })
  // A second target with a QUEUED scan — delete must refuse.
  await prisma.target.create({
    data: {
      id: busyTargetId,
      workspaceId,
      type: "WEB_APP",
      name: "busy.example.com",
      url: "https://busy.example.com",
    },
  })
  await prisma.scan.create({
    data: {
      id: busyScanId,
      workspaceId,
      targetId: busyTargetId,
      goal: "TEST_APP",
      mode: "QUICK",
      status: "QUEUED",
      createdById: userId,
    },
  })
})

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { workspaceId } })
  await prisma.schedule.deleteMany({ where: { workspaceId } })
  await prisma.gateVerdict.deleteMany({ where: { workspaceId } })
  await prisma.finding.deleteMany({ where: { workspaceId } })
  await prisma.scan.deleteMany({ where: { workspaceId } })
  await prisma.target.deleteMany({ where: { workspaceId } })
  await prisma.workspaceMember.deleteMany({ where: { workspaceId } })
  await prisma.workspace.deleteMany({ where: { id: workspaceId } })
  await prisma.user.deleteMany({ where: { id: userId } })
})

describe("softDeleteTarget", () => {
  it("refuses while a scan is queued or running", async () => {
    await expect(softDeleteTarget(workspaceId, busyTargetId, userId)).rejects.toThrow(
      TargetHasActiveScanError
    )
    const target = await prisma.target.findFirst({ where: { id: busyTargetId } })
    expect(target?.deletedAt).toBeNull()
  })

  it("soft-deletes, disables schedules and writes a chained audit row", async () => {
    const before = await prisma.target.count({ where: { workspaceId, deletedAt: null } })

    await softDeleteTarget(workspaceId, targetId, userId)

    const after = await prisma.target.count({ where: { workspaceId, deletedAt: null } })
    expect(after).toBe(before - 1)

    // The row itself survives with deletedAt set (raw read bypasses the
    // extension's deletedAt filter).
    const rows = await prisma.$queryRaw<Array<{ deletedAt: Date | null }>>`
      SELECT "deletedAt" FROM "Target" WHERE id = ${targetId}`
    expect(rows[0]?.deletedAt).not.toBeNull()

    // History survives untouched.
    const [scan, finding, verdict] = await Promise.all([
      prisma.scan.findUnique({ where: { id: scanId } }),
      prisma.finding.findUnique({ where: { id: findingId } }),
      prisma.gateVerdict.findUnique({ where: { id: verdictId } }),
    ])
    expect(scan?.status).toBe("COMPLETED")
    expect(finding).not.toBeNull()
    expect(verdict).not.toBeNull()

    const schedule = await prisma.schedule.findFirst({ where: { id: scheduleId } })
    expect(schedule?.enabled).toBe(false)
    expect(schedule?.deletedAt).toBeNull()

    const audit = await prisma.auditLog.findFirst({
      where: {
        workspaceId,
        action: "target.deleted",
        resourceType: "target",
        resourceId: targetId,
      },
    })
    expect(audit).not.toBeNull()
    expect(audit?.actorUserId).toBe(userId)
    expect(audit?.hash?.startsWith("v2:")).toBe(true)
    const metadata = audit?.metadata as Record<string, unknown>
    expect(metadata.name).toBe("app.example.com")
    expect(metadata.url).toBe("https://app.example.com")
  })

  it("returns not-found for an already-deleted target", async () => {
    await expect(softDeleteTarget(workspaceId, targetId, userId)).rejects.toThrow(
      TargetNotFoundError
    )
  })

  it("returns not-found for a foreign or missing target", async () => {
    await expect(softDeleteTarget(workspaceId, "does-not-exist", userId)).rejects.toThrow(
      TargetNotFoundError
    )
    await expect(softDeleteTarget("other-workspace", busyTargetId, userId)).rejects.toThrow(
      TargetNotFoundError
    )
  })
})
