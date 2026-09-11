import { beforeEach, describe, expect, it, vi } from "vitest"

const withWorkspaceRLSMock = vi.hoisted(() => vi.fn())
const executeRawMock = vi.hoisted(() => vi.fn().mockResolvedValue(1))
const findUniqueMock = vi.hoisted(() => vi.fn().mockResolvedValue(null))
const createMock = vi.hoisted(() => vi.fn().mockResolvedValue({ id: "pack_1" }))

vi.mock("@lyrashield/db", () => ({ withWorkspaceRLS: withWorkspaceRLSMock }))
vi.mock("@lyrashield/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock("@lyrashield/pricing", () => ({ PACK_VALIDITY_DAYS: 180 }))

import { creditTopUp } from "./packs"

const input = {
  accountId: "acct_1",
  workspaceId: "ws_1",
  provider: "polar" as const,
  minutes: 100,
}

beforeEach(() => {
  vi.clearAllMocks()
  const tx = {
    $executeRaw: executeRawMock,
    minutePack: {
      findUnique: findUniqueMock,
      create: createMock,
      update: vi.fn(),
    },
  }
  withWorkspaceRLSMock.mockImplementation((workspaceId, callback, options) => {
    expect(workspaceId).toBe("ws_1")
    expect(options).toEqual(expect.objectContaining({ accountId: "acct_1" }))
    return callback(tx)
  })
})

describe("creditTopUp", () => {
  it("creates an account-owned pack inside a workspace-RLS transaction", async () => {
    await expect(
      creditTopUp({
        ...input,
        expiresAt: new Date("2027-01-01T00:00:00.000Z"),
        externalId: "ord_1",
      })
    ).resolves.toMatchObject({ created: true, packId: "pack_1", minutes: 100 })

    expect(executeRawMock).toHaveBeenCalledOnce()
    expect(findUniqueMock).toHaveBeenCalledWith({
      where: { workspaceId_externalId: { workspaceId: "ws_1", externalId: "ord_1" } },
      select: { id: true, minutes: true, deletedAt: true },
    })
    expect(createMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "ws_1",
        accountId: "acct_1",
        provider: "polar",
        externalId: "ord_1",
        minutes: 100,
        remainingMinutes: 100,
      }),
    })
  })

  it("returns the existing entitlement on a replay without creating another pack", async () => {
    findUniqueMock.mockResolvedValueOnce({ id: "pack_1", minutes: 100, deletedAt: null })

    await expect(
      creditTopUp({ ...input, expiresAt: null, externalId: "ord_1" })
    ).resolves.toMatchObject({
      created: false,
      packId: "pack_1",
      minutes: 100,
    })
    expect(createMock).not.toHaveBeenCalled()
  })
})
