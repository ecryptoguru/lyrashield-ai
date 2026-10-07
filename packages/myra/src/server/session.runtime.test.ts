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
    "[session.runtime] SKIPPED: requires explicitly opted-in loopback disposable PostgreSQL " +
      "with DATABASE_URL=RLS_RUNTIME_DATABASE_URL and DATABASE_SYSTEM_URL set."
  )
}

const system = disposable ? new PrismaClient({ adapter: createBoundedPgAdapter(systemUrl!) }) : null
const suffix = randomBytes(8).toString("hex")
const expiredToken = `expired-${suffix}`
const staleToken = `stale-${suffix}`
const accountContextToken = `account-context-${suffix}`
const fixtureHashes = [expiredToken, staleToken, accountContextToken].map(hashPublicToken)
const issuedHashes: string[] = []

describe.skipIf(!disposable)("public Myra session runtime behavior", () => {
  beforeAll(async () => {
    const [role] = await prisma.$queryRaw<
      Array<{ rolsuper: boolean; rolbypassrls: boolean; rolname: string }>
    >`SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
    expect(role).toMatchObject({ rolsuper: false, rolbypassrls: false })
    expect(process.env.DATABASE_URL).toBe(runtimeUrl)
    await system!.myraPublicSession.createMany({
      data: [
        {
          tokenHash: fixtureHashes[0],
          surface: MyraSurface.MARKETING,
          expiresAt: new Date(Date.now() - 60_000),
        },
        {
          tokenHash: fixtureHashes[1],
          surface: MyraSurface.MARKETING,
          lastSeenAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
          expiresAt: new Date(Date.now() + 60_000),
        },
        {
          tokenHash: fixtureHashes[2],
          surface: MyraSurface.MARKETING,
          expiresAt: new Date(Date.now() + 60_000),
        },
      ],
    })
  })

  afterAll(async () => {
    if (system) {
      await system.myraPublicSession.deleteMany({
        where: { tokenHash: { in: [...fixtureHashes, ...issuedHashes] } },
      })
      await system.$disconnect()
    }
  })

  it("issues and verifies sessions, rejects invalid or expired tokens, and slides stale expiry", async () => {
    const issued = await issuePublicSession(MyraSurface.MARKETING)
    issuedHashes.push(hashPublicToken(issued.token))
    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(await verifyPublicToken(issued.token)).toBe(issued.publicSessionId)
    expect(await verifyPublicToken(`invalid-${suffix}`)).toBeNull()
    expect(await verifyPublicToken(expiredToken)).toBeNull()

    const staleId = (
      await system!.myraPublicSession.findUniqueOrThrow({ where: { tokenHash: fixtureHashes[1] } })
    ).id
    await expect(verifyPublicToken(staleToken)).resolves.toBe(staleId)
    const refreshed = await system!.myraPublicSession.findUniqueOrThrow({ where: { id: staleId } })
    expect(refreshed.lastSeenAt.getTime()).toBeGreaterThan(Date.now() - 5_000)
    expect(refreshed.expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * 24 * 60 * 60 * 1000)
  })

  it("keeps lookups isolated to the bound public session and rejects account-only context", async () => {
    const first = await issuePublicSession(MyraSurface.MARKETING)
    const second = await issuePublicSession(MyraSurface.DASHBOARD)
    issuedHashes.push(hashPublicToken(first.token), hashPublicToken(second.token))
    await expect(
      withMyraPublicRLS(first.publicSessionId, (tx) => tx.myraPublicSession.findMany())
    ).resolves.toHaveLength(1)
    await expect(
      withMyraPublicRLS(second.publicSessionId, (tx) =>
        tx.myraPublicSession.findUnique({ where: { id: first.publicSessionId } })
      )
    ).resolves.toBeNull()
    await expect(
      withAccountRLS(`account-${suffix}`, (tx) => tx.myraPublicSession.findMany())
    ).resolves.toEqual([])
    await expect(
      withAccountRLS(`account-${suffix}`, (tx) =>
        tx.myraPublicSession.deleteMany({ where: { tokenHash: fixtureHashes[2] } })
      )
    ).resolves.toMatchObject({ count: 0 })
  })
})
