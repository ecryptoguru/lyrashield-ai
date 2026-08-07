import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { PrismaClient } from "./generated/prisma"
import { PrismaPg } from "@prisma/adapter-pg"
import { prisma } from "./client"

/**
 * Proves workspace isolation is enforced by Postgres, not merely declared.
 *
 * The rest of the suite proves two things by inspection: that WORKSPACE_SCOPED_MODELS
 * matches the RLS-protected table set, and that the Prisma extension injects a workspace
 * filter. Neither executes a query, so neither would catch a policy that was dropped,
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

    // Seed through the privileged client: the restricted role cannot create the workspace
    // rows that the policies key on.
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
  })

  afterAll(async () => {
    if (targetId) {
      await prisma.$executeRaw`DELETE FROM "Target" WHERE id = ${targetId}`
    }
    await prisma.$executeRaw`DELETE FROM "Workspace" WHERE id IN (${workspaceId}, ${otherWorkspaceId})`
    await restricted?.$disconnect()
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
  })
})
