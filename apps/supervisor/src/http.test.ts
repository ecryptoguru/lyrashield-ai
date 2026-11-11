import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  SignedJournal,
  type ProviderGrantRevocation,
  type ProviderGrantStatus,
  type ResourceInspection,
  type ResourceOwnership,
  type SupervisorPort,
} from "@lyrashield/runtime-control"
import type { RuntimeExecutor } from "./executor"
import { createSupervisorHandler } from "./http"
import { SupervisorService, supervisorJournalEventSchema } from "./service"

const roots: string[] = []
const secret = "h".repeat(48)
const control = "c".repeat(48)

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

class NoopExecutor implements RuntimeExecutor {
  async create(): Promise<ResourceOwnership> {
    throw new Error("closed admission must not create")
  }
  async start(ownership: ResourceOwnership): Promise<ResourceOwnership> {
    return ownership
  }
  async inspect(): Promise<ResourceInspection> {
    return { state: "ABSENT" }
  }
  async stop(): Promise<ResourceInspection> {
    return { state: "ABSENT" }
  }
}

class NoopGateway implements SupervisorPort {
  async issueGrant(): Promise<never> {
    throw new Error("closed admission must not issue")
  }
  async findGrantByRequest(): Promise<never> {
    throw new Error("closed admission must not inspect")
  }
  async revokeGrant(_request: ProviderGrantRevocation): Promise<ProviderGrantStatus> {
    throw new Error("closed admission must not revoke")
  }
  async inspectGrant(): Promise<null> {
    return null
  }
}

describe("supervisor HTTP boundary", () => {
  it("requires control authentication and keeps command admission closed by default", async () => {
    const root = await mkdtemp(join(tmpdir(), "supervisor-http-test-"))
    roots.push(root)
    const journal = new SignedJournal(join(root, "journal.jsonl"), secret, (value) =>
      supervisorJournalEventSchema.parse(value)
    )
    const service = new SupervisorService({
      journal,
      executor: new NoopExecutor(),
      providerGateway: new NoopGateway(),
      providerGatewayUrl: "http://127.0.0.1:1",
      signingSecret: secret,
      supervisorInstanceId: "supervisor-http-1",
      admission: "closed",
      policy: {
        allowedImages: new Set(),
        allowedNetworks: new Set(),
        allowedProcessCommands: new Set(),
        allowedCwdRoots: [tmpdir()],
        allowedCgroupRoot: tmpdir(),
      },
    })
    const server = createServer(
      createSupervisorHandler(service, { controlToken: control, admission: "closed" })
    )
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("test server has no port")
    const base = `http://127.0.0.1:${address.port}`
    try {
      const health = await fetch(`${base}/healthz`)
      expect(await health.json()).toEqual({ status: "ok", admission: "closed" })
      const unauthorized = await fetch(`${base}/v1/commands`, { method: "POST", body: "{}" })
      expect(unauthorized.status).toBe(401)
      const closed = await fetch(`${base}/v1/commands`, {
        method: "POST",
        headers: { authorization: `Bearer ${control}`, "content-type": "application/json" },
        body: JSON.stringify({
          type: "START_UNMETERED",
          commandId: "cmd-http",
          attemptId: "attempt-http",
          executorKey: "scanner",
          expectedReceiptHash: "a".repeat(64),
        }),
      })
      expect(closed.status).toBe(403)
      expect(await closed.json()).toMatchObject({ code: "ADMISSION_CLOSED" })
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  })
})
