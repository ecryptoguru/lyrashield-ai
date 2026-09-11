import { beforeEach, describe, expect, it, vi } from "vitest"

const withWorkspaceRLSMock = vi.hoisted(() => vi.fn())
const executeRawMock = vi.hoisted(() => vi.fn().mockResolvedValue(1))
const findUniqueMock = vi.hoisted(() => vi.fn().mockResolvedValue(null))
const findFirstMock = vi.hoisted(() => vi.fn().mockResolvedValue(null))
const workspaceFindMock = vi.hoisted(() => vi.fn().mockResolvedValue({ id: "ws_1" }))
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
  findUniqueMock.mockResolvedValue(null)
  findFirstMock.mockResolvedValue(null)
  workspaceFindMock.mockResolvedValue({ id: "ws_1" })
  const tx = {
    $executeRaw: executeRawMock,
    minutePack: {
      findUnique: findUniqueMock,
      findFirst: findFirstMock,
      create: createMock,
      update: vi.fn(),
    },
    workspace: { findUnique: workspaceFindMock },
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

  it("dedupes a replayed payment whose pack attribution was detached by workspace deletion", async () => {
    // The pack's workspaceId was SET NULL after the workspace hard-delete —
    // the compound key misses forever; the account+provider+externalId probe
    // is what keeps a redelivery from double-crediting.
    findFirstMock.mockResolvedValueOnce({ id: "pack_orphan", minutes: 100 })

    await expect(
      creditTopUp({ ...input, expiresAt: null, externalId: "ord_1" })
    ).resolves.toMatchObject({ created: false, packId: "pack_orphan", minutes: 100 })
    expect(findFirstMock).toHaveBeenCalledWith({
      where: { accountId: "acct_1", provider: "polar", externalId: "ord_1" },
      select: { id: true, minutes: true },
    })
    expect(createMock).not.toHaveBeenCalled()
  })

  it("credits with NULL attribution when the purchase workspace no longer exists", async () => {
    workspaceFindMock.mockResolvedValueOnce(null)

    await expect(
      creditTopUp({ ...input, expiresAt: null, externalId: "ord_1" })
    ).resolves.toMatchObject({ created: true })
    // Paid must never strand on the attribution FK — the pack stays
    // account-owned under the account RLS policy.
    expect(createMock).toHaveBeenCalledWith({
      data: expect.objectContaining({ workspaceId: null, accountId: "acct_1" }),
    })
  })
})
