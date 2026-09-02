import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { randomUUID } from "node:crypto"
import { createId } from "@paralleldrive/cuid2"
import { PrismaClient, Prisma } from "./generated/prisma"
import { PrismaPg } from "@prisma/adapter-pg"
import { prisma as applicationPrisma } from "./client"
import { WORKSPACE_SCOPED_MODELS } from "./scoping"

// Change only the connection configuration: application helpers retain the real
// client, extensions, transactions and PostgreSQL policies.
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
vi.mock("../../auth/src/server", () => ({
  requirePermission: vi.fn().mockResolvedValue(undefined),
}))
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
})
let fixturesStarted = false

/**
 * Proves workspace isolation is enforced by Postgres, not merely declared.
 *
 * Unit checks prove the Prisma extension injects a workspace filter. They do not
 * execute a query, so they cannot catch a policy that was dropped,
 * mis-scoped, or reverted to allow-all — the failure mode that returns another tenant's
 * rows instead of raising an error.
 *
 * IMPORTANT: this must run as a role that cannot bypass RLS. Postgres superusers bypass
 * row-level security unconditionally, and `FORCE ROW LEVEL SECURITY` does not change that
 * — it only subjects the table *owner* to policies. Run as a superuser, every assertion
 * below silently inverts and the suite becomes false assurance, which is worse than having
 * no test. So the connection is taken from RLS_RUNTIME_DATABASE_URL (the restricted
 * NOBYPASSRLS role CI provisions), the suite skips loudly when that is absent, and it fails
 * outright if the role it did get turns out to be able to bypass.
 */
const runtimeUrl = process.env.RLS_RUNTIME_DATABASE_URL

if (!runtimeUrl) {
  console.warn(
    "[rls-fail-closed] SKIPPED: RLS_RUNTIME_DATABASE_URL is not set. These assertions are " +
      "meaningless as a superuser, so they are skipped rather than passed. Provide a " +
      "NOBYPASSRLS role connection string to exercise them."
  )
}

const suffix = randomUUID().replace(/-/g, "")
const workspaceId = `rls-fc-owner-${suffix}`
const otherWorkspaceId = `rls-fc-other-${suffix}`
let targetId = ""
let scanId = ""
let findingId = ""
const artifactDeletionTaskId = createId()
const enqueuedArtifactDeletionTaskId = createId()
let evidenceStorageUri = ""
let restricted: PrismaClient

