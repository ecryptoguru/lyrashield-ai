import { randomUUID } from "node:crypto"
import { beforeAll, describe, expect, it, vi } from "vitest"

const session = vi.hoisted(() => ({ userId: "" }))
vi.mock("@lyrashield/auth/server", () => ({ getSession: async () => session }))

describe.skipIf(process.env.TRIAL_INTEGRATION_TEST !== "1")(
  "workspace creation route with restricted PostgreSQL",
  () => {
    beforeAll(async () => {
      const url = new URL(process.env.DATABASE_URL!)
      if (!["127.0.0.1", "localhost"].includes(url.hostname))
        throw new Error("Local database required")
      const original = await import("@lyrashield/db")
      const [role] = await original.prisma.$queryRaw<
        Array<{ rolsuper: boolean; rolbypassrls: boolean }>
      >`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
      expect(role).toEqual({ rolsuper: false, rolbypassrls: false })
    })
    it("keeps trial writes inside the creator transaction after a module reload", async () => {
      const original = await import("@lyrashield/db")
      session.userId = randomUUID()
      await original.prisma.user.create({
        data: { id: session.userId, name: "Route trial", email: `${session.userId}@example.test` },
      })
      // Development caches Prisma globally while route/helper modules are reloaded.
      vi.resetModules()
      const { POST } = await import("./route")
      const name = `Trial route ${randomUUID()}`
      const response = await POST(
        new Request("http://localhost/api/workspaces", {
          method: "POST",
          body: JSON.stringify({ name, mode: "VIBE" }),
        })
      )
      expect(await response.json()).toMatchObject({
        success: true,
        data: { trialStarted: true, trialAlreadyUsed: false },
      })
      expect(response.status).toBe(200)
    })
    it("rolls back an actual route failure after the grant and permits the same slug retry", async () => {
      const { prisma } = await import("@lyrashield/db")
      const billing = await import("@lyrashield/billing")
      const { POST } = await import("./route")
      session.userId = randomUUID()
      await prisma.user.create({
        data: {
          id: session.userId,
          name: "Route rollback",
          email: `${session.userId}@example.test`,
        },
      })
      const name = `Route rollback ${randomUUID()}`
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-")
      const request = () =>
        new Request("http://localhost/api/workspaces", {
          method: "POST",
          body: JSON.stringify({ name, mode: "VIBE" }),
        })
      const realStartTrial = billing.startTrial
      const start = vi.spyOn(billing, "startTrial").mockImplementationOnce(async (...args) => {
        await realStartTrial(...args)
        throw new Error("Injected trial failure after grant")
      })
      try {
        expect((await POST(request())).status).toBe(500)
        expect(await prisma.workspace.findUnique({ where: { slug } })).toBeNull()
        expect(
          (await prisma.user.findUnique({ where: { id: session.userId } }))?.trialStartedAt
        ).toBeNull()
        expect((await POST(request())).status).toBe(200)
      } finally {
        start.mockRestore()
      }
    })
  }
)
