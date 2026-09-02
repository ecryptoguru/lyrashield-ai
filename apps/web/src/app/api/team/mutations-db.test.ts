import { expect, it, vi } from "vitest"
const permission = vi.hoisted(() => vi.fn())
vi.mock("@lyrashield/auth/server", () => ({ requirePermission: permission, getSession: vi.fn() }))
vi.mock("@lyrashield/integrations", () => ({ sendNotification: vi.fn() }))
vi.mock("../../../lib/rate-limit", () => ({ checkInvitationCreateRateLimit: vi.fn() }))

it.runIf(process.env.TEAM_MUTATION_DB_TEST === "1")(
  "serializes concurrent owner removals under the restricted database role",
  async () => {
    const database = new URL(process.env.DATABASE_URL!)
    if (
      !["127.0.0.1", "localhost"].includes(database.hostname) ||
      !database.pathname.endsWith("/v15_product")
    ) {
      throw new Error("Team race proof requires the isolated local v15_product database")
    }
    const { getSystemPrisma, prisma } = await import("@lyrashield/db")
    const { DELETE } = await import("./route")
    const system = getSystemPrisma()
    const suffix = crypto.randomUUID()
    const users = await Promise.all(
      [0, 1].map((index) =>
        system.user.create({
          data: {
            id: crypto.randomUUID(),
            name: `Owner ${index}`,
            email: `team-race-${suffix}-${index}@example.com`,
          },
        })
      )
    )
    const workspace = await system.workspace.create({
      data: { name: "Team race fixture", slug: `team-race-${suffix}`, mode: "VIBE" },
    })
    try {
      const role = await prisma.$queryRaw<
        Array<{ rolsuper: boolean; rolbypassrls: boolean }>
      >`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
      expect(role).toEqual([{ rolsuper: false, rolbypassrls: false }])
      const members = await Promise.all(
        users.map((user) =>
          system.workspaceMember.create({
            data: { workspaceId: workspace.id, userId: user.id, role: "OWNER", status: "active" },
          })
        )
      )
      permission
        .mockResolvedValueOnce({ session: { userId: users[0]!.id } })
        .mockResolvedValueOnce({ session: { userId: users[1]!.id } })
      const responses = await Promise.all(
        members.map((_, index) =>
          DELETE(
            new Request(
              `http://localhost/api/team?${new URLSearchParams({ workspaceId: workspace.id, memberId: members[1 - index]!.id })}`,
              { method: "DELETE" }
            )
          )
        )
      )
      expect(responses.map((response) => response.status).sort()).toEqual([200, 403])
      expect(
        await system.workspaceMember.count({
          where: { workspaceId: workspace.id, role: "OWNER", status: "active" },
        })
      ).toBe(1)
      expect(
        await system.auditLog.count({
          where: { workspaceId: workspace.id, action: "member.removed" },
        })
      ).toBe(1)
    } finally {
      await system.workspace.update({
        where: { id: workspace.id },
        data: { deletedAt: new Date() },
      })
      await system.workspaceMember.updateMany({
        where: { workspaceId: workspace.id },
        data: { status: "removed" },
      })
      await prisma.$disconnect()
      await system.$disconnect()
    }
  },
  30_000
)