describe.skipIf(!runtimeUrl)("strict workspace RLS fails closed", () => {
  beforeAll(async () => {
    // Same adapter construction as client.ts — Prisma 7 with the pg adapter takes the
    // connection through PrismaPg, not a datasourceUrl option.
    restricted = new PrismaClient({
      adapter: new PrismaPg({ connectionString: runtimeUrl }),
    })

    // Guard against the false-assurance case described above.
    const [role] = await restricted.$queryRaw<
      Array<{ rolname: string; rolbypassrls: boolean; rolsuper: boolean }>
    >`SELECT rolname, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user`
    if (!role || role.rolbypassrls || role.rolsuper) {
      throw new Error(
        `RLS_RUNTIME_DATABASE_URL connects as "${role?.rolname}" which can bypass RLS ` +
          `(rolbypassrls=${role?.rolbypassrls}, rolsuper=${role?.rolsuper}). ` +
          `These assertions would pass vacuously. Use a NOSUPERUSER NOBYPASSRLS role.`
      )
    }

    const [applicationRole] = await applicationPrisma.$queryRaw<
      Array<{ name: string }>
    >`SELECT current_user AS name`
    expect(applicationRole?.name).toBe(role.rolname)

    // Keep fixture setup separate from the restricted application write assertions.
    fixturesStarted = true
    await prisma.workspace.create({
      data: { id: workspaceId, name: "RLS fail-closed owner", slug: workspaceId },
    })
    await prisma.workspace.create({
      data: { id: otherWorkspaceId, name: "RLS fail-closed other", slug: otherWorkspaceId },
    })
    const target = await prisma.target.create({
      data: {
        workspaceId,
        type: "REPO",
        name: "RLS fail-closed target",
        repoFullName: `rls-fail-closed-${suffix}`,
      },
    })
    targetId = target.id
    const scan = await prisma.scan.create({
      data: {
        workspaceId,
        targetId,
        goal: "LAUNCH_REVIEW",
        status: "COMPLETED",
        createdById: `rls-fc-evidence-user-${suffix}`,
      },
    })
    scanId = scan.id
    const finding = await prisma.finding.create({
      data: {
        workspaceId,
        targetId,
        scanId: scan.id,
        title: "RLS fail-closed evidence",
        summary: "Fixture for the account-deletion outbox enqueue boundary.",
        severity: "LOW",
        dedupeKey: `rls-fc-evidence-${suffix}`,
      },
    })
    findingId = finding.id
    evidenceStorageUri = `s3://evidence/evidence/${workspaceId}/${createId()}.enc`
    await prisma.evidence.create({
      data: {
        findingId: finding.id,
        type: "receipt",
        storageUri: evidenceStorageUri,
      },
    })
    await prisma.artifactDeletionTask.create({
      data: {
        id: artifactDeletionTaskId,
        workspaceId,
        kind: "EVIDENCE",
        storageUri: `s3://test/evidence/${workspaceId}/fixture.enc`,
      },
    })
  })

  afterAll(async () => {
    if (!fixturesStarted) {
      await restricted?.$disconnect()
      await applicationPrisma.$disconnect()
      await prisma.$disconnect()
      return
    }
    await prisma.artifactDeletionTask.deleteMany({
      where: { id: { in: [artifactDeletionTaskId, enqueuedArtifactDeletionTaskId] } },
    })
    if (targetId) {
      await prisma.$executeRaw`DELETE FROM "Target" WHERE id = ${targetId}`
    }
    await prisma.$executeRaw`DELETE FROM "Workspace" WHERE id IN (${workspaceId}, ${otherWorkspaceId})`
    await restricted?.$disconnect()
    await applicationPrisma.$disconnect()
    await prisma.$disconnect()
  })

  /**
   * Runs a raw statement as the restricted role with the workspace GUC set transaction-
   * locally, exactly as withWorkspaceRLS does. Raw SQL deliberately bypasses the Prisma
   * extension's workspace filter so what is measured is the database policy alone.
   */
  async function asWorkspace<T>(
    id: string | null,
    fn: (tx: Omit<PrismaClient, "$transaction" | "$connect" | "$disconnect">) => Promise<T>
  ): Promise<T> {
    return restricted.$transaction(async (tx) => {
      if (id) {
        await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${id}, true)`
      } else {
        await tx.$executeRaw`SELECT set_config('app.current_workspace_id', '', true)`
      }
      return fn(tx)
    })
  }

  const countThisTarget = async (
    tx: Omit<PrismaClient, "$transaction" | "$connect" | "$disconnect">
  ) => {
    const rows = await tx.$queryRaw<
      Array<{ count: bigint }>
    >`SELECT count(*)::bigint AS count FROM "Target" WHERE id = ${targetId}`
    return Number(rows[0]?.count ?? 0)
  }

  it("accounts for every live public RLS table and verifies enforcement flags", async () => {
    const children = [
      "ScanEvent",
      "Evidence",
      "ScanResultManifest",
      "ScanCoverageReceipt",
      "FixProposal",
      "PullRequest",
      "Ticket",
      "ScorecardShare",
      "ScorecardEvent",
      "AiSystemProfileVersion",
      "ThreatModelVersion",
      "ControlEvidenceVersion",
    ]
    const explicit = {
      License: "Nullable workspace for system-issued, not-yet-linked licenses",
      LicenseKey: "Nullable workspace; privileged key lookup before workspace linkage",
      LicenseActivation: "Nullable workspace; privileged machine activation",
      LicenseRevocation: "Inherits workspace through License",
      SyncCursor: "Explicit workspace transactions in sync routes",
    }
    const systemOnly = {
      ArtifactDeletionTask: "Owner-only durable deletion outbox survives workspace deletion",
      PlatformAdminAudit: "Owner-only cross-workspace operator audit",
      PlatformAdminElevation: "Owner-only cross-workspace action elevation",
      PlatformAdminChallengeLimit: "Owner-only operator challenge rate limit",
    }
    const rows = await restricted.$queryRaw<
      Array<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>
    >`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')`
    const tenantTables = [...WORKSPACE_SCOPED_MODELS, ...children, ...Object.keys(explicit)]
    expect(
      rows
        .filter((row) => row.relrowsecurity)
        .map((row) => row.relname)
        .sort()
    ).toEqual([...tenantTables, ...Object.keys(systemOnly)].sort())
    for (const table of tenantTables) {
      expect(
        rows.find((row) => row.relname === table),
        table
      ).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true })
    }
    for (const table of Object.keys(systemOnly)) {
      expect(
        rows.find((row) => row.relname === table),
        table
      ).toMatchObject({ relrowsecurity: true, relforcerowsecurity: false })
    }
  })

  it("executes dashboard, readiness route and fix listing against the restricted application client", async () => {
    const { withWorkspaceRLS } = await import("./rls")
    const { listFixProposals } = await import("./fix-proposal-service")
    const { getDashboardOverview } = await import("../../../apps/web/src/lib/dashboard-overview")
    const { GET } = await import("../../../apps/web/src/app/api/launch-readiness/route")
    const { receipt, proposal } = await withWorkspaceRLS(workspaceId, async (tx) => ({
      receipt: await tx.scanCoverageReceipt.create({
        data: { scanId, scanner: "runtime-app", controlId: `app-${suffix}`, status: "COMPLETED" },
      }),
      proposal: await tx.fixProposal.create({
        data: { findingId, kind: "patch", summary: "Runtime application regression" },
      }),
    }))
    try {
      expect((await getDashboardOverview(workspaceId)).targets).toMatchObject({
        total: 1,
        assessed: 1,
        unassessed: 0,
      })
      expect((await getDashboardOverview(otherWorkspaceId)).targets.total).toBe(0)
      expect((await listFixProposals({ workspaceId })).items.map((item) => item.id)).toContain(
        proposal.id
      )
      expect((await listFixProposals({ workspaceId: otherWorkspaceId })).items).toEqual([])
      const own = await GET(
        new Request(`http://localhost/api/launch-readiness?workspaceId=${workspaceId}`)
      )
      expect(own.status).toBe(200)
      expect((await own.json()).data.verdict).not.toMatch(/INCONCLUSIVE|NOT_EVALUATED/)
      const foreign = await GET(
        new Request(
          `http://localhost/api/launch-readiness?workspaceId=${otherWorkspaceId}&targetId=${targetId}`
        )
      )
      expect(foreign.status).toBe(200)
      expect((await foreign.json()).data.verdict).toBe("NOT_EVALUATED")
      // A missing transaction wrapper must still fail closed for child rows.
      expect(await applicationPrisma.scanCoverageReceipt.count({ where: { id: receipt.id } })).toBe(
        0
      )
      expect(await applicationPrisma.fixProposal.count({ where: { id: proposal.id } })).toBe(0)
    } finally {
      await prisma.fixProposal.delete({ where: { id: proposal.id } })
      await prisma.scanCoverageReceipt.delete({ where: { id: receipt.id } })
    }
  })

  it("writes every child and license table as runtime, denying foreign and absent contexts", async () => {
    const { withWorkspaceRLS } = await import("./rls")
    const parents = await withWorkspaceRLS(workspaceId, async (tx) => ({
      snapshot: await tx.scoreSnapshot.create({
        data: {
          workspaceId,
          targetId,
          scanId,
          modelVersion: "rls",
          score: 50,
          grade: "C",
          breakdown: {},
          scanMode: "STANDARD",
          expiresAt: new Date("9999-01-01"),
        },
      }),
      profile: await tx.aiSystemProfile.create({
        data: { workspaceId, targetId, profile: {}, createdById: suffix, updatedById: suffix },
      }),
      threat: await tx.threatModel.create({ data: { workspaceId, targetId } }),
      control: await tx.controlEvidence.create({
        data: { workspaceId, targetId, controlId: `matrix-${suffix}` },
      }),
    }))
    const proposalId = createId(),
      shareId = createId(),
      licenseId = createId()
    const cases: Array<{
      table: string
      create: (tx: Prisma.TransactionClient) => Promise<{ id: string }>
    }> = [
      {
        table: "ScanEvent",
        create: (tx) =>
          tx.scanEvent.create({ data: { scanId, stage: "completed", message: "runtime matrix" } }),
      },
      {
        table: "Evidence",
        create: (tx) =>
          tx.evidence.create({
            data: { findingId, type: "receipt", storageUri: evidenceStorageUri },
          }),
      },
      {
        table: "ScanResultManifest",
        create: (tx) =>
          tx.scanResultManifest.create({ data: { scanId, manifest: {}, checksum: suffix } }),
      },
      {
        table: "ScanCoverageReceipt",
        create: (tx) =>
          tx.scanCoverageReceipt.create({
            data: { scanId, scanner: "matrix", controlId: `matrix-${suffix}`, status: "COMPLETED" },
          }),
      },
      {
        table: "FixProposal",
        create: (tx) =>
          tx.fixProposal.create({
            data: { id: proposalId, findingId, kind: "patch", summary: "runtime matrix" },
          }),
      },
      {
        table: "PullRequest",
        create: (tx) =>
          tx.pullRequest.create({
            data: {
              fixProposalId: proposalId,
              provider: "github",
              repoOwner: "fixture",
              repoName: "fixture",
              branchName: "fixture",
            },
          }),
      },
      {
        table: "Ticket",
        create: (tx) => tx.ticket.create({ data: { findingId, provider: "fixture" } }),
      },
      {
        table: "ScorecardShare",
        create: (tx) =>
          tx.scorecardShare.create({
            data: {
              id: shareId,
              snapshotId: parents.snapshot.id,
              slug: suffix,
              publicPayload: {},
              createdById: suffix,
            },
          }),
      },
      {
        table: "ScorecardEvent",
        create: (tx) =>
          tx.scorecardEvent.create({
            data: { shareId, eventType: "view", visitorHash: suffix, dayBucket: new Date() },
          }),
      },
      {
        table: "AiSystemProfileVersion",
        create: (tx) =>
          tx.aiSystemProfileVersion.create({
            data: {
              aiSystemProfileId: parents.profile.id,
              version: 1,
              profile: {},
              checksum: suffix,
              createdById: suffix,
            },
          }),
      },
      {
        table: "ThreatModelVersion",
        create: (tx) =>
          tx.threatModelVersion.create({
            data: {
              threatModelId: parents.threat.id,
              version: 1,
              content: {},
              checksum: suffix,
              createdById: suffix,
            },
          }),
      },
      {
        table: "ControlEvidenceVersion",
        create: (tx) =>
          tx.controlEvidenceVersion.create({
            data: {
              controlEvidenceId: parents.control.id,
              version: 1,
              status: "SUBMITTED",
              attestation: "fixture",
              artifactManifest: [],
              checksum: suffix,
              createdById: suffix,
            },
          }),
      },
      {
        table: "License",
        create: (tx) =>
          tx.license.create({
            data: {
              id: licenseId,
              workspaceId,
              ownerEmail: "fixture@example.com",
              sku: "individual_launch",
              seatCount: 1,
              updateEligibleUntil: new Date("9999-01-01"),
              signingKeyId: "fixture",
              signature: "fixture",
              issuedAt: new Date(),
            },
          }),
      },
      {
        table: "LicenseKey",
        create: (tx) =>
          tx.licenseKey.create({
            data: { licenseId, workspaceId, keyHash: suffix, issuedByProvider: suffix },
          }),
      },
      {
        table: "LicenseActivation",
        create: (tx) =>
          tx.licenseActivation.create({
            data: { licenseId, workspaceId, machineId: suffix, lastSeenAt: new Date() },
          }),
      },
      {
        table: "LicenseRevocation",
        create: (tx) =>
          tx.licenseRevocation.create({
            data: { licenseId, revokedAt: new Date(), reason: "fixture", revokedByKeyId: suffix },
          }),
      },
      {
        table: "GateVerdict",
        create: (tx) =>
          tx.gateVerdict.create({
            data: {
              workspaceId,
              targetId,
              scanId,
              standardVersion: "matrix",
              state: "INSUFFICIENT_EVIDENCE",
              coverageStatement: {},
              nonCoverage: {},
              blockingReasons: [],
              evidenceSummary: {},
              staleness: {},
              inputChecksum: suffix,
              verdictChecksum: suffix,
            },
          }),
      },
    ]
    const created: Array<{ table: string; id: string }> = []
    try {
      for (const entry of cases) {
        const row = await withWorkspaceRLS(workspaceId, entry.create)
        created.push({ table: entry.table, id: row.id })
        // Identifiers come only from the fixed table list above; values stay parameterized.
        const table = Prisma.raw(`"${entry.table}"`)
        for (const context of [workspaceId, otherWorkspaceId, null]) {
          const visible = await asWorkspace(context, (tx) =>
            tx.$queryRaw<Array<{ id: string }>>(
              Prisma.sql`SELECT id FROM ${table} WHERE id = ${row.id}`
            )
          )
          expect(visible.length, `${entry.table}: ${context}`).toBe(context === workspaceId ? 1 : 0)
          if (context !== workspaceId) {
            expect(
              await asWorkspace(context, (tx) =>
                tx.$executeRaw(Prisma.sql`DELETE FROM ${table} WHERE id = ${row.id}`)
              ),
              entry.table
            ).toBe(0)
            await expect(
              asWorkspace(context, entry.create),
              `${entry.table}: denied insert`
            ).rejects.toThrow(/row-level security/i)
          }
        }
      }
    } finally {
      for (const row of created.reverse()) {
        await prisma.$executeRaw(
          Prisma.sql`DELETE FROM ${Prisma.raw(`"${row.table}"`)} WHERE id = ${row.id}`
        )
      }
      await prisma.scoreSnapshot.delete({ where: { id: parents.snapshot.id } })
      await prisma.aiSystemProfile.delete({ where: { id: parents.profile.id } })
      await prisma.threatModel.delete({ where: { id: parents.threat.id } })
      await prisma.controlEvidence.delete({ where: { id: parents.control.id } })
    }
  })

  it("reads runtime coverage for a target outside the dashboard's 200-run window", async () => {
    const { withWorkspaceRLS } = await import("./rls")
    const { getDashboardOverview } = await import("../../../apps/web/src/lib/dashboard-overview")
    const oldTarget = await prisma.target.create({
      data: { workspaceId, type: "REPO", name: "Old assessed target" },
    })
    const recentIds = Array.from({ length: 200 }, () => createId())
    try {
      const oldScan = await prisma.scan.create({
        data: {
          workspaceId,
          targetId: oldTarget.id,
          goal: "LAUNCH_REVIEW",
          status: "COMPLETED",
          createdById: suffix,
          createdAt: new Date("2020-01-01"),
        },
      })
      await withWorkspaceRLS(workspaceId, (tx) =>
        tx.scanCoverageReceipt.create({
          data: { scanId: oldScan.id, scanner: "old", controlId: "old", status: "COMPLETED" },
        })
      )
      await prisma.scan.createMany({
        data: recentIds.map((id) => ({
          id,
          workspaceId,
          targetId,
          goal: "LAUNCH_REVIEW",
          status: "COMPLETED",
          createdById: suffix,
          createdAt: new Date("2030-01-01"),
        })),
      })
      const overview = await getDashboardOverview(workspaceId)
      expect(overview.targets).toMatchObject({ total: 2, assessed: 1, unassessed: 1 })
      expect((await getDashboardOverview(otherWorkspaceId)).targets.total).toBe(0)
    } finally {
      await prisma.scan.deleteMany({ where: { id: { in: recentIds } } })
      await prisma.target.delete({ where: { id: oldTarget.id } })
    }
  })

  it("allows owning-workspace coverage and fix-proposal writes", async () => {
    const { withWorkspaceRLS } = await import("./rls")
    const { receipt, proposal } = await withWorkspaceRLS(workspaceId, async (tx) => {
      const receipt = await tx.scanCoverageReceipt.create({
        data: {
          scanId,
          scanner: "rls-fail-closed",
          controlId: `rls-fc-coverage-${suffix}`,
          status: "COMPLETED",
        },
      })
      const proposal = await tx.fixProposal.create({
        data: {
          findingId,
          kind: "patch",
          summary: "RLS fail-closed proposal write probe",
        },
      })
      return { receipt, proposal }
    })

    try {
      const counts = await asWorkspace(workspaceId, async (tx) => {
        const [coverage, fixes] = await Promise.all([
          tx.$queryRaw<Array<{ count: bigint }>>`
            SELECT count(*)::bigint AS count FROM "ScanCoverageReceipt" WHERE id = ${receipt.id}
          `,
          tx.$queryRaw<Array<{ count: bigint }>>`
            SELECT count(*)::bigint AS count FROM "FixProposal" WHERE id = ${proposal.id}
          `,
        ])
        return [Number(coverage[0]?.count ?? 0), Number(fixes[0]?.count ?? 0)]
      })
      expect(counts).toEqual([1, 1])

      const foreignCounts = await asWorkspace(otherWorkspaceId, async (tx) => {
        const [coverage, fixes] = await Promise.all([
          tx.$queryRaw<Array<{ count: bigint }>>`
            SELECT count(*)::bigint AS count FROM "ScanCoverageReceipt" WHERE id = ${receipt.id}
          `,
          tx.$queryRaw<Array<{ count: bigint }>>`
            SELECT count(*)::bigint AS count FROM "FixProposal" WHERE id = ${proposal.id}
          `,
        ])
        return [Number(coverage[0]?.count ?? 0), Number(fixes[0]?.count ?? 0)]
      })
      expect(foreignCounts).toEqual([0, 0])
    } finally {
      await prisma.fixProposal.delete({ where: { id: proposal.id } })
      await prisma.scanCoverageReceipt.delete({ where: { id: receipt.id } })
    }
  })

  it("fails closed and writes GateVerdict only with its workspace context", async () => {
    const { withWorkspaceRLS } = await import("./rls")
    const verdict = await withWorkspaceRLS(workspaceId, (tx) =>
      tx.gateVerdict.create({
        data: {
          workspaceId,
          targetId,
          scanId,
          standardVersion: "rls-fail-closed/1",
          state: "INSUFFICIENT_EVIDENCE",
          coverageStatement: {},
          nonCoverage: {},
          blockingReasons: [],
          evidenceSummary: {},
          staleness: {},
          inputChecksum: `input-${suffix}`,
          verdictChecksum: `verdict-${suffix}`,
        },
      })
    )

    try {
      const count = async (id: string | null) =>
        asWorkspace(id, async (tx) => {
          const rows = await tx.$queryRaw<Array<{ count: bigint }>>`
            SELECT count(*)::bigint AS count FROM "GateVerdict" WHERE id = ${verdict.id}
          `
          return Number(rows[0]?.count ?? 0)
        })
      expect(await count(workspaceId)).toBe(1)
      expect(await count(null)).toBe(0)
      expect(await count(otherWorkspaceId)).toBe(0)
    } finally {
      await prisma.gateVerdict.delete({ where: { id: verdict.id } })
    }
  })

  it("returns the row to its owning workspace", async () => {
    expect(await asWorkspace(workspaceId, countThisTarget)).toBe(1)
  })

  it("returns nothing when the workspace context is absent", async () => {
    // The dangerous regression is this returning 1: a query path that forgot the wrapper
    // would then read across every tenant instead of failing.
    expect(await asWorkspace(null, countThisTarget)).toBe(0)
  })

  it("returns nothing to a different workspace", async () => {
    expect(await asWorkspace(otherWorkspaceId, countThisTarget)).toBe(0)
  })

  it("hides the row from an unscoped aggregate over the whole table", async () => {
    const total = await asWorkspace(null, async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{ count: bigint }>
      >`SELECT count(*)::bigint AS count FROM "Target"`
      return Number(rows[0]?.count ?? 0)
    })
    expect(total).toBe(0)
  })

  it("refuses to write into a workspace other than the active one", async () => {
    const affected = await asWorkspace(
      otherWorkspaceId,
      (tx) => tx.$executeRaw`UPDATE "Target" SET name = 'hijacked' WHERE id = ${targetId}`
    )
    expect(affected).toBe(0)

    const name = await asWorkspace(workspaceId, async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{ name: string }>
      >`SELECT name FROM "Target" WHERE id = ${targetId}`
      return rows[0]?.name
    })
    expect(name).toBe("RLS fail-closed target")
  })

  it("hides the post-workspace artifact deletion outbox from the runtime role", async () => {
    for (const context of [null, workspaceId, otherWorkspaceId]) {
      let visibleRows = 0
      try {
        visibleRows = await asWorkspace(context, async (tx) => {
          const rows = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT id FROM "ArtifactDeletionTask" WHERE id = ${artifactDeletionTaskId}`
          return rows.length
        })
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("permission denied")) throw error
      }
      expect(visibleRows).toBe(0)
    }
  })

  it("refuses direct artifact deletion task inserts from the runtime role", async () => {
    await expect(
      asWorkspace(
        workspaceId,
        (tx) =>
          tx.$executeRaw`
          INSERT INTO "ArtifactDeletionTask" (
            id, "workspaceId", kind, "storageUri", "updatedAt"
          ) VALUES (
            ${`forbidden-${suffix}`}, ${workspaceId}, 'EVIDENCE',
            ${`s3://test/evidence/${workspaceId}/forbidden.enc`}, NOW()
          )`
      )
    ).rejects.toThrow()
  })

  it("allows only the current workspace to enqueue one of its retained Evidence URIs", async () => {
    const returnedId = await asWorkspace(workspaceId, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT app.enqueue_artifact_deletion_task(
          ${enqueuedArtifactDeletionTaskId}, ${workspaceId}, ${evidenceStorageUri}
        ) AS id`
      return rows[0]?.id
    })
    expect(returnedId).toBe(enqueuedArtifactDeletionTaskId)

    await expect(
      asWorkspace(
        otherWorkspaceId,
        (tx) => tx.$queryRaw`
        SELECT app.enqueue_artifact_deletion_task(
          ${createId()}, ${workspaceId}, ${evidenceStorageUri}
        ) AS id`
      )
    ).rejects.toThrow()

    const task = await prisma.artifactDeletionTask.findUnique({
      where: { id: enqueuedArtifactDeletionTaskId },
    })
    expect(task).toMatchObject({ workspaceId, storageUri: evidenceStorageUri, kind: "EVIDENCE" })
  })

  it("keeps AI security score snapshots inside the owning workspace", async () => {
    const scan = await prisma.scan.create({
      data: {
        workspaceId,
        targetId,
        goal: "LAUNCH_REVIEW",
        status: "COMPLETED",
        createdById: `rls-fc-score-user-${suffix}`,
      },
    })
    const snapshot = await prisma.aiSecurityScoreSnapshot.create({
      data: {
        workspaceId,
        targetId,
        scanId: scan.id,
        modelVersion: "ai-app-security-score/1.0.0",
        score: 100,
        breakdown: {},
        evidenceQuality: {},
        methodology: "ai-app-security-score/1.0.0",
        assessedCount: 8,
        totalControls: 8,
        expiresAt: new Date("9999-12-31T23:59:59.999Z"),
      },
    })

    const countSnapshot = async (
      tx: Omit<PrismaClient, "$transaction" | "$connect" | "$disconnect">
    ) => {
      const rows = await tx.$queryRaw<
        Array<{ count: bigint }>
      >`SELECT count(*)::bigint AS count FROM "AiSecurityScoreSnapshot" WHERE id = ${snapshot.id}`
      return Number(rows[0]?.count ?? 0)
    }

    try {
      expect(await asWorkspace(workspaceId, countSnapshot)).toBe(1)
      expect(await asWorkspace(null, countSnapshot)).toBe(0)
      expect(await asWorkspace(otherWorkspaceId, countSnapshot)).toBe(0)
    } finally {
      await prisma.aiSecurityScoreSnapshot.delete({ where: { id: snapshot.id } })
      await prisma.scan.delete({ where: { id: scan.id } })
    }
  })

  /**
   * `Target` carries workspaceId directly. The nine DB-07 child tables do not —
   * they are scoped through an EXISTS join to a parent, which is a structurally
   * different policy shape, and none of them was covered by any executing test.
   *
   * That gap let a real bug ship: migration 20260803000001 ran
   * `FORCE ROW LEVEL SECURITY` on all nine but never `ENABLE`, and FORCE without
   * ENABLE is a no-op — the policies existed and were never consulted. The only
   * test added alongside it asserted `Set` membership, which passes whether or
   * not Postgres enforces anything. These two cases close that gap: one checks
   * the catalog flags directly, one exercises the join policy for real.
   */
  /**
   * Child-table RLS was re-enabled in migration 20260807000003 after the
   * root cause was identified and fixed:
   *
   *   1. account-deletion.ts wrote to ScorecardShare outside withWorkspaceRLS
   *      — moved into the per-workspace RLS context loop.
   *   2. The CI reproduction job (rls-child-write-repro) confirmed all write
   *      paths correctly use withWorkspaceRLS.
   *
   * These tests are the tripwire that proves the policies are live.
   */
  describe("child tables scoped through a parent (DB-07)", () => {
    const CHILD_TABLES = [
      "ScanEvent",
      "Evidence",
      "ScanResultManifest",
      "ScanCoverageReceipt",
      "FixProposal",
      "PullRequest",
      "Ticket",
      "ScorecardShare",
      "ScorecardEvent",
      "AiSystemProfileVersion",
      "ThreatModelVersion",
      "ControlEvidenceVersion",
    ]

    it("has RLS both ENABLED and FORCED on every child table", async () => {
      const rows = await prisma.$queryRaw<
        Array<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>
      >`SELECT relname, relrowsecurity, relforcerowsecurity
          FROM pg_class
         WHERE relname = ANY(${CHILD_TABLES})`

      expect(rows.length).toBe(CHILD_TABLES.length)

      // relrowsecurity is the one that actually matters: false means every
      // policy on the table is inert, no matter how correct the policy SQL is.
      const notEnabled = rows.filter((r) => !r.relrowsecurity).map((r) => r.relname)
      expect(notEnabled).toEqual([])

      const notForced = rows.filter((r) => !r.relforcerowsecurity).map((r) => r.relname)
      expect(notForced).toEqual([])
    })

    it("fails closed on an EXISTS-join policy, not just a direct-column one", async () => {
      // Seed a Scan (owner workspace) and a ScanEvent hanging off it. ScanEvent
      // has no workspaceId of its own — isolation depends entirely on the join.
      const scan = await prisma.scan.create({
        data: {
          workspaceId,
          targetId,
          goal: "LAUNCH_REVIEW",
          status: "COMPLETED",
          createdById: `rls-fc-user-${suffix}`,
        },
      })
      const event = await prisma.scanEvent.create({
        data: { scanId: scan.id, stage: "completed", message: "rls fail-closed probe" },
      })

      const countThisEvent = async (
        tx: Omit<PrismaClient, "$transaction" | "$connect" | "$disconnect">
      ) => {
        const rows = await tx.$queryRaw<
          Array<{ count: bigint }>
        >`SELECT count(*)::bigint AS count FROM "ScanEvent" WHERE id = ${event.id}`
        return Number(rows[0]?.count ?? 0)
      }

      try {
        expect(await asWorkspace(workspaceId, countThisEvent)).toBe(1)
        // Both of these returning 1 is the cross-tenant leak DB-07 exists to stop.
        expect(await asWorkspace(null, countThisEvent)).toBe(0)
        expect(await asWorkspace(otherWorkspaceId, countThisEvent)).toBe(0)

        const affected = await asWorkspace(
          otherWorkspaceId,
          (tx) => tx.$executeRaw`DELETE FROM "ScanEvent" WHERE id = ${event.id}`
        )
        expect(affected).toBe(0)
      } finally {
        await prisma.$executeRaw`DELETE FROM "ScanEvent" WHERE id = ${event.id}`
        await prisma.$executeRaw`DELETE FROM "Scan" WHERE id = ${scan.id}`
      }
    })

    /**
     * WRITE-PATH TEST — the missing case that let the 42501 reach production.
     *
     * The read-only tests above assert cross-workspace reads return 0. But a
     * policy that always evaluates false (e.g., because the GUC is not visible
     * to the policy check, or the EXISTS join fails) also returns 0 rows — so
     * read-only assertions cannot distinguish "correctly fails closed" from
     * "completely broken." This test writes a ScanEvent through the SAME
     * `withWorkspaceRLS` path that `addScanEvent` uses, as the OWNING workspace.
     * If the policy is correct, the write succeeds. If the policy is broken
     * (as it was in production), the write throws Prisma error code 42501.
     *
     * This is the tripwire for re-enable: un-skip this test alongside the
     * re-enable migration. If it fails with 42501, the root cause has not been
     * fixed yet.
     */
    it("succeeds writing a ScanEvent as the owning workspace through withWorkspaceRLS", async () => {
      const scan = await prisma.scan.create({
        data: {
          workspaceId,
          targetId,
          goal: "LAUNCH_REVIEW",
          status: "COMPLETED",
          createdById: `rls-fc-user-${suffix}`,
        },
      })

      try {
        // This mirrors addScanEvent exactly: set the GUC inside a transaction
        // via withWorkspaceRLS, then insert a ScanEvent scoped through the
        // scan's workspaceId via the EXISTS-join policy.
        const { withWorkspaceRLS } = await import("./rls")
        const event = await withWorkspaceRLS(workspaceId, async (tx) => {
          // Verify scan ownership (defense-in-depth, same as addScanEvent).
          const owned = await tx.scan.findUnique({
            where: { id: scan.id },
            select: { workspaceId: true },
          })
          expect(owned?.workspaceId).toBe(workspaceId)

          // The actual write — this is where 42501 manifested in production.
          return tx.scanEvent.create({
            data: {
              scanId: scan.id,
              stage: "completed",
              level: "info",
              message: "rls write-path probe",
            },
          })
        })

        expect(event.id).toBeDefined()
        expect(event.scanId).toBe(scan.id)

        // Verify the event is visible to the owning workspace.
        const count = await asWorkspace(workspaceId, async (tx) => {
          const rows = await tx.$queryRaw<
            Array<{ count: bigint }>
          >`SELECT count(*)::bigint AS count FROM "ScanEvent" WHERE id = ${event.id}`
          return Number(rows[0]?.count ?? 0)
        })
        expect(count).toBe(1)

        // And invisible to a different workspace.
        const otherCount = await asWorkspace(otherWorkspaceId, async (tx) => {
          const rows = await tx.$queryRaw<
            Array<{ count: bigint }>
          >`SELECT count(*)::bigint AS count FROM "ScanEvent" WHERE id = ${event.id}`
          return Number(rows[0]?.count ?? 0)
        })
        expect(otherCount).toBe(0)

        await prisma.$executeRaw`DELETE FROM "ScanEvent" WHERE id = ${event.id}`
      } finally {
        await prisma.$executeRaw`DELETE FROM "Scan" WHERE id = ${scan.id}`
      }
    })

    it("succeeds writing a ControlEvidenceVersion as the owning workspace through withWorkspaceRLS", async () => {
      const { withWorkspaceRLS } = await import("./rls")

      let evidenceId = ""

      try {
        // The root ControlEvidence row is workspace-scoped directly.
        const evidence = await withWorkspaceRLS(workspaceId, async (tx) => {
          return tx.controlEvidence.create({
            data: {
              workspaceId,
              targetId,
              controlId: "vibe-34",
            },
          })
        })
        evidenceId = evidence.id

        // The child version is scoped through the parent via an EXISTS-join policy.
        const version = await withWorkspaceRLS(workspaceId, async (tx) => {
          return tx.controlEvidenceVersion.create({
            data: {
              controlEvidenceId: evidence.id,
              version: 1,
              status: "SUBMITTED",
              attestation: "rls fail-closed probe",
              artifactManifest: [],
              checksum: "sha256-rls-probe",
              createdById: `rls-fc-user-${suffix}`,
            },
          })
        })

        expect(version.id).toBeDefined()
        expect(version.controlEvidenceId).toBe(evidence.id)

        const count = async (
          tx: Omit<PrismaClient, "$transaction" | "$connect" | "$disconnect">
        ) => {
          const rows = await tx.$queryRaw<
            Array<{ count: bigint }>
          >`SELECT count(*)::bigint AS count FROM "ControlEvidenceVersion" WHERE id = ${version.id}`
          return Number(rows[0]?.count ?? 0)
        }

        expect(await asWorkspace(workspaceId, count)).toBe(1)
        expect(await asWorkspace(null, count)).toBe(0)
        expect(await asWorkspace(otherWorkspaceId, count)).toBe(0)

        await prisma.$executeRaw`DELETE FROM "ControlEvidenceVersion" WHERE id = ${version.id}`
      } finally {
        if (evidenceId) {
          await prisma.$executeRaw`DELETE FROM "ControlEvidence" WHERE id = ${evidenceId}`
        }
      }
    })

    it("keeps AI system profile versions inside the owning workspace", async () => {
      const { withWorkspaceRLS } = await import("./rls")
      let profileId = ""

      try {
        const profile = await withWorkspaceRLS(workspaceId, (tx) =>
          tx.aiSystemProfile.create({
            data: {
              workspaceId,
              targetId,
              profile: { systemName: "RLS profile probe" },
              createdById: `rls-fc-user-${suffix}`,
              updatedById: `rls-fc-user-${suffix}`,
            },
          })
        )
        profileId = profile.id
        const version = await withWorkspaceRLS(workspaceId, (tx) =>
          tx.aiSystemProfileVersion.create({
            data: {
              aiSystemProfileId: profile.id,
              version: 1,
              profile: { systemName: "RLS profile probe" },
              checksum: "sha256-rls-probe",
              createdById: `rls-fc-user-${suffix}`,
            },
          })
        )

        const count = async (
          tx: Omit<PrismaClient, "$transaction" | "$connect" | "$disconnect">
        ) => {
          const rows = await tx.$queryRaw<Array<{ count: bigint }>>`
            SELECT count(*)::bigint AS count FROM "AiSystemProfileVersion" WHERE id = ${version.id}
          `
          return Number(rows[0]?.count ?? 0)
        }

        expect(await asWorkspace(workspaceId, count)).toBe(1)
        expect(await asWorkspace(null, count)).toBe(0)
        expect(await asWorkspace(otherWorkspaceId, count)).toBe(0)
      } finally {
        if (profileId) {
          await prisma.$executeRaw`DELETE FROM "AiSystemProfile" WHERE id = ${profileId}`
        }
      }
    })
  })

  describe("License NULL-workspaceId (B-L08 + issue path)", () => {
    const licenseId = `rls-lic-${suffix}`
    const keyHash = `rls-keyhash-${suffix}`

    afterAll(async () => {
      if (!fixturesStarted) return
      await prisma.$executeRaw`DELETE FROM "LicenseKey" WHERE "licenseId" = ${licenseId}`
      await prisma.$executeRaw`DELETE FROM "License" WHERE id = ${licenseId}`
    })

    it("lets the privileged client insert a NULL-workspaceId license and key", async () => {
      // Privileged owner (prisma) bypasses RLS — this is how getSystemPrisma()
      // issues a direct Polar purchase that is not yet linked to a workspace.
      await prisma.$executeRaw`
        INSERT INTO "License" (
          id, "workspaceId", "ownerEmail", sku, "seatCount", "machineIds",
          "updateEligibleUntil", "signingKeyId", signature, "issuedAt",
          revoked, "createdAt", "updatedAt"
        ) VALUES (
          ${licenseId}, NULL, ${`rls-${suffix}@example.com`}, 'individual_launch', 1,
          ARRAY[]::TEXT[], NOW() + interval '365 days', 'test', 'pending', NOW(),
          false, NOW(), NOW()
        )
      `
      await prisma.$executeRaw`
        INSERT INTO "LicenseKey" (
          id, "licenseId", "workspaceId", "keyHash", "issuedByProvider", "createdAt"
        ) VALUES (
          ${`rls-lk-${suffix}`}, ${licenseId}, NULL, ${keyHash},
          ${`polar:rls-${suffix}`}, NOW()
        )
      `
    })

    it("hides the NULL-workspaceId license from a NOBYPASSRLS role with no context", async () => {
      const count = await asWorkspace(null, async (tx) => {
        const rows = await tx.$queryRaw<Array<{ count: bigint }>>`
          SELECT count(*)::bigint AS count FROM "License" WHERE id = ${licenseId}
        `
        return Number(rows[0]?.count ?? 0)
      })
      expect(count).toBe(0)
    })

    it("hides the NULL-workspaceId license from a different workspace context", async () => {
      const count = await asWorkspace(otherWorkspaceId, async (tx) => {
        const rows = await tx.$queryRaw<Array<{ count: bigint }>>`
          SELECT count(*)::bigint AS count FROM "License" WHERE id = ${licenseId}
        `
        return Number(rows[0]?.count ?? 0)
      })
      expect(count).toBe(0)
    })

    it("hides the NULL-workspaceId LicenseKey from a NOBYPASSRLS key-hash lookup", async () => {
      // This is the issue-route bug: prisma.licenseKey.findFirst under
      // NOBYPASSRLS cannot see a freshly issued NULL-workspaceId key, so
      // webhook retries would mint a duplicate. The fix is getSystemPrisma().
      const count = await asWorkspace(null, async (tx) => {
        const rows = await tx.$queryRaw<Array<{ count: bigint }>>`
          SELECT count(*)::bigint AS count FROM "LicenseKey" WHERE "keyHash" = ${keyHash}
        `
        return Number(rows[0]?.count ?? 0)
      })
      expect(count).toBe(0)
    })

    it("lets the privileged client read the NULL-workspaceId key back by hash", async () => {
      const rows = await prisma.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "LicenseKey" WHERE "keyHash" = ${keyHash}
      `
      expect(rows).toHaveLength(1)
    })

    it("preserves system activation and revocation of unlinked licenses without exposing them to runtime", async () => {
      const activation = await prisma.licenseActivation.create({
        data: { licenseId, machineId: suffix, lastSeenAt: new Date() },
      })
      const revocation = await prisma.licenseRevocation.create({
        data: {
          licenseId,
          revokedAt: new Date(),
          reason: "system fixture",
          revokedByKeyId: "fixture",
        },
      })
      expect(
        await prisma.licenseRevocation.findUnique({ where: { id: revocation.id } })
      ).not.toBeNull()
      for (const context of [null, workspaceId, otherWorkspaceId]) {
        const counts = await asWorkspace(context, async (tx) => [
          await tx.licenseActivation.count({ where: { id: activation.id } }),
          await tx.licenseRevocation.count({ where: { id: revocation.id } }),
        ])
        expect(counts).toEqual([0, 0])
      }
    })
  })
})
