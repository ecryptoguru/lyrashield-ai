import { beforeEach, describe, expect, it, vi } from "vitest"

const withWorkspaceRLSMock = vi.hoisted(() => vi.fn())
const executeRawMock = vi.hoisted(() => vi.fn().mockResolvedValue(1))
const findFirstMock = vi.hoisted(() => vi.fn().mockResolvedValue(null))
const createMock = vi.hoisted(() => vi.fn().mockResolvedValue({ id: "usage_1" }))

vi.mock("@lyrashield/db", () => ({
  withWorkspaceRLS: withWorkspaceRLSMock,
  withAccountRLS: (_id: string, callback: (tx: unknown) => unknown) =>
    callback({
      $executeRaw: executeRawMock,
      usageRecord: { findFirst: findFirstMock, create: createMock },
    }),
}))
vi.mock("@lyrashield/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock("@lyrashield/pricing", () => ({
  CLOUD_PLAN_MAP: { PRO: { agentMinutes: 1_200, deepAllowed: true } },
}))

import { grantMonthlyPool, legacyMonthlyPoolGrantKey, monthlyPoolGrantKey } from "./grants"

const cycleStart = new Date("2026-08-15T10:00:00.000Z")
const params = {
  accountId: "acct_1",
  workspaceId: "ws_1",
  plan: "PRO" as const,
  cycleStart,
  source: "annual_monthly" as const,
}

beforeEach(() => {
  vi.clearAllMocks()
  findFirstMock.mockReset()
  createMock.mockReset()
  findFirstMock.mockResolvedValue(null)
  createMock.mockResolvedValue({ id: "usage_1" })
  withWorkspaceRLSMock.mockImplementation((workspaceId, callback, options) => {
    expect(workspaceId).toBe("ws_1")
    expect(options).toEqual(expect.objectContaining({ accountId: "acct_1" }))
    return callback({
      $executeRaw: executeRawMock,
      usageRecord: { findFirst: findFirstMock, create: createMock },
    })
  })
})

describe("grantMonthlyPool — replay-safe per allowance cycle", () => {
  it("creates the grant keyed by account and cycle", async () => {
    const result = await grantMonthlyPool(params)

    expect(result).toMatchObject({
      created: true,
      minutes: 1200,
      idempotencyKey: monthlyPoolGrantKey("acct_1", cycleStart, "PRO"),
    })
    expect(findFirstMock).toHaveBeenCalledWith({
      where: {
        accountId: "acct_1",
        idempotencyKey: {
          in: [
            monthlyPoolGrantKey("acct_1", cycleStart, "PRO"),
            legacyMonthlyPoolGrantKey("ws_1", cycleStart, "PRO"),
          ],
        },
      },
      select: { id: true },
    })
    expect(createMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        accountId: "acct_1",
        workspaceId: "ws_1",
        kind: "pool_grant",
        quantity: 1200,
        cycleStart,
      }),
    })
    expect(executeRawMock).toHaveBeenCalledOnce()
  })

  it("does not duplicate a grant already written under the new key", async () => {
    findFirstMock.mockResolvedValue({ id: "usage_existing" })

    const result = await grantMonthlyPool(params)

    expect(result.created).toBe(false)
    expect(createMock).not.toHaveBeenCalled()
  })

  it("does not duplicate a legacy workspace-keyed grant from the previous image", async () => {
    findFirstMock.mockImplementation(async ({ where }) => {
      const keys: string[] = where.idempotencyKey.in
      return keys.includes(legacyMonthlyPoolGrantKey("ws_1", cycleStart, "PRO"))
        ? { id: "legacy_1" }
        : null
    })

    const result = await grantMonthlyPool(params)

    expect(result.created).toBe(false)
    expect(createMock).not.toHaveBeenCalled()
  })

  it("treats a unique-key race as an idempotent replay", async () => {
    createMock.mockRejectedValueOnce(Object.assign(new Error("unique"), { code: "P2002" }))

    const result = await grantMonthlyPool(params)

    expect(result.created).toBe(false)
  })

  it("grants each cycle independently — next cycle gets a new pool", async () => {
    findFirstMock.mockImplementation(async ({ where }) => {
      const keys: string[] = where.idempotencyKey.in
      // Only the previous cycle's grant exists.
      return keys.some((key) => key.startsWith("acct_1:2026-08")) ? { id: "usage_prev" } : null
    })

    const nextCycle = new Date("2026-09-15T10:00:00.000Z")
    const result = await grantMonthlyPool({ ...params, cycleStart: nextCycle })

    expect(result.created).toBe(true)
    expect(result.idempotencyKey).toBe(monthlyPoolGrantKey("acct_1", nextCycle, "PRO"))
  })
})

it("grants an account without a workspace", async () => {
  await grantMonthlyPool({ ...params, workspaceId: null })
  expect(createMock).toHaveBeenCalledWith({
    data: expect.objectContaining({ accountId: "acct_1", workspaceId: null, quantity: 1200 }),
  })
  expect(withWorkspaceRLSMock).not.toHaveBeenCalled()
})
