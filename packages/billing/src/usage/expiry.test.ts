import { beforeEach, describe, expect, it, vi } from "vitest"

const packFindManyMock = vi.hoisted(() => vi.fn())
const packUpdateManyMock = vi.hoisted(() => vi.fn())
const auditCreateMock = vi.hoisted(() => vi.fn().mockResolvedValue({ id: "audit_1" }))
const withWorkspaceRLSMock = vi.hoisted(() => vi.fn())
const executeRawMock = vi.hoisted(() => vi.fn().mockResolvedValue(1))

vi.mock("@lyrashield/db", () => ({
  withWorkspaceRLS: withWorkspaceRLSMock,
  prisma: {
    workspace: { findMany: vi.fn().mockResolvedValue([{ id: "ws_1" }]) },
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
  withWorkspaceRLSMock.mockImplementation((workspaceId, callback) => {
    expect(workspaceId).toBe("ws_1")
    return callback({
      $executeRaw: executeRawMock,
      minutePack: { findMany: packFindManyMock, updateMany: packUpdateManyMock },
    })
  })
})

describe("expirePacks", () => {
  it("binds each workspace through RLS instead of using the system client", async () => {
    await expect(expirePacks()).resolves.toEqual({ expired: 0 })

    expect(withWorkspaceRLSMock).toHaveBeenCalledOnce()
    expect(executeRawMock).toHaveBeenCalledOnce()
    expect(packFindManyMock).toHaveBeenCalledOnce()
    expect(packUpdateManyMock).not.toHaveBeenCalled()
  })
})
