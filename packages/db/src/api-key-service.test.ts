import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./client", () => ({
  prisma: {
    apiKey: {
      create: vi.fn(),
      count: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
    // verifyApiKey uses SECURITY DEFINER SQL functions (RLS pre-auth bypass),
    // not the model API — see migration 20260724170000.
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
  },
}))

import { prisma } from "./client"
import {
  createApiKey,
  verifyApiKey,
  revokeApiKey,
  hashApiKey,
  isApiKeyFormat,
  API_KEY_PREFIX,
} from "./api-key-service"

const mockPrisma = prisma as unknown as {
  apiKey: {
    create: ReturnType<typeof vi.fn>
    count: ReturnType<typeof vi.fn>
    findMany: ReturnType<typeof vi.fn>
    updateMany: ReturnType<typeof vi.fn>
  }
  $queryRaw: ReturnType<typeof vi.fn>
  $executeRaw: ReturnType<typeof vi.fn>
}

function storedKey(overrides: Record<string, unknown> = {}) {
  const rawKey = `${API_KEY_PREFIX}${"a".repeat(43)}`
  return {
    rawKey,
    row: {
      id: "key-1",
      workspaceId: "ws-1",
      name: "CI key",
      hashedKey: hashApiKey(rawKey),
      prefix: rawKey.slice(0, 12),
      scopes: ["read", "write"],
      createdById: "user-1",
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    },
  }
}

describe("isApiKeyFormat", () => {
  it("accepts well-formed keys", () => {
    expect(isApiKeyFormat(`${API_KEY_PREFIX}${"a".repeat(43)}`)).toBe(true)
  })
  it("rejects wrong prefix, short, overlong, and injection-shaped input", () => {
    expect(isApiKeyFormat(`sk_${"a".repeat(43)}`)).toBe(false)
    expect(isApiKeyFormat(`${API_KEY_PREFIX}ab`)).toBe(false)
    expect(isApiKeyFormat(`${API_KEY_PREFIX}${"a".repeat(200)}`)).toBe(false)
    expect(isApiKeyFormat(`${API_KEY_PREFIX}${"a".repeat(20)}' OR 1=1--`)).toBe(false)
  })
})

describe("createApiKey", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.apiKey.count.mockResolvedValue(0)
    mockPrisma.apiKey.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({
        id: "key-new",
        lastUsedAt: null,
        revokedAt: null,
        deletedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        expiresAt: null,
        ...data,
      })
    )
  })

  it("returns the raw key once and persists only the hash", async () => {
    const created = await createApiKey({
      workspaceId: "ws-1",
      name: "CI key",
      scopes: ["read"],
      createdById: "user-1",
    })
    expect(created.rawKey.startsWith(API_KEY_PREFIX)).toBe(true)
    const persisted = mockPrisma.apiKey.create.mock.calls[0][0].data
    expect(persisted.hashedKey).toBe(hashApiKey(created.rawKey))
    expect(persisted.hashedKey).not.toContain(created.rawKey)
    expect(JSON.stringify(created.apiKey)).not.toContain(created.rawKey.slice(15))
    expect(created.apiKey.prefix).toBe(created.rawKey.slice(0, 12))
  })

  it("rejects invalid scopes, empty names, and past expiry", async () => {
    await expect(
      createApiKey({ workspaceId: "w", name: "k", scopes: ["admin"], createdById: "u" })
    ).rejects.toThrow("INVALID_SCOPES")
    await expect(
      createApiKey({ workspaceId: "w", name: "  ", scopes: ["read"], createdById: "u" })
    ).rejects.toThrow("INVALID_NAME")
    await expect(
      createApiKey({
        workspaceId: "w",
        name: "k",
        scopes: ["read"],
        createdById: "u",
        expiresAt: new Date(Date.now() - 1000),
      })
    ).rejects.toThrow("INVALID_EXPIRY")
  })

  it("enforces the per-workspace active key limit", async () => {
    mockPrisma.apiKey.count.mockResolvedValue(20)
    await expect(
      createApiKey({ workspaceId: "w", name: "k", scopes: ["read"], createdById: "u" })
    ).rejects.toThrow("KEY_LIMIT_REACHED")
  })
})

describe("verifyApiKey", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.$executeRaw.mockResolvedValue(1)
  })

  it("verifies a live key via the SECURITY DEFINER lookup and returns its workspace binding", async () => {
    const { rawKey, row } = storedKey()
    mockPrisma.$queryRaw.mockResolvedValue([row])
    const verified = await verifyApiKey(rawKey)
    expect(verified).toMatchObject({ keyId: "key-1", workspaceId: "ws-1" })
    // The lookup goes through the definer function (raw SQL), never the
    // RLS-scoped model API, so it works pre-auth with no workspace context.
    expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1)
    const [strings, hashArg] = mockPrisma.$queryRaw.mock.calls[0]
    expect(String(strings.join("?"))).toContain("app.verify_api_key")
    expect(hashArg).toBe(hashApiKey(rawKey))
  })

  it("returns null for unknown, revoked, expired, and soft-deleted keys", async () => {
    mockPrisma.$queryRaw.mockResolvedValue([])
    expect(await verifyApiKey(`${API_KEY_PREFIX}${"b".repeat(43)}`)).toBeNull()

    const revoked = storedKey({ revokedAt: new Date() })
    mockPrisma.$queryRaw.mockResolvedValue([revoked.row])
    expect(await verifyApiKey(revoked.rawKey)).toBeNull()

    const expired = storedKey({ expiresAt: new Date(Date.now() - 1000) })
    mockPrisma.$queryRaw.mockResolvedValue([expired.row])
    expect(await verifyApiKey(expired.rawKey)).toBeNull()

    const deleted = storedKey({ deletedAt: new Date() })
    mockPrisma.$queryRaw.mockResolvedValue([deleted.row])
    expect(await verifyApiKey(deleted.rawKey)).toBeNull()
  })

  it("rejects malformed input without touching the database", async () => {
    expect(await verifyApiKey("not-a-key")).toBeNull()
    expect(mockPrisma.$queryRaw).not.toHaveBeenCalled()
  })

  it("throttles lastUsedAt writes to once per minute", async () => {
    const recent = storedKey({ lastUsedAt: new Date() })
    mockPrisma.$queryRaw.mockResolvedValue([recent.row])
    await verifyApiKey(recent.rawKey)
    expect(mockPrisma.$executeRaw).not.toHaveBeenCalled()

    const stale = storedKey({ lastUsedAt: new Date(Date.now() - 120_000) })
    mockPrisma.$queryRaw.mockResolvedValue([stale.row])
    await verifyApiKey(stale.rawKey)
    expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1)
  })
})

describe("revokeApiKey", () => {
  it("is a workspace-scoped CAS: no revive and no cross-workspace reach", async () => {
    mockPrisma.apiKey.updateMany.mockResolvedValue({ count: 0 })
    expect(await revokeApiKey("key-1", "other-ws")).toBe(false)
    expect(mockPrisma.apiKey.updateMany).toHaveBeenCalledWith({
      where: { id: "key-1", workspaceId: "other-ws", revokedAt: null, deletedAt: null },
      data: { revokedAt: expect.any(Date) },
    })
  })
})
