import { beforeEach, describe, expect, it, vi } from "vitest"

const verifyWebhookSignature = vi.fn()
const tx = {
  webhookEvent: { create: vi.fn() },
  integration: { update: vi.fn() },
  target: { updateMany: vi.fn() },
}
const systemPrisma = {
  webhookEvent: { findUnique: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
  integration: { findFirst: vi.fn() },
  $transaction: vi.fn(),
}
const prisma = { auditLog: { create: vi.fn() } }

vi.mock("@lyrashield/db", () => ({ getSystemPrisma: () => systemPrisma, prisma }))
vi.mock("@lyrashield/integrations", () => ({ verifyWebhookSignature }))
vi.mock("@lyrashield/logger", () => ({ logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn() } }))

const { POST } = await import("./route")

function installationDeletedRequest() {
  return new Request("http://localhost/api/webhooks/github", {
    method: "POST",
    headers: {
      "x-hub-signature-256": "sha256=valid",
      "x-github-event": "installation",
      "x-github-delivery": "delivery-1",
    },
    body: JSON.stringify({
      action: "deleted",
      installation: { id: 42, account: { login: "acme" } },
    }),
  })
}

describe("GitHub installation webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    verifyWebhookSignature.mockReturnValue(true)
    systemPrisma.webhookEvent.findUnique.mockResolvedValue(null)
    systemPrisma.integration.findFirst.mockResolvedValue({
      id: "integration-1",
      workspaceId: "workspace-1",
    })
    systemPrisma.$transaction.mockImplementation(async (callback) => callback(tx))
  })

  it("records the delivery atomically before disconnecting an installation", async () => {
    const response = await POST(installationDeletedRequest() as never)

    expect(response.status).toBe(200)
    expect(tx.webhookEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          workspaceId: "workspace-1",
          externalId: "delivery-1",
          eventType: "installation.deleted",
        }),
      })
    )
    expect(tx.integration.update).toHaveBeenCalled()
    expect(tx.target.updateMany).toHaveBeenCalled()
    expect(prisma.auditLog.create).toHaveBeenCalled()
  })

  it("treats a concurrent delivery as an idempotent success", async () => {
    systemPrisma.$transaction.mockRejectedValue({ code: "P2002" })

    const response = await POST(installationDeletedRequest() as never)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ data: { duplicate: true } })
  })

  it("removes the delivery marker and retries when audit retention fails", async () => {
    prisma.auditLog.create.mockRejectedValueOnce(new Error("audit unavailable"))

    const response = await POST(installationDeletedRequest() as never)

    expect(response.status).toBe(500)
    expect(systemPrisma.webhookEvent.deleteMany).toHaveBeenCalledWith({
      where: { provider: "github", externalId: "delivery-1" },
    })
  })

  it("rejects a signed malformed pull request payload without retrying", async () => {
    const request = new Request("http://localhost/api/webhooks/github", {
      method: "POST",
      headers: {
        "x-hub-signature-256": "sha256=valid",
        "x-github-event": "pull_request",
        "x-github-delivery": "delivery-2",
      },
      body: JSON.stringify({ action: "opened" }),
    })

    const response = await POST(request as never)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: { code: "INVALID_PAYLOAD" } })
    expect(systemPrisma.webhookEvent.findUnique).toHaveBeenCalled()
    expect(systemPrisma.$transaction).not.toHaveBeenCalled()
  })
})
