import { beforeEach, describe, expect, it, vi } from "vitest"

const env = vi.hoisted(() => ({
  MYRA_OPERATOR_ENABLED: "1",
  NEXT_PUBLIC_APP_URL: "https://app.lyrashieldai.com",
}))
const requirePlatformAdmin = vi.fn()
const operatorReply = vi.fn()
const executePlatformAdminMutation = vi.fn()
const bindMyraOperatorRLSContext = vi.fn()
const platformAdminAuditCreate = vi.fn()
const liveNonces = new Set<string>()
const mutationTx = { transaction: "nonce-and-audit" }

vi.mock("@lyrashield/config", () => ({ env }))
vi.mock("@lyrashield/auth/server", () => ({
  requirePlatformAdmin,
  getSession: vi.fn(),
}))
vi.mock("@lyrashield/myra/server", () => ({ operatorReply }))
vi.mock("@lyrashield/db", () => ({
  executePlatformAdminMutation: (...args: unknown[]) => executePlatformAdminMutation(...args),
  bindMyraOperatorRLSContext: (...args: unknown[]) => bindMyraOperatorRLSContext(...args),
}))
vi.mock("@lyrashield/logger", () => ({
  setRequestId: vi.fn(),
  setRequestIdResolver: vi.fn(),
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))

const { POST } = await import("./route")

const params = Promise.resolve({ id: "case-1" })
const VALID_NONCE = "B".repeat(43)

function postRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://app.lyrashieldai.com/api/myra/operator/cases/case-1/replies", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://app.lyrashieldai.com",
      "sec-fetch-site": "same-origin",
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

function elevatedPost(body: unknown) {
  return postRequest(body, { "x-lyrashield-admin-elevation": VALID_NONCE })
}

function expectPrivateHeaders(response: Response) {
  expect(response.headers.get("Cache-Control")).toBe("private, no-store")
  expect(response.headers.get("Referrer-Policy")).toBe("no-referrer")
}

describe("POST /api/myra/operator/cases/[id]/replies elevation nonce", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    liveNonces.clear()
    env.MYRA_OPERATOR_ENABLED = "1"
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

  it("rejects a reply without an elevation nonce", async () => {
    const response = await POST(postRequest({ body: "Hello" }) as never, { params } as never)

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "ADMIN_ELEVATION_REQUIRED" },
    })
    expectPrivateHeaders(response)
    expect(requirePlatformAdmin).not.toHaveBeenCalled()
    expect(operatorReply).not.toHaveBeenCalled()
  })

  it("rejects a consumed or unknown elevation nonce with 409", async () => {
    const response = await POST(elevatedPost({ body: "Hello" }) as never, { params } as never)

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "ADMIN_ELEVATION_INVALID" },
    })
    expectPrivateHeaders(response)
    expect(operatorReply).not.toHaveBeenCalled()
    expect(platformAdminAuditCreate).not.toHaveBeenCalled()
  })

  it("sends the reply and writes the platform audit row with a fresh nonce", async () => {
    liveNonces.add(VALID_NONCE)
    operatorReply.mockResolvedValue({ id: "reply-1", createdAt: "2026-09-16T00:00:00.000Z" })

    const response = await POST(elevatedPost({ body: "Hello" }) as never, { params } as never)

    expect(response.status).toBe(200)
    expectPrivateHeaders(response)
    expect(executePlatformAdminMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "operator-1",
        sessionId: "session-1",
        action: "myra.case.reply",
        nonce: VALID_NONCE,
        resourceType: "SupportCase",
        resourceId: "case-1",
      }),
      expect.any(Function)
    )
    expect(operatorReply).toHaveBeenCalledOnce()
    expect(bindMyraOperatorRLSContext).toHaveBeenCalledWith(mutationTx, "operator-1")
    expect(operatorReply).toHaveBeenCalledWith("operator-1", "case-1", "Hello", mutationTx)
    expect(platformAdminAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: "operator-1",
        action: "myra.case.reply",
        resourceType: "SupportCase",
        resourceId: "case-1",
      })
    )
  })

  it("marks mutation auth failures as private/no-store", async () => {
    requirePlatformAdmin.mockRejectedValue(new Error("ADMIN_REAUTH_REQUIRED"))
    const response = await POST(elevatedPost({ body: "Hello" }) as never, { params } as never)

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "ADMIN_REAUTH_REQUIRED" },
    })
    expectPrivateHeaders(response)
    expect(operatorReply).not.toHaveBeenCalled()
  })

  it("marks validation failures as private/no-store", async () => {
    const response = await POST(elevatedPost({ body: "" }) as never, { params } as never)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_ERROR" },
    })
    expectPrivateHeaders(response)
    expect(executePlatformAdminMutation).not.toHaveBeenCalled()
    expect(operatorReply).not.toHaveBeenCalled()
  })
})
