import "./test-env"
import { randomBytes } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createBoundedPgAdapter, prisma, withAccountRLS } from "@lyrashield/db"
import { MyraSurface, PrismaClient } from "@lyrashield/db/src/generated/prisma"
import { hashPublicToken } from "./session"

const runtimeUrl = process.env.RLS_RUNTIME_DATABASE_URL
const systemUrl = process.env.DATABASE_SYSTEM_URL
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"])
const databaseTarget = (value: string | undefined): string | null => {
  if (!value) return null
  try {
    const url = new URL(value)
    if (!LOOPBACK_HOSTS.has(url.hostname)) return null
    return `${url.hostname}:${url.port || "5432"}${url.pathname}`
  } catch {
    return null
  }
}
const runtimeTarget = databaseTarget(runtimeUrl)
const disposable = Boolean(
  process.env.LYRASHIELD_TEST_DB_DISPOSABLE === "1" &&
  runtimeUrl &&
  systemUrl &&
  process.env.DATABASE_URL === runtimeUrl &&
  runtimeTarget &&
  databaseTarget(systemUrl) === runtimeTarget
)
if (!disposable) {
  console.warn(
    "[session.rls.runtime] SKIPPED: requires explicitly opted-in loopback disposable PostgreSQL " +
      "with DATABASE_URL=RLS_RUNTIME_DATABASE_URL and DATABASE_SYSTEM_URL set."
  )
}

const system = disposable ? new PrismaClient({ adapter: createBoundedPgAdapter(systemUrl!) }) : null
const suffix = randomBytes(8).toString("hex")
const tokenHash = hashPublicToken(`rls-boundary-${suffix}`)
const insertedHash = hashPublicToken(`rls-boundary-insert-${suffix}`)

describe.skipIf(!disposable)("public Myra session RLS boundary", () => {
  beforeAll(async () => {
    const [role] = await prisma.$queryRaw<
      Array<{ rolsuper: boolean; rolbypassrls: boolean; rolname: string }>
    >`SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
    expect(role).toMatchObject({ rolsuper: false, rolbypassrls: false })
    expect(process.env.DATABASE_URL).toBe(runtimeUrl)
    await system!.myraPublicSession.create({
      data: {
        tokenHash,
        surface: MyraSurface.MARKETING,
        expiresAt: new Date(Date.now() + 60_000),
      },
    })
  })

  afterAll(async () => {
    if (system) {
      await system.myraPublicSession.deleteMany({
        where: { tokenHash: { in: [tokenHash, insertedHash] } },
      })
      await system.$disconnect()
    }
  })

  it("blocks unbound and account-only read, write and delete operations", async () => {
    expect(await prisma.myraPublicSession.findUnique({ where: { tokenHash } })).toBeNull()
    expect(
      await prisma.myraPublicSession.updateMany({
        where: { tokenHash },
        data: { lastSeenAt: new Date() },
      })
    ).toMatchObject({ count: 0 })
    expect(await prisma.myraPublicSession.deleteMany({ where: { tokenHash } })).toMatchObject({
      count: 0,
    })
    await expect(
      prisma.myraPublicSession.create({
        data: { tokenHash: insertedHash, surface: MyraSurface.MARKETING, expiresAt: new Date() },
      })
    ).rejects.toThrow(/row-level security policy "myra_public_sessions_trusted_boundary"/i)

    await expect(
      withAccountRLS(`account-${suffix}`, (tx) =>
        tx.myraPublicSession.findUnique({ where: { tokenHash } })
      )
    ).resolves.toBeNull()
    await expect(
      withAccountRLS(`account-${suffix}`, (tx) =>
        tx.myraPublicSession.updateMany({ where: { tokenHash }, data: { lastSeenAt: new Date() } })
      )
    ).resolves.toMatchObject({ count: 0 })
    await expect(
      withAccountRLS(`account-${suffix}`, (tx) =>
        tx.myraPublicSession.deleteMany({ where: { tokenHash } })
      )
    ).resolves.toMatchObject({ count: 0 })
  })

  it("pins helper function search paths without changing invoker security", async () => {
    const functions = await prisma.$queryRaw<
      Array<{ function_name: string; prosecdef: boolean; proconfig: string[] | null }>
    >`
      SELECT p.proname AS function_name, p.prosecdef, p.proconfig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'app' AND p.proname IN ('current_account_id', 'bind_agent_operation_principal')
      ORDER BY p.proname
    `
    expect(functions).toHaveLength(2)
    for (const fn of functions) {
      expect(fn.prosecdef).toBe(false)
      expect(fn.proconfig).toContain("search_path=pg_catalog")
    }
  })
})
