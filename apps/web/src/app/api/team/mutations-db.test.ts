import { expect, it, vi } from "vitest"
const permission = vi.hoisted(() => vi.fn())
const getSession = vi.hoisted(() => vi.fn())
vi.mock("@lyrashield/auth/server", () => ({ requirePermission: permission, getSession }))
vi.mock("@lyrashield/integrations", () => ({ sendNotification: vi.fn() }))
vi.mock("../../../lib/rate-limit", () => ({
  checkInvitationCreateRateLimit: vi.fn().mockResolvedValue({ limited: false }),
}))

async function localFixture() {
  const database = new URL(process.env.DATABASE_URL!)
  if (
    !["127.0.0.1", "localhost"].includes(database.hostname) ||
    database.pathname !== "/v15_product"
  )
    throw new Error("Local v15_product database required")
  const db = await import("@lyrashield/db")
  const system = db.getSystemPrisma()
  const suffix = crypto.randomUUID()
  const users = await Promise.all(
    [0, 1].map((index) =>
      system.user.create({
        data: {
          id: crypto.randomUUID(),
          name: `Owner ${index}`,
          email: `team-review-${suffix}-${index}@example.com`,
        },
      })
    )
  )
  const workspace = await system.workspace.create({
    data: { name: "Team review fixture", slug: `team-review-${suffix}`, mode: "VIBE" },
  })
  const members = await Promise.all(
    users.map((user) =>
      system.workspaceMember.create({
        data: {
          workspaceId: workspace.id,
          userId: user.id,
          role: "OWNER",
          status: "active",
          invitedEmail: user.email,
        },
      })
    )
  )
  return {
    db,
    system,
    users,
    workspace,
    members,
    cleanup: async () => {
      await system.workspace.update({
        where: { id: workspace.id },
        data: { deletedAt: new Date() },
      })
      await system.workspaceMember.updateMany({
        where: { workspaceId: workspace.id },
        data: { status: "removed" },
      })
      await db.prisma.$disconnect()
      await system.$disconnect()
    },
  }
}

it.runIf(process.env.TEAM_MUTATION_DB_TEST === "1")(
  "removes, reinvites and reactivates the same membership with the new role",
  async () => {
    const fixture = await localFixture()
    const { system, users, workspace, members } = fixture
    const { DELETE, POST } = await import("./route")
    const { POST: accept } = await import("./invitations/accept/route")
    try {
      permission.mockResolvedValue({
        session: { userId: users[0]!.id },
        workspace: { role: "OWNER" },
      })
      expect(
        (
          await DELETE(
            new Request(
              `http://localhost/api/team?${new URLSearchParams({ workspaceId: workspace.id, memberId: members[1]!.id })}`,
              { method: "DELETE" }
            )
          )
        ).status
      ).toBe(200)
      const invitation = await POST(
        new Request("http://localhost/api/team", {
          method: "POST",
          body: JSON.stringify({
            workspaceId: workspace.id,
            email: users[1]!.email,
            role: "VIEWER",
          }),
        })
      )
      expect(invitation.status).toBe(200)
      const token = new URL((await invitation.json()).data.inviteUrl).searchParams.get("invite")
      getSession.mockResolvedValue({ userId: users[1]!.id, userEmail: users[1]!.email })
      expect(
        (
          await accept(
            new Request("http://localhost/api/team/invitations/accept", {
              method: "POST",
              body: JSON.stringify({ token }),
            })
          )
        ).status
      ).toBe(200)
      expect(
        await system.workspaceMember.findUnique({ where: { id: members[1]!.id } })
      ).toMatchObject({ id: members[1]!.id, role: "VIEWER", status: "active" })
    } finally {
      await fixture.cleanup()
    }
  },
  30_000
)

it.runIf(process.env.TEAM_MUTATION_DB_TEST === "1")(
  "revalidates account-deletion ownership after a concurrent team self-demotion",
  async () => {
    const fixture = await localFixture()
    const { db, system, users, workspace, members } = fixture
    const { PATCH } = await import("./route")
    let release!: () => void
    let locked!: () => void
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve
    })
    const lockedPromise = new Promise<void>((resolve) => {
      locked = resolve
    })
    const originalLock = db.lockWorkspaceMembership
    const spy = vi.spyOn(db, "lockWorkspaceMembership").mockImplementationOnce(async (tx, id) => {
      await originalLock(tx, id)
      locked()
      await releasePromise
    })
    try {
      permission.mockResolvedValue({
        session: { userId: users[1]!.id },
        workspace: { role: "OWNER" },
      })
      const demotion = PATCH(
        new Request("http://localhost/api/team", {
          method: "PATCH",
          body: JSON.stringify({
            workspaceId: workspace.id,
            memberId: members[1]!.id,
            role: "MEMBER",
          }),
        })
      )
      await lockedPromise
      const deletion = db.deleteUserAccount(users[0]!.id, "DELETE").then(
        () => null,
        (error: unknown) => error
      )
      // Observe the real deletion transaction waiting behind the team's row lock.
      await expect
        .poll(async () => {
          const rows = await system.$queryRaw<
            Array<{ count: bigint }>
          >`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%Workspace%FOR NO KEY UPDATE%'`
          return Number(rows[0]!.count)
        })
        .toBeGreaterThan(0)
      release()
      expect((await demotion).status).toBe(200)
      expect(await deletion).toBeInstanceOf(db.AccountDeletionBlockedError)
      expect(
        await system.workspaceMember.count({
          where: { workspaceId: workspace.id, role: "OWNER", status: "active" },
        })
      ).toBe(1)
      expect(await system.user.findUnique({ where: { id: users[0]!.id } })).not.toBeNull()
    } finally {
      release()
      spy.mockRestore()
      await fixture.cleanup()
    }
  },
  30_000
)

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
