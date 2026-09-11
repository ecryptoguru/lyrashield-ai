import { beforeEach, describe, expect, it, vi } from "vitest"

const packFindManyMock = vi.hoisted(() => vi.fn())
const packUpdateManyMock = vi.hoisted(() => vi.fn())
const candidateFindManyMock = vi.hoisted(() => vi.fn())
const auditCreateMock = vi.hoisted(() => vi.fn().mockResolvedValue({ id: "audit_1" }))
const withWorkspaceRLSMock = vi.hoisted(() => vi.fn())
const withAccountRLSMock = vi.hoisted(() => vi.fn())
const executeRawMock = vi.hoisted(() => vi.fn().mockResolvedValue(1))

vi.mock("@lyrashield/db", () => ({
  withWorkspaceRLS: withWorkspaceRLSMock,
  withAccountRLS: withAccountRLSMock,
  getSystemPrisma: () => ({
    minutePack: { findMany: candidateFindManyMock },
  }),
  prisma: {
    auditLog: { create: auditCreateMock },
  },
}))
vi.mock("@lyrashield/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { expirePacks } from "./expiry"

beforeEach(() => {
  vi.clearAllMocks()
  packFindManyMock.mockResolvedValue([])
  packUpdateManyMock.mockResolvedValue({ count: 0 })
  candidateFindManyMock.mockResolvedValue([
    { accountId: "acct_1", workspaceId: "ws_1" },
    { accountId: null, workspaceId: "ws_1" },
    // A live account with nothing expired is never touched.
  ])
  withWorkspaceRLSMock.mockImplementation((workspaceId, callback) => {
    expect(workspaceId).toBe("ws_1")
    return callback({
      $executeRaw: executeRawMock,
      minutePack: { findMany: packFindManyMock, updateMany: packUpdateManyMock },
    })
  })
  withAccountRLSMock.mockImplementation((accountId, callback) => {
    expect(accountId).toBe("acct_1")
    return callback({
      $executeRaw: executeRawMock,
      minutePack: { findMany: packFindManyMock, updateMany: packUpdateManyMock },
    })
  })
})

describe("expirePacks", () => {
  it("binds each affected account and workspace through RLS instead of sweeping every tenant", async () => {
    await expect(expirePacks()).resolves.toEqual({ expired: 0 })

    // The candidate sweep reads pack rows once through the system client…
    expect(candidateFindManyMock).toHaveBeenCalledOnce()
    // …then binds only the scopes that actually hold expiring packs.
    expect(withAccountRLSMock).toHaveBeenCalledOnce()
    expect(withWorkspaceRLSMock).toHaveBeenCalledOnce()
    expect(executeRawMock).toHaveBeenCalledTimes(2)
    expect(packFindManyMock).toHaveBeenCalledTimes(2)
    expect(packFindManyMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ where: expect.objectContaining({ accountId: "acct_1" }) })
    )
    expect(packFindManyMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({ workspaceId: "ws_1", accountId: null }),
      })
    )
    expect(packUpdateManyMock).not.toHaveBeenCalled()
  })

  it("does not open tenant transactions when nothing is expiring", async () => {
    candidateFindManyMock.mockResolvedValue([])
    await expect(expirePacks()).resolves.toEqual({ expired: 0 })
    expect(withAccountRLSMock).not.toHaveBeenCalled()
    expect(withWorkspaceRLSMock).not.toHaveBeenCalled()
  })
})
