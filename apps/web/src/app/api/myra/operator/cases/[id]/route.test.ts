import { beforeEach, describe, expect, it, vi } from "vitest"

const env = vi.hoisted(() => ({
  MYRA_OPERATOR_ENABLED: "1",
  NEXT_PUBLIC_APP_URL: "https://app.lyrashieldai.com",
}))
const requirePlatformAdminIdentity = vi.fn()
const requirePlatformAdmin = vi.fn()
const getOperatorCase = vi.fn()
const operatorTakeover = vi.fn()
const operatorRelease = vi.fn()
const operatorSetStatus = vi.fn()
const operatorAssign = vi.fn()
const executePlatformAdminMutation = vi.fn()
const bindMyraOperatorRLSContext = vi.fn()
const platformAdminAuditCreate = vi.fn()
const liveNonces = new Set<string>()
const mutationTx = { transaction: "nonce-and-audit" }

vi.mock("@lyrashield/config", () => ({ env }))
vi.mock("@lyrashield/auth/server", () => ({
  requirePlatformAdminIdentity,
  requirePlatformAdmin,
  getSession: vi.fn(),
}))
vi.mock("@lyrashield/myra/server", () => ({
  getOperatorCase,
  operatorTakeover,
  operatorRelease,
  operatorSetStatus,
  operatorAssign,
}))
vi.mock("@lyrashield/db", () => ({
  executePlatformAdminMutation: (...args: unknown[]) => executePlatformAdminMutation(...args),
  bindMyraOperatorRLSContext: (...args: unknown[]) => bindMyraOperatorRLSContext(...args),
  withMyraOperatorRLS: (_operatorId: string, fn: (tx: unknown) => unknown) => fn({}),
}))
vi.mock("@lyrashield/logger", () => ({
  setRequestId: vi.fn(),
  setRequestIdResolver: vi.fn(),
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))

const { GET, PATCH } = await import("./route")

const params = Promise.resolve({ id: "case-1" })
const VALID_NONCE = "A".repeat(43)

function patchRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://app.lyrashieldai.com/api/myra/operator/cases/case-1", {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      origin: "https://app.lyrashieldai.com",
      "sec-fetch-site": "same-origin",
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

function elevatedPatch(body: unknown) {
  return patchRequest(body, { "x-lyrashield-admin-elevation": VALID_NONCE })
}

function expectPrivateHeaders(response: Response) {
  expect(response.headers.get("Cache-Control")).toBe("private, no-store")
  expect(response.headers.get("Referrer-Policy")).toBe("no-referrer")
}

describe("/api/myra/operator/cases/[id] private headers", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    liveNonces.clear()
    env.MYRA_OPERATOR_ENABLED = "1"
    requirePlatformAdminIdentity.mockResolvedValue({
      userId: "operator-1",
      sessionId: "session-1",
    })
    requirePlatformAdmin.mockResolvedValue({ userId: "operator-1", sessionId: "session-1" })
    // Contract-faithful stand-in for the elevation primitive: the nonce is
    // single-use and the platform audit row is part of the same transaction.
    executePlatformAdminMutation.mockImplementation(
      async (
        input: {
          userId: string
          sessionId: string
          action: string
          nonce: string
          resourceType: string
          resourceId?: string
        },
        mutate: (tx: unknown) => Promise<unknown>
      ) => {
        if (!liveNonces.has(input.nonce)) throw new Error("ADMIN_ELEVATION_INVALID")
        liveNonces.delete(input.nonce)
        const result = await mutate(mutationTx)
        platformAdminAuditCreate({
          actorUserId: input.userId,
          sessionId: input.sessionId,
          action: input.action,
          resourceType: input.resourceType,
          resourceId: input.resourceId,
        })
        return result
      }
    )
  })

  it("marks a successful case read as private/no-store", async () => {
    getOperatorCase.mockResolvedValue({ id: "case-1" })
    const response = await GET(
      new Request("https://app.lyrashieldai.com/api/myra/operator/cases/case-1") as never,
      { params } as never
    )

    expect(response.status).toBe(200)
    expectPrivateHeaders(response)
  })

  it("marks mapped service failures as private/no-store", async () => {
    getOperatorCase.mockRejectedValue({ code: "NOT_FOUND" })
    const response = await GET(
      new Request("https://app.lyrashieldai.com/api/myra/operator/cases/missing") as never,
      { params } as never
    )

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({ error: { code: "NOT_FOUND" } })
    expectPrivateHeaders(response)
  })

  it("marks mutation auth failures as private/no-store", async () => {
    requirePlatformAdmin.mockRejectedValue(new Error("ADMIN_REAUTH_REQUIRED"))
    const response = await PATCH(
      elevatedPatch({ action: "takeover" }) as never,
      {
        params,
      } as never
    )

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "ADMIN_REAUTH_REQUIRED" },
    })
    expectPrivateHeaders(response)
  })

  it("marks mutation validation failures as private/no-store", async () => {
    const response = await PATCH(
      elevatedPatch({ action: "release" }) as never,
      {
        params,
      } as never
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_ERROR" },
    })
    expectPrivateHeaders(response)
    expect(operatorRelease).not.toHaveBeenCalled()
    expect(executePlatformAdminMutation).not.toHaveBeenCalled()
  })
})

