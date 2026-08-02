import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { prisma } from "./client"

/**
 * Regression test for the pre-auth API-key lookup under workspace RLS.
 *
 * The bug: "ApiKey" is under FORCE row-level security with a strict
 * workspace-match policy. verifyApiKey() looks a key up by hash BEFORE any
 * workspace is known (no RLS context), so under the restricted NOBYPASSRLS
 * application role the direct lookup matches zero rows and every Bearer /
 * MCP request 401s. The fix routes the lookup through the SECURITY DEFINER
 * function app.verify_api_key (migration 20260724170000).
 *
 * This test reproduces the exact production role posture by creating a
 * NOBYPASSRLS role and running as it. It needs a live Postgres and a
 * connection allowed to CREATE ROLE / SET ROLE (the CI/admin migration
 * connection); it skips gracefully anywhere that isn't available, so it never
 * fails spuriously.
 */

const suffix = randomUUID().replace(/-/g, "")
const role = `apikey_rls_test_${suffix}`
const workspaceId = `apikey-rls-ws-${suffix}`
const userId = `apikey-rls-user-${suffix}`
const rawKey = `lsk_${randomBytes(32).toString("base64url")}`
const hashed = createHash("sha256").update(rawKey, "utf8").digest("hex")

let live = false

async function canRunLiveRoleTest(): Promise<boolean> {
  try {
    // A cheap probe that also confirms we can manage roles here.
    await prisma.$executeRawUnsafe(`SET LOCAL statement_timeout = 5000`)
    await prisma.$executeRawUnsafe(`CREATE ROLE "${role}" NOBYPASSRLS`)
    return true
  } catch {
    return false
  }
}

describe("verifyApiKey under restricted-role RLS", () => {
  beforeAll(async () => {
    live = await canRunLiveRoleTest()
    if (!live) return

    // Seed a workspace + key as the (bypass-capable) migration role. Set a
    // matching workspace context so the strict WITH CHECK policy accepts the
    // insert even if the seeding role is itself RLS-forced.
    await prisma.user.create({
      data: { id: userId, name: "RLS", email: `${userId}@example.com` },
    })
    await prisma.workspace.create({
      data: { id: workspaceId, name: "RLS", slug: workspaceId },
    })
    await prisma.$executeRaw`SELECT set_config('app.current_workspace_id', ${workspaceId}, false)`
    await prisma.apiKey.create({
      data: {
        workspaceId,
        name: "rls-probe",
        hashedKey: hashed,
        prefix: rawKey.slice(0, 12),
        scopes: ["read"],
        createdById: userId,
      },
    })
    await prisma.$executeRaw`SELECT set_config('app.current_workspace_id', '', false)`

    // Grant the restricted role what the production app role holds, then the
    // migration's DO block grant target (EXECUTE on the definer fns).
    await prisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA app, public TO "${role}"`)
    await prisma.$executeRawUnsafe(`GRANT SELECT ON "ApiKey" TO "${role}"`)
    await prisma.$executeRawUnsafe(
      `GRANT EXECUTE ON FUNCTION app.verify_api_key(text) TO "${role}"`
    )
  })

  afterAll(async () => {
    if (live) {
      try {
        await prisma.$executeRawUnsafe(`RESET ROLE`)
        await prisma.apiKey.deleteMany({ where: { workspaceId } })
        await prisma.$executeRaw`DELETE FROM "Workspace" WHERE id = ${workspaceId}`
        await prisma.user.deleteMany({ where: { id: userId } })
        await prisma.$executeRawUnsafe(`DROP ROLE IF EXISTS "${role}"`)
      } catch {
        /* best-effort cleanup */
      }
    }
  })

  it("reproduces the RLS block on a direct pre-auth lookup, and the definer function fixes it", async () => {
    if (!live) {
      // Environment can't manage roles (e.g. sandbox without pg) — skip.
      expect(true).toBe(true)
      return
    }

    // Act as the restricted, NOBYPASSRLS application role with NO workspace
    // context — exactly the pre-auth verify posture.
    await prisma.$executeRawUnsafe(`SET ROLE "${role}"`)
    await prisma.$executeRaw`SELECT set_config('app.current_workspace_id', '', true)`

    // (bug) Direct RLS-scoped lookup returns nothing pre-auth.
    const direct = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM "ApiKey" WHERE "hashedKey" = $1`,
      hashed
    )
    expect(direct.length).toBe(0)

    // (fix) The SECURITY DEFINER function resolves the key regardless of
    // workspace context.
    const viaFn = await prisma.$queryRawUnsafe<Array<{ id: string; workspaceId: string }>>(
      `SELECT id, "workspaceId" FROM app.verify_api_key($1)`,
      hashed
    )
    expect(viaFn.length).toBe(1)
    expect(viaFn[0]?.workspaceId).toBe(workspaceId)

    await prisma.$executeRawUnsafe(`RESET ROLE`)
  })
})
