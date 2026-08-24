import { beforeEach, describe, expect, it, vi } from "vitest"
import type { PlatformAdminIdentity } from "@lyrashield/auth/server"

const prisma = {
  user: { findMany: vi.fn() },
  workspace: { findMany: vi.fn() },
  scan: { findMany: vi.fn() },
  platformAdminAudit: { findMany: vi.fn() },
}

vi.mock("@lyrashield/db", () => ({ getSystemPrisma: () => prisma }))

import {
  getPlatformAdminAudit,
  getPlatformAdminScans,
  getPlatformAdminUsers,
  getPlatformAdminWorkspaces,
  parseAdminCursor,
} from "./platform-admin-lists"

const identity = {} as PlatformAdminIdentity

describe("platform admin lists", () => {
  beforeEach(() => vi.clearAllMocks())

  it("rejects malformed cursors", () => {
    expect(parseAdminCursor("ok_123-ABC")).toBe("ok_123-ABC")
    expect(parseAdminCursor("../secret")).toBeUndefined()
    expect(parseAdminCursor("x".repeat(129))).toBeUndefined()
  })

  it("returns a bounded user page with no account or session payload", async () => {
    prisma.user.findMany.mockResolvedValue(
      Array.from({ length: 26 }, (_, index) => ({
        id: `user-${index}`,
        email: `user-${index}@example.com`,
        emailVerified: index % 2 === 0,
        platformRole: null,
        twoFactorEnabled: false,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      }))
    )

    const result = await getPlatformAdminUsers(identity, "user-cursor")

    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 26,
        cursor: { id: "user-cursor" },
        skip: 1,
        select: expect.not.objectContaining({ sessions: expect.anything() }),
      })
    )
    expect(result.items).toHaveLength(25)
    expect(result.nextCursor).toBe("user-24")
  })

  it("returns workspace labels and aggregate counts only", async () => {
    prisma.workspace.findMany.mockResolvedValue([
      {
        id: "ws-1",
        name: "Acme",
        plan: "PRO",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        _count: { members: 3, targets: 2 },
      },
    ])

    await expect(getPlatformAdminWorkspaces(identity)).resolves.toEqual({
      items: [
        {
          id: "ws-1",
          name: "Acme",
          plan: "PRO",
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          memberCount: 3,
          targetCount: 2,
        },
      ],
      nextCursor: null,
    })
  })

  it("does not select scan findings, errors, summaries, tokens, or costs", async () => {
    prisma.scan.findMany.mockResolvedValue([])

    await getPlatformAdminScans(identity)

    const query = prisma.scan.findMany.mock.calls[0]?.[0]
    expect(query.select).toEqual({
      id: true,
      status: true,
      mode: true,
      createdAt: true,
      startedAt: true,
      endedAt: true,
      workspace: { select: { id: true, name: true } },
      target: { select: { id: true, name: true } },
    })
  })

  it("lists bounded platform audit metadata without mutation input", async () => {
    prisma.platformAdminAudit.findMany.mockResolvedValue([
      {
        id: "audit-1",
        actorUserId: "user-1",
        action: "affiliate.suspend",
        resourceType: "affiliate",
        resourceId: "affiliate-1",
        createdAt: new Date("2026-08-24T00:00:00Z"),
      },
      {
        id: "audit-2",
        actorUserId: "deleted-user",
        action: "affiliate.reject",
        resourceType: "affiliate",
        resourceId: "affiliate-2",
        createdAt: new Date("2026-08-24T00:01:00Z"),
      },
    ])
    prisma.user.findMany.mockResolvedValue([{ id: "user-1", email: "admin@example.com" }])

    await expect(getPlatformAdminAudit(identity)).resolves.toMatchObject({
      items: [
        {
          action: "affiliate.suspend",
          resourceType: "affiliate",
          actorEmail: "admin@example.com",
        },
        { action: "affiliate.reject", actorEmail: "Deleted user" },
      ],
      nextCursor: null,
    })
    expect(prisma.platformAdminAudit.findMany).toHaveBeenCalledWith({
      orderBy: { id: "desc" },
      take: 26,
      select: {
        id: true,
        actorUserId: true,
        action: true,
        resourceType: true,
        resourceId: true,
        createdAt: true,
      },
    })
    expect(prisma.user.findMany).toHaveBeenCalledOnce()
    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { id: { in: ["user-1", "deleted-user"] } },
      select: { id: true, email: true },
    })
  })
})
