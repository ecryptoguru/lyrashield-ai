import { randomUUID } from "node:crypto"
import { PrismaPg } from "@prisma/adapter-pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { PrismaClient } from "./generated/prisma"

const databaseUrl = process.env.DATABASE_URL
const runtimeUrl = process.env.RLS_RUNTIME_DATABASE_URL
const owner = databaseUrl
  ? new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) })
  : undefined
const runtime = runtimeUrl
  ? new PrismaClient({ adapter: new PrismaPg({ connectionString: runtimeUrl }) })
  : undefined
const suffix = randomUUID().replace(/-/g, "")
const accountA = `analytics-pref-${suffix}-a`
const accountB = `analytics-pref-${suffix}-b`

if (!databaseUrl || !runtimeUrl) {
  console.warn(
    "[account-preference.rls.runtime] SKIPPED: requires DATABASE_URL and RLS_RUNTIME_DATABASE_URL"
  )
}

describe.skipIf(!databaseUrl || !runtimeUrl)("AccountPreference forced RLS boundary", () => {
  beforeAll(async () => {
    if (!owner || !runtime || !databaseUrl || !runtimeUrl) return
    const ownerDatabase = new URL(databaseUrl)
    const runtimeDatabase = new URL(runtimeUrl)
    const databaseName = ownerDatabase.pathname.replace(/^\/+/, "")
    const allowedDatabases = new Set(["lyrashield_test", "v15_product", "lyra_v18_ci"])
    const localHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "postgres"])
    if (
      ownerDatabase.host !== runtimeDatabase.host ||
      ownerDatabase.pathname !== runtimeDatabase.pathname ||
      !allowedDatabases.has(databaseName) ||
      !localHosts.has(ownerDatabase.hostname) ||
      !localHosts.has(runtimeDatabase.hostname)
    ) {
      throw new Error(
        "AccountPreference runtime test is restricted to a same-database local disposable PostgreSQL URL"
      )
    }

    const [role] = await runtime.$queryRaw<
      Array<{ role_name: string; superuser: boolean; bypass_rls: boolean }>
    >`
      SELECT current_user AS role_name, rolsuper AS superuser, rolbypassrls AS bypass_rls
      FROM pg_roles WHERE rolname = current_user`
    if (!role || role.superuser || role.bypass_rls) {
      throw new Error(
        `RLS_RUNTIME_DATABASE_URL must use a restricted role; ${role?.role_name ?? "unknown"} can bypass RLS`
      )
    }

    const [table] = await owner.$queryRaw<
      Array<{ table_exists: boolean; rls_enabled: boolean; rls_forced: boolean }>
    >`
      SELECT c.oid IS NOT NULL AS table_exists,
             c.relrowsecurity AS rls_enabled,
             c.relforcerowsecurity AS rls_forced
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema() AND c.relname = 'account_preferences'`
    if (!table?.table_exists || !table.rls_enabled || !table.rls_forced) {
      throw new Error("Apply the AccountPreference migration with forced RLS before this test")
    }

    await owner.user.createMany({
      data: [
        { id: accountA, name: accountA, email: `${accountA}@example.test` },
        { id: accountB, name: accountB, email: `${accountB}@example.test` },
      ],
    })
    await owner.accountPreference.create({
      data: { accountId: accountA, analyticsEnabled: false },
    })
  })

  afterAll(async () => {
    try {
      if (owner) await owner.user.deleteMany({ where: { id: { in: [accountA, accountB] } } })
    } finally {
      await owner?.$disconnect()
      await runtime?.$disconnect()
    }
  })

  it("denies unbound and other-account reads and writes", async () => {
    if (!runtime) throw new Error("Runtime Prisma client was not initialized")
    await runtime.$transaction(async (tx) => {
      expect(await tx.accountPreference.findMany()).toEqual([])
      expect(await tx.accountPreference.count({ where: { accountId: accountA } })).toBe(0)
    })

    await runtime.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_account_id', ${accountB}, true)`
      expect(await tx.accountPreference.findMany()).toEqual([])
      expect(await tx.accountPreference.count({ where: { accountId: accountA } })).toBe(0)
      expect(
        (
          await tx.accountPreference.updateMany({
            where: { accountId: accountA },
            data: { analyticsEnabled: true },
          })
        ).count
      ).toBe(0)
      await expect(
        tx.accountPreference.create({
          data: { accountId: accountA, analyticsEnabled: true },
        })
      ).rejects.toThrow()
    })
  })

  it("allows the owning account without workspace context", async () => {
    if (!runtime) throw new Error("Runtime Prisma client was not initialized")
    await runtime.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_account_id', ${accountA}, true)`
      const preference = await tx.accountPreference.findUnique({ where: { accountId: accountA } })
      expect(preference?.analyticsEnabled).toBe(false)
      expect(
        (
          await tx.accountPreference.updateMany({
            where: { accountId: accountA },
            data: { analyticsEnabled: true },
          })
        ).count
      ).toBe(1)
    })
  })
})
