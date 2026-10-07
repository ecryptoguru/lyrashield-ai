import "./test-env"
import { randomBytes } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createBoundedPgAdapter, prisma, withAccountRLS, withMyraPublicRLS } from "@lyrashield/db"
import { MyraSurface, PrismaClient } from "@lyrashield/db/src/generated/prisma"
import { hashPublicToken, issuePublicSession, verifyPublicToken } from "./session"

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
const tokenHash = hashPublicToken(`expired-${suffix}`)
const ownerOnlyHash = hashPublicToken(`account-context-${suffix}`)
const staleToken = `stale-${suffix}`
const staleHash = hashPublicToken(staleToken)
const issuedHashes: string[] = []

describe.skipIf(!disposable)("public Myra session RLS boundaries", () => {
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
        expiresAt: new Date(Date.now() - 60_000),
      },
    })
    await system!.myraPublicSession.create({
      data: {
        tokenHash: ownerOnlyHash,
        surface: MyraSurface.MARKETING,
        expiresAt: new Date(Date.now() + 60_000),
      },
    })
    await system!.myraPublicSession.create({
      data: {
        tokenHash: staleHash,
        surface: MyraSurface.MARKETING,
        lastSeenAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
        expiresAt: new Date(Date.now() + 60_000),
      },
    })
  })

  afterAll(async () => {
    if (system) {
      await system.myraPublicSession.deleteMany({
        where: { tokenHash: { in: [tokenHash, ownerOnlyHash, staleHash, ...issuedHashes] } },
      })
      await system.$disconnect()
    }
  })

  it("denies context-free and account-only access while allowing explicit session operations", async () => {
    expect(await prisma.myraPublicSession.findMany()).toEqual([])
    expect(
      await prisma.myraPublicSession.updateMany({ data: { lastSeenAt: new Date() } })
    ).toMatchObject({ count: 0 })
    expect(await prisma.myraPublicSession.deleteMany()).toMatchObject({ count: 0 })
    await expect(
      prisma.myraPublicSession.create({
        data: {
          tokenHash: hashPublicToken(`unbound-${suffix}`),
          surface: MyraSurface.MARKETING,
          expiresAt: new Date(Date.now() + 60_000),
        },
      })
    ).rejects.toThrow(/row-level security policy "myra_public_sessions_trusted_boundary"/i)

    await expect(
      withAccountRLS(`account-${suffix}`, (tx) => tx.myraPublicSession.findMany())
    ).resolves.toEqual([])
    await expect(
      withAccountRLS(`account-${suffix}`, (tx) =>
        tx.myraPublicSession.deleteMany({ where: { tokenHash: ownerOnlyHash } })
      )
    ).resolves.toMatchObject({ count: 0 })

    const issued = await issuePublicSession(MyraSurface.MARKETING)
    issuedHashes.push(hashPublicToken(issued.token))
    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(await verifyPublicToken(issued.token)).toBe(issued.publicSessionId)
    const slid = await system!.myraPublicSession.findUniqueOrThrow({
      where: { id: issued.publicSessionId },
    })
    expect(slid.lastSeenAt.getTime()).toBeGreaterThan(Date.now() - 5_000)
    expect(slid.expiresAt.getTime()).toBeGreaterThan(issued.expiresAt.getTime() - 5_000)

    const second = await issuePublicSession(MyraSurface.DASHBOARD)
    issuedHashes.push(hashPublicToken(second.token))
    await expect(
      withMyraPublicRLS(issued.publicSessionId, (tx) => tx.myraPublicSession.findMany())
    ).resolves.toHaveLength(1)
    await expect(
      withMyraPublicRLS(second.publicSessionId, (tx) =>
        tx.myraPublicSession.findUnique({ where: { id: issued.publicSessionId } })
      )
    ).resolves.toBeNull()
    await expect(verifyPublicToken(`invalid-${suffix}`)).resolves.toBeNull()
    await expect(verifyPublicToken(`expired-${suffix}`)).resolves.toBeNull()
    const staleId = (
      await system!.myraPublicSession.findUniqueOrThrow({ where: { tokenHash: staleHash } })
    ).id
    await expect(verifyPublicToken(staleToken)).resolves.toBe(staleId)
    const refreshed = await system!.myraPublicSession.findUniqueOrThrow({ where: { id: staleId } })
    expect(refreshed.lastSeenAt.getTime()).toBeGreaterThan(Date.now() - 5_000)
    expect(refreshed.expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * 24 * 60 * 60 * 1000)
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