describe("/api/myra/operator/cases/[id] elevation nonce", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    liveNonces.clear()
    env.MYRA_OPERATOR_ENABLED = "1"
    requirePlatformAdmin.mockResolvedValue({ userId: "operator-1", sessionId: "session-1" })
    executePlatformAdminMutation.mockImplementation(
      async (
        input: {
          userId: string
          sessionId: string
          action: string
          nonce: string
          resourceType: string
          resourceId?: string
        },
        mutate: (tx: unknown) => Promise<unknown>
      ) => {
        if (!liveNonces.has(input.nonce)) throw new Error("ADMIN_ELEVATION_INVALID")
        liveNonces.delete(input.nonce)
        const result = await mutate(mutationTx)
        platformAdminAuditCreate({
          actorUserId: input.userId,
          sessionId: input.sessionId,
          action: input.action,
          resourceType: input.resourceType,
          resourceId: input.resourceId,
        })
        return result
      }
    )
  })

  it("rejects a mutation without an elevation nonce", async () => {
    const response = await PATCH(
      patchRequest({ action: "takeover" }) as never,
      {
        params,
      } as never
    )

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "ADMIN_ELEVATION_REQUIRED" },
    })
    expectPrivateHeaders(response)
    expect(requirePlatformAdmin).not.toHaveBeenCalled()
    expect(executePlatformAdminMutation).not.toHaveBeenCalled()
    expect(operatorTakeover).not.toHaveBeenCalled()
  })

  it("rejects a consumed or unknown elevation nonce with 409", async () => {
    // VALID_NONCE is well-formed but was never issued (or already consumed).
    const response = await PATCH(
      elevatedPatch({ action: "takeover" }) as never,
      {
        params,
      } as never
    )

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "ADMIN_ELEVATION_INVALID" },
    })
    expectPrivateHeaders(response)
    expect(operatorTakeover).not.toHaveBeenCalled()
    expect(platformAdminAuditCreate).not.toHaveBeenCalled()
  })

  it("runs the mutation and writes the platform audit row with a fresh nonce", async () => {
    liveNonces.add(VALID_NONCE)
    operatorTakeover.mockResolvedValue({ takenOverAt: "2026-09-16T00:00:00.000Z" })

    const response = await PATCH(
      elevatedPatch({ action: "takeover" }) as never,
      {
        params,
      } as never
    )

    expect(response.status).toBe(200)
    expectPrivateHeaders(response)
    expect(executePlatformAdminMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "operator-1",
        sessionId: "session-1",
        action: "myra.case.takeover",
        nonce: VALID_NONCE,
        resourceType: "SupportCase",
        resourceId: "case-1",
      }),
      expect.any(Function)
    )
    expect(operatorTakeover).toHaveBeenCalledOnce()
    expect(bindMyraOperatorRLSContext).toHaveBeenCalledWith(mutationTx, "operator-1")
    expect(operatorTakeover).toHaveBeenCalledWith("operator-1", "case-1", mutationTx)
    expect(platformAdminAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: "operator-1",
        sessionId: "session-1",
        action: "myra.case.takeover",
        resourceType: "SupportCase",
        resourceId: "case-1",
      })
    )
  })

  it("maps each PATCH action to its registered elevation action", async () => {
    for (const [action, expected] of [
      ["release", "myra.case.release"],
      ["resolve", "myra.case.resolve"],
      ["assign", "myra.case.assign"],
    ] as const) {
      vi.clearAllMocks()
      liveNonces.clear()
      requirePlatformAdmin.mockResolvedValue({ userId: "operator-1", sessionId: "session-1" })
      liveNonces.add(VALID_NONCE)
      operatorRelease.mockResolvedValue({ released: true })
      operatorSetStatus.mockResolvedValue({ status: "RESOLVED" })
      operatorAssign.mockResolvedValue({ assigneeUserId: "operator-1" })
      executePlatformAdminMutation.mockImplementation(
        async (input: { nonce: string }, mutate: (tx: unknown) => Promise<unknown>) => {
          if (!liveNonces.has(input.nonce)) throw new Error("ADMIN_ELEVATION_INVALID")
          liveNonces.delete(input.nonce)
          return mutate({})
        }
      )

      const response = await PATCH(
        elevatedPatch(
          action === "release" ? { action, handoffSummary: "Reviewed handoff notes" } : { action }
        ) as never,
        { params } as never
      )

      expect(response.status).toBe(200)
      expect(executePlatformAdminMutation).toHaveBeenCalledWith(
        expect.objectContaining({ action: expected }),
        expect.any(Function)
      )
    }
  })
})
