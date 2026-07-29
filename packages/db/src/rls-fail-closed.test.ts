import { afterAll, beforeAll, describe, expect, it } from "vitest"
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

const suffix = `${Date.now()}`
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
})
