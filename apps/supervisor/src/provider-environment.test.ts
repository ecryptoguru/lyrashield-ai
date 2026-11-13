import { fixtureAuthorityFence } from "./test-fixtures"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  SignedJournal,
  type ExecutorSpec,
  type ResourceOwnership,
} from "@lyrashield/runtime-control"
import { deriveOwnershipId, DockerRuntimeExecutor, type ExecutorContext } from "./executor"
import { providerEnvironment } from "./provider-environment"
import { SupervisorService, supervisorJournalEventSchema } from "./service"

const token = "synthetic-grant-" + "x".repeat(48)
const secret = "s".repeat(48)
const now = new Date("2026-11-05T10:00:00.000Z")
const expiresAt = "2026-11-05T11:00:00.000Z"
const image = `ghcr.io/ecryptoguru/lyrashield-sandbox@sha256:${"a".repeat(64)}`
const spec: ExecutorSpec = {
  kind: "container",
  image,
  argv: ["lyrashield"],
  env: { MODE: "synthetic" },
  network: "sandbox",
  cpus: 2,
  memoryMb: 4096,
  pidsLimit: 512,
  readOnly: true,
  grantEnvName: "LLM_API_KEY",
}
const context: ExecutorContext = {
  attemptId: "attempt-1",
  commandId: "start-1",
  assertActive: () => undefined,
  provider: {
    token,
    providerId: "azure-ai",
    gatewayUrl: "https://gateway.internal:8791",
    scanId: "scan-1",
  },
}
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe("scan-bound provider grant delivery", () => {
  it("passes the grant through the Docker process environment, not its arguments", () => {
    vi.stubEnv("AZURE_AI_API_KEY", "ambient-secret")
    try {
      const result = providerEnvironment(spec, context)
      expect(result.env?.LLM_API_KEY).toBe(token)
      expect(result.env?.AZURE_AI_API_KEY).toBeUndefined()
      expect(result.args).toContain("LLM_API_KEY")
      expect(result.args).toContain(
        "LLM_API_BASE=https://gateway.internal:8791/v1/provider/azure-ai"
      )
      expect(result.args).toContain(
        "LYRASHIELD_PROVIDER_GATEWAY_ORIGIN=https://gateway.internal:8791"
      )
      expect(result.args).toContain("STRIX_RUN_ID=scan-1")
      expect(result.args.join(" ")).not.toContain(token)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it.each([
    {
      ...context,
      provider: { ...context.provider!, gatewayUrl: "http://user:secret@gateway.internal" },
    },
    { ...context, provider: { ...context.provider!, gatewayUrl: "http://gateway.internal/path" } },
    { ...context, provider: { ...context.provider!, gatewayUrl: "http://gateway.internal:8791" } },
    { ...context, provider: { ...context.provider!, gatewayUrl: "http://localhost:8791" } },
    { ...context, provider: { ...context.provider!, token: "invalid\nsecret" } },
    { ...context, provider: { ...context.provider!, scanId: "other/scan" } },
    { ...context, provider: { ...context.provider!, scanId: "other..scan" } },
  ])("rejects malformed gateway bindings", (invalid) => {
    expect(() => providerEnvironment(spec, invalid)).toThrow(/invalid scan-bound/)
  })

  it.each(["http://127.0.0.1:8791", "http://[::1]:8791", "https://gateway.internal:8791"])(
    "allows encrypted or explicit loopback gateways: %s",
    (gatewayUrl) => {
      const configured = { ...context, provider: { ...context.provider!, gatewayUrl } }
      expect(() => providerEnvironment(spec, configured)).not.toThrow()
    }
  )

  it("rejects caller-provided provider routes and credentials", () => {
    for (const name of [
      "LLM_API_BASE",
      "LYRASHIELD_PROVIDER_GATEWAY_ORIGIN",
      "STRIX_RUN_ID",
      "LLM_API_KEY",
      "LYRASHIELD_DEDUPE_LLM_API_KEY",
      "LYRASHIELD_DEDUPE_LLM_API_BASE",
      "DEDUPE_LLM_EXTRA_HEADERS",
      "LYRASHIELD_EXTRA_HEADERS",
      "HTTPS_PROXY",
      "https_proxy",
      "SSL_CERT_FILE",
      "PYTHONPATH",
    ])
      expect(() => providerEnvironment({ ...spec, env: { [name]: "spoofed" } }, context)).toThrow()
  })

  it("invokes Docker with a scoped grant and no ambient provider credential", async () => {
    const root = await mkdtemp(join(tmpdir(), "supervisor-docker-"))
    roots.push(root)
    const command = join(root, "docker")
    const capture = join(root, "capture.json")
    await writeFile(
      command,
      `#!/usr/bin/env node\nconst fs = require('node:fs');\nif (process.argv[2] === 'create') { fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({args: process.argv.slice(2), grant: process.env.LLM_API_KEY, ambient: process.env.AZURE_AI_API_KEY})); process.stdout.write('b'.repeat(64)); }\n`
    )
    await chmod(command, 0o700)
    vi.stubEnv("PATH", `${root}:${process.env.PATH}`)
    vi.stubEnv("AZURE_AI_API_KEY", "ambient-secret")
    try {
      await new DockerRuntimeExecutor().create("engine", spec, context)
      const recorded = JSON.parse(await readFile(capture, "utf8")) as {
        args: string[]
        grant: string
        ambient?: string
      }
      expect(recorded.grant).toBe(token)
      expect(recorded.ambient).toBeUndefined()
      expect(recorded.args.join(" ")).not.toContain(token)
      expect(recorded.args).toContain("LLM_API_KEY")
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it.each([false, true])(
    "keeps the grant out of journal even when executor failure=%s",
    async (fail) => {
      const root = await mkdtemp(join(tmpdir(), "supervisor-provider-"))
      roots.push(root)
      const journal = new SignedJournal(join(root, "journal.jsonl"), secret, (value) =>
        supervisorJournalEventSchema.parse(value)
      )
      const create = vi.fn(async (key: "engine", _spec: ExecutorSpec, value: ExecutorContext) => {
        if (fail) throw new Error(`synthetic executor failure: ${value.provider?.token}`)
        return {
          executorKey: key,
          kind: "container" as const,
          ownershipId: deriveOwnershipId(value.attemptId, value.commandId, key),
          containerId: "b".repeat(64),
        }
      })
      const start = vi.fn(
        async (ownership: ResourceOwnership, _spec: ExecutorSpec, _context: ExecutorContext) =>
          ownership
      )
      const service = new SupervisorService({
        journal,
        authorityFence: fixtureAuthorityFence,
        signingSecret: secret,
        supervisorInstanceId: "supervisor-1",
        admission: "open",
        now: () => now,
        providerGatewayUrl: "https://gateway.internal:8791",
        policy: {
          allowedImages: new Set([image]),
          allowedNetworks: new Set(["sandbox"]),
          allowedProcessCommands: new Set(),
          allowedCwdRoots: [],
          allowedCgroupRoot: "/tmp",
        },
        executor: {
          create,
          start,
          inspect: async () => ({ state: "ABSENT" }),
          stop: async () => ({ state: "ABSENT" }),
        },
        providerGateway: {
          issueGrant: async (request) => ({
            grantId: "grant-1",
            token,
            attemptId: request.attemptId,
            providerId: request.providerId,
            expiresAt: request.expiresAt,
            receipt: "a".repeat(64),
          }),
          findGrantByRequest: async () => null,
          revokeGrant: async () => {
            throw new Error("not called")
          },
          inspectGrant: async () => null,
        },
      })
      const prepared = await service.execute({
        type: "PREPARE",
        commandId: "prepare-1",
        attempt: {
          attemptId: "attempt-1",
          scanId: "scan-1",
          workspaceId: "workspace-1",
          operationId: "operation-1",
          authorityEpochId: "epoch-1",
          authorityRevision: 1,
          workerIdentity: "worker-1",
          billingMode: "PAID",
          expiresAt,
        },
        executors: [{ key: "engine", spec }],
        provider: {
          providerId: "azure-ai",
          maxRequests: 1,
          costReservationMicros: 0,
          maxReservedCostMicros: 1_000,
        },
      })
      const started = await service.execute({
        type: "START_PAID",
        commandId: "start-1",
        attemptId: "attempt-1",
        executorKey: "engine",
        expectedReceiptHash: prepared.receipt.hash,
      })
      expect(started.status).toBe(fail ? "UNKNOWN" : "STARTED")
      expect(create.mock.calls[0]?.[2].provider).toEqual(context.provider)
      if (fail) expect(start).not.toHaveBeenCalled()
      else expect(start.mock.calls[0]?.[2].provider).toBeUndefined()
      expect(JSON.stringify(await journal.load())).not.toContain(token)
      await journal.close()
    }
  )
})
