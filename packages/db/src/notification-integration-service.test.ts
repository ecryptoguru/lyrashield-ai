import { beforeEach, describe, expect, it, vi } from "vitest"

const tx = vi.hoisted(() => ({
  $executeRaw: vi.fn(),
  integration: { findFirst: vi.fn(), findMany: vi.fn(), upsert: vi.fn(), updateMany: vi.fn() },
}))
const rls = vi.hoisted(() => ({ withWorkspaceRLS: vi.fn() }))
vi.mock("./rls", () => rls)
import {
  listNotificationIntegrations,
  getWorkspaceNotificationChannels,
  saveNotificationIntegration,
  disableNotificationIntegration,
  withActiveWorkspaceNotificationDestination,
} from "./notification-integration-service"

const row = {
  id: "integration-1",
  type: "SLACK",
  name: "Slack",
  status: "active",
  configRef: "s3://private/secret",
  externalId: "notifications:ws-1:slack",
  updatedAt: new Date(),
}

describe("workspace notification integrations", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    rls.withWorkspaceRLS.mockImplementation(async (_id, fn) => fn(tx))
    tx.integration.findMany.mockResolvedValue([row])
    tx.integration.findFirst.mockResolvedValue(row)
    tx.integration.upsert.mockResolvedValue(row)
    tx.integration.updateMany.mockResolvedValue({ count: 1 })
  })

  it("returns safe summaries and confines its query to workspace notification identities", async () => {
    const summaries = await listNotificationIntegrations("ws-1")
    expect(summaries).toEqual([
      { id: row.id, channel: "slack", name: "Slack", status: "active", updatedAt: row.updatedAt },
    ])
    expect(JSON.stringify(summaries)).not.toContain("s3:")
    expect(tx.integration.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          workspaceId: "ws-1",
          deletedAt: null,
          OR: [
            { type: "SLACK", externalId: "notifications:ws-1:slack" },
            { type: "DISCORD", externalId: "notifications:ws-1:discord" },
          ],
        }),
      })
    )
  })

  it("resolves only active notification credentials for delivery", async () => {
    expect(await getWorkspaceNotificationChannels("ws-1")).toEqual([
      { channel: "slack", configRef: row.configRef },
    ])
    expect(tx.integration.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          workspaceId: "ws-1",
          status: "active",
          configRef: { not: null },
        }),
      })
    )
  })

  it("reconnects the same purpose-specific identity and returns prior sealed reference for cleanup", async () => {
    const result = await saveNotificationIntegration({
      workspaceId: "ws-1",
      channel: "slack",
      configRef: "s3://private/new",
    })
    expect(result.previousConfigRef).toBe(row.configRef)
    expect(result.integration.channel).toBe("slack")
    expect(tx.$executeRaw).toHaveBeenCalled()
    expect(tx.integration.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          workspaceId_type_externalId: {
            workspaceId: "ws-1",
            type: "SLACK",
            externalId: "notifications:ws-1:slack",
          },
        },
        create: expect.objectContaining({
          workspaceId: "ws-1",
          type: "SLACK",
          externalId: "notifications:ws-1:slack",
          configRef: "s3://private/new",
        }),
        update: expect.objectContaining({ status: "active", deletedAt: null }),
      })
    )
  })

  it("retires the sealed credential while preserving identity for reconnect", async () => {
    tx.integration.findFirst
      .mockResolvedValueOnce(row)
      .mockResolvedValueOnce({ ...row, status: "disabled", configRef: null })
    const result = await disableNotificationIntegration("ws-1", "slack")
    expect(result?.integration.status).toBe("disabled")
    expect(result?.previousConfigRef).toBe(row.configRef)
    expect(JSON.stringify(result?.integration)).not.toContain("s3:")
    expect(tx.integration.updateMany).toHaveBeenCalledWith({
      where: {
        workspaceId: "ws-1",
        type: "SLACK",
        externalId: "notifications:ws-1:slack",
        deletedAt: null,
      },
      data: { status: "disabled", configRef: null },
    })
  })

  it("does not manufacture a disabled integration for an unconfigured workspace", async () => {
    tx.integration.findFirst.mockResolvedValue(null)
    expect(await disableNotificationIntegration("ws-2", "discord")).toBeNull()
    expect(tx.integration.updateMany).not.toHaveBeenCalled()
  })

  it("repeated disconnect has no credential to retire", async () => {
    tx.integration.findFirst.mockResolvedValue({ ...row, status: "disabled", configRef: null })
    expect((await disableNotificationIntegration("ws-1", "slack"))?.previousConfigRef).toBeNull()
  })

  it("locks before resolving active credentials and holds the lock until delivery finishes", async () => {
    const send = vi.fn().mockResolvedValue(true)
    await expect(withActiveWorkspaceNotificationDestination("ws-1", "slack", send)).resolves.toBe(
      true
    )
    expect(tx.integration.findFirst).toHaveBeenCalledWith({
      where: {
        workspaceId: "ws-1",
        type: "SLACK",
        externalId: "notifications:ws-1:slack",
        deletedAt: null,
        status: "active",
        configRef: { not: null },
      },
      select: { configRef: true },
    })
    expect(send).toHaveBeenCalledWith(row.configRef)
    expect(tx.$executeRaw.mock.invocationCallOrder.at(-1)).toBeLessThan(
      tx.integration.findFirst.mock.invocationCallOrder.at(-1)!
    )
    expect(rls.withWorkspaceRLS).toHaveBeenCalledWith("ws-1", expect.any(Function), {
      maxWait: 5000,
      timeout: 60000,
    })
  })

  it("skips a disabled destination without reading or sending its secret", async () => {
    tx.integration.findFirst.mockResolvedValue(null)
    const send = vi.fn()
    expect(await withActiveWorkspaceNotificationDestination("ws-1", "slack", send)).toBeNull()
    expect(send).not.toHaveBeenCalled()
  })

  it("serializes rotation and disable against a started delivery through the same purpose lock", async () => {
    let current: Omit<typeof row, "configRef"> & { configRef: string | null } = { ...row }
    let lockTail = Promise.resolve()
    rls.withWorkspaceRLS.mockImplementation(async (_id, fn) => {
      let release: (() => void) | undefined
      const transaction = {
        ...tx,
        $executeRaw: vi.fn(async (sql: TemplateStringsArray) => {
          if (!sql[0].includes("pg_advisory_xact_lock")) return 0
          const prior = lockTail
          lockTail = new Promise<void>((resolve) => {
            release = resolve
          })
          await prior
          return 0
        }),
      }
      try {
        return await fn(transaction)
      } finally {
        release?.()
      }
    })
    tx.integration.findFirst.mockImplementation(async (args) =>
      args.where.status === "active" && current.status !== "active" ? null : { ...current }
    )
    tx.integration.upsert.mockImplementation(async (args) => {
      current = { ...current, ...args.update }
      return { ...current }
    })
    tx.integration.updateMany.mockImplementation(async (args) => {
      current = { ...current, ...args.data }
      return { count: 1 }
    })
    let finishSend!: () => void
    let sendStarted!: () => void
    const started = new Promise<void>((resolve) => {
      sendStarted = resolve
    })
    const sending = withActiveWorkspaceNotificationDestination(
      "ws-1",
      "slack",
      async (configRef) => {
        expect(configRef).toBe(row.configRef)
        sendStarted()
        await new Promise<void>((resolve) => {
          finishSend = resolve
        })
        return true
      }
    )
    await started
    const rotating = saveNotificationIntegration({
      workspaceId: "ws-1",
      channel: "slack",
      configRef: "s3://private/new",
    })
    const disabling = disableNotificationIntegration("ws-1", "slack")
    await Promise.resolve()
    expect(tx.integration.upsert).not.toHaveBeenCalled()
    expect(tx.integration.updateMany).not.toHaveBeenCalled()
    finishSend()
    expect(await sending).toBe(true)
    expect((await rotating).previousConfigRef).toBe(row.configRef)
    const disabled = await disabling
    expect(disabled?.integration.status).toBe("disabled")
    expect(disabled?.previousConfigRef).toBe("s3://private/new")
    expect(current.configRef).toBeNull()
    const lateSend = vi.fn()
    expect(await withActiveWorkspaceNotificationDestination("ws-1", "slack", lateSend)).toBeNull()
    expect(lateSend).not.toHaveBeenCalled()
    const reconnected = await saveNotificationIntegration({
      workspaceId: "ws-1",
      channel: "slack",
      configRef: "s3://private/reconnected",
    })
    expect(reconnected.previousConfigRef).toBeNull()
    expect(reconnected.integration.id).toBe(row.id)
    expect(current.status).toBe("active")
    expect(current.configRef).toBe("s3://private/reconnected")
  })
})
