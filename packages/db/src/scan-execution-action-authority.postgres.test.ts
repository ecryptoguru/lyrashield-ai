import pg from "pg"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import {
  canonicalJson,
  PostgresDurableScanAuthorityFence,
  sha256Hex,
  type AuthorityAction,
  type AuthoritySqlConnection,
} from "@lyrashield/runtime-control"
import { createScanDispatchAuthorityBroker } from "./scan-dispatch-authority-broker"
import { createScanExecutionActionAuthorityVerifier } from "./scan-execution-action-intent"
import { createScanExecutionInvocationGuardWriter } from "./scan-execution-invocation-guard"
import { readStoredDispatchCommand } from "./scan-dispatch-command-descriptor"
import {
  applyPreparationFixtureMigration,
  installPreparationFixtureRole,
  preparationFixture,
  preparationInput,
} from "../scripts/tests/scan-preparation-fixture"
import { queueFixtureWorker } from "../scripts/tests/queue-outbox-fixture"

// Hoisting runs this guard before imports can construct a client from ambient
// env. Bind the fixture's privileged DATABASE_URL role to its restricted
// preparation broker role through the shared disposable-pair guard.
await vi.hoisted(async () => {
  const runtime = process.env.DISPATCH_PREPARATION_BROKER_DATABASE_URL
  if (process.env.LYRASHIELD_TEST_DB_DISPOSABLE !== "1" || !runtime) return
  const { assertDisposableDatabasePair } =
    await import("../../../.github/scripts/vitest-database-env.mjs")
  assertDisposableDatabasePair({ ...process.env, RLS_RUNTIME_DATABASE_URL: runtime })
})

const enabled =
  process.env.SCAN_DISPATCH_AUTHORITY_POSTGRES_TEST === "1" &&
  process.env.LYRASHIELD_TEST_DB_DISPOSABLE === "1"
let owner: pg.Pool, control: pg.Pool
let broker: ReturnType<typeof createScanDispatchAuthorityBroker>
const worker = queueFixtureWorker()
const verify = createScanExecutionActionAuthorityVerifier({ approvedProviderPolicies: new Map() })
function sqlConnection(client: pg.PoolClient): AuthoritySqlConnection {
  return {
    query: async (text, values) => client.query(text, values),
    release: () => {
      throw new Error("fixture owns connection")
    },
  }
}
async function fixture() {
  const f = await preparationFixture(owner, 0)
  const prepared = await broker.prepare(preparationInput(f))
  if (prepared.kind !== "committed") throw new Error("fixture preparation unavailable")
  const row = (
    await owner.query('SELECT * FROM "ScanDispatchOutbox" WHERE id=$1', [prepared.commandId])
  ).rows[0]
  const command = readStoredDispatchCommand(row.commandInputJson, row.commandInputChecksum)
  if (!command || command.type !== "PREPARE") throw new Error("fixture descriptor unavailable")
  const binding: AuthorityAction = {
    phase: "PREPARE",
    commandId: command.commandId,
    operationId: f.operationId,
    attemptId: prepared.attemptId,
    scanId: f.scanId,
    workspaceId: f.workspaceId,
    authorityEpochId: f.epochId,
    authorityRevision: command.attempt.authorityRevision,
    authorityChecksum: sha256Hex(
      canonicalJson({
        attempt: command.attempt,
        executors: command.executors,
        provider: command.provider ?? null,
      })
    ),
    actionChecksum: row.commandInputChecksum,
  }
  return { f, binding }
}
async function fenced<T>(work: (connection: AuthoritySqlConnection) => Promise<T>) {
  const client = await control.connect()
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED")
    expect(
      (await client.query("SELECT app.acquire_scan_preparation_gate() AS acquired")).rows[0]
        .acquired
    ).toBe(true)
    return await work(sqlConnection(client))
  } finally {
    await client.query("ROLLBACK")
    client.release()
  }
}

async function dockerRequest(
  socketPath: string,
  method: "GET" | "POST",
  path: string,
  input?: object
) {
  const bytes = input ? Buffer.from(JSON.stringify(input)) : undefined
  return new Promise<unknown>((resolve, reject) => {
    const request = httpRequest(
      {
        socketPath,
        method,
        path: `/v1.41${path}`,
        ...(bytes
          ? { headers: { "content-type": "application/json", "content-length": bytes.byteLength } }
          : {}),
        timeout: 10_000,
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on("data", (chunk: Buffer) => chunks.push(chunk))
        response.on("error", reject)
        response.on("end", () => {
          if (response.statusCode !== 200 && response.statusCode !== 201) {
            reject(new Error("fixture Docker request failed"))
            return
          }
          try {
            const text = Buffer.concat(chunks).toString("utf8")
            resolve(text ? JSON.parse(text) : null)
          } catch (error) {
            reject(error)
          }
        })
      }
    )
    request.on("timeout", () => request.destroy(new Error("fixture Docker request timed out")))
    request.on("error", reject)
    request.end(bytes)
  })
}
describe.skipIf(!enabled)("current native action authority and durable invocation hold", () => {
  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: process.env.DATABASE_URL })
    await worker.open()
    await applyPreparationFixtureMigration(owner)
    await installPreparationFixtureRole(owner)
    await owner.query(
      'GRANT SELECT,INSERT ON "ScanExecutionInvocationGuard" TO dispatch_prepare_broker;GRANT SELECT ON "ScanExecutionInvocationResolution","ScanExecutionActionIntent" TO dispatch_prepare_broker'
    )
    control = new pg.Pool({
      connectionString: process.env.DISPATCH_PREPARATION_BROKER_DATABASE_URL,
    })
    broker = createScanDispatchAuthorityBroker({
      connectionString: process.env.DISPATCH_PREPARATION_BROKER_DATABASE_URL!,
      preparationAuthority: "checked-intent-v1",
      compilePreparation: () => ({
        executors: [
          {
            key: "engine",
            spec: {
              kind: "process",
              command: "/opt/fixture-only-engine",
              args: [],
              cwd: "/var/lib/fixture-only",
              cgroupPath: "/sys/fs/cgroup/fixture-only",
              env: {},
              grantEnvName: "LLM_API_KEY",
            },
          },
        ],
      }),
    })
  }, 30000)
  afterAll(async () => {
    await broker?.close()
    await control?.end()
    await owner?.end()
    await worker.close()
  })
  it("verifies exact persisted PREPARE on its real restricted native connection", async () => {
    const { binding } = await fixture()
    const result = await fenced((c) => verify(c, binding))
    expect(result.deadlineAt.getTime()).toBeGreaterThan(Date.now())
  })
  it("rejects changed action hash and wrong workspace identity", async () => {
    const { binding } = await fixture()
    await expect(
      fenced((c) => verify(c, { ...binding, actionChecksum: "f".repeat(64) }))
    ).rejects.toThrow()
    await expect(
      fenced((c) => verify(c, { ...binding, workspaceId: "other-workspace" }))
    ).rejects.toThrow()
  })
  it("rejects current membership revocation, expired grant and stale epoch", async () => {
    for (const mutation of [
      'UPDATE "WorkspaceMember" SET status=\'revoked\' WHERE "workspaceId"=$1',
      'UPDATE "ScanWorkerInstanceGrant" SET "revokedAt"=CURRENT_TIMESTAMP WHERE id=$1',
    ]) {
      const { f, binding } = await fixture()
      const id = mutation.includes("WorkspaceMember") ? f.workspaceId : f.grantId
      await owner.query(mutation, [id])
      await expect(fenced((c) => verify(c, binding))).rejects.toThrow()
    }
    const { binding } = await fixture()
    await expect(
      fenced((c) => verify(c, { ...binding, authorityEpochId: "stale-epoch" }))
    ).rejects.toThrow()
  })
  it("unsupported runtime phase remains closed without its exact approved command", async () => {
    const { binding } = await fixture()
    await expect(
      fenced((c) => verify(c, { ...binding, phase: "EXECUTOR_START", executorKey: "engine" }))
    ).rejects.toThrow()
  })
  it("retains a committed original guard after backend death and refuses revocation until authenticated resolution", async () => {
    const { f, binding } = await fixture()
    const c = await control.connect()
    c.on("error", () => undefined)
    let guardId: string | undefined
    try {
      expect(
        (await c.query("SELECT pg_try_advisory_lock(1819234670,1) AS acquired")).rows[0].acquired
      ).toBe(true)
      await c.query("BEGIN ISOLATION LEVEL READ COMMITTED")
      const journal = createScanExecutionInvocationGuardWriter(verify)
      guardId = (await journal.begin(sqlConnection(c), binding)).guardId
      await c.query("COMMIT")
      await c.query("BEGIN ISOLATION LEVEL READ COMMITTED")
      await journal.verifyCommitted(sqlConnection(c), binding, guardId)
      await c.query("ROLLBACK")
      const pid = (await c.query("SELECT pg_backend_pid() AS pid")).rows[0].pid
      await owner.query("SELECT pg_terminate_backend($1)", [pid])
      expect(
        (await owner.query('SELECT id FROM "ScanExecutionInvocationGuard" WHERE id=$1', [guardId]))
          .rowCount
      ).toBe(1)
      await expect(
        owner.query('UPDATE "WorkspaceMember" SET status=\'revoked\' WHERE "workspaceId"=$1', [
          f.workspaceId,
        ])
      ).rejects.toMatchObject({ code: "55000" })
      await expect(
        owner.query('UPDATE "ScanAuthorityEpoch" SET "isOpen"=false WHERE id=$1', [f.epochId])
      ).rejects.toMatchObject({ code: "55000" })
      await expect(
        owner.query(
          'INSERT INTO "ScanExecutionInvocationResolution"(id,"guardId","receiptId","proofInputJson","proofChecksum") VALUES(\'fake-resolution\',$1,\'fake-receipt\',\'{}\',$2)',
          [guardId, sha256Hex("{}")]
        )
      ).rejects.toMatchObject({ code: "23514" })
    } finally {
      c.release(true)
      // Disposable owner cleanup only; no runtime identity can TRUNCATE evidence.
      if (guardId) await owner.query('TRUNCATE "ScanExecutionInvocationGuard" CASCADE')
    }
  })

  it.skipIf(!process.env.LYRA_SANDBOX_TEST_DOCKER_SOCKET)(
    "holds revocation while a Docker start arrives after the original database session dies",
    async () => {
      const socket = process.env.LYRA_SANDBOX_TEST_DOCKER_SOCKET!
      const directory = mkdtempSync(join(tmpdir(), "guarded-docker-race-"))
      const proxyPath = join(directory, "docker.sock")
      const marker = randomUUID()
      let containerId = ""
      let guardId = ""
      let pid = 0
      let releaseStart: (() => void) | undefined
      let queued!: () => void
      let applied!: () => void
      const queuedPromise = new Promise<void>((resolve) => {
        queued = resolve
      })
      const appliedPromise = new Promise<void>((resolve) => {
        applied = resolve
      })
      const proxy = createServer((incoming: IncomingMessage, outgoing: ServerResponse) => {
        const forward = () => {
          const upstream = httpRequest(
            {
              socketPath: socket,
              method: incoming.method,
              path: incoming.url,
              headers: incoming.headers,
            },
            (response) => {
              outgoing.writeHead(response.statusCode ?? 500, response.headers)
              response.pipe(outgoing)
              response.on("end", () => {
                if (incoming.url?.endsWith("/start")) applied()
              })
            }
          )
          upstream.on("error", () => outgoing.destroy())
          incoming.pipe(upstream)
        }
        if (incoming.url?.endsWith("/start")) {
          releaseStart = forward
          queued()
        } else forward()
      })
      let started = false
      try {
        containerId = execFileSync(
          "docker",
          [
            "run",
            "-d",
            "--pull=never",
            "--network",
            "none",
            "--user",
            "65534:65534",
            "--label",
            `lyrashield.guard-race-fixture=${marker}`,
            "--entrypoint",
            "sleep",
            "postgres:17-alpine",
            "60",
          ],
          { encoding: "utf8", timeout: 30_000 }
        ).trim()
        await new Promise<void>((resolve, reject) => {
          proxy.once("error", reject)
          proxy.listen(proxyPath, () => {
            started = true
            resolve()
          })
        })
        const { f, binding } = await fixture()
        const pool = {
          query: async (text: string, values: unknown[] = []) => control.query(text, values),
          connect: async (): Promise<AuthoritySqlConnection> => {
            const client = await control.connect()
            pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid
            return {
              query: async (text, values) => client.query(text, values),
              release: (destroy) => client.release(destroy),
              on: (event, listener) => client.on(event, listener),
              off: (event, listener) => client.off(event, listener),
            }
          },
        }
        const durable = new PostgresDurableScanAuthorityFence(
          pool,
          verify,
          createScanExecutionInvocationGuardWriter(verify)
        )
        let execId = ""
        const outcome = durable
          .run(binding, async (assertActive, context) => {
            guardId = context?.guardId ?? ""
            const created = await dockerRequest(socket, "POST", `/containers/${containerId}/exec`, {
              AttachStdin: false,
              AttachStdout: false,
              AttachStderr: false,
              User: "65534",
              Tty: false,
              Cmd: ["/bin/sh", "-c", "sleep 20"],
              WorkingDir: "/",
            })
            execId = String(Reflect.get(created as object, "Id"))
            expect(execId).toMatch(/^[a-f0-9]{64}$/)
            assertActive()
            await dockerRequest(proxyPath, "POST", `/exec/${execId}/start`, {
              Detach: true,
              Tty: false,
            })
            assertActive()
          })
          .catch((error: unknown) => error)
        await queuedPromise
        expect(pid).toBeGreaterThan(0)
        expect(guardId).not.toBe("")
        await owner.query("SELECT pg_terminate_backend($1)", [pid])
        expect(await outcome).toBeInstanceOf(Error)
        await expect(
          owner.query('UPDATE "WorkspaceMember" SET status=\'revoked\' WHERE "workspaceId"=$1', [
            f.workspaceId,
          ])
        ).rejects.toMatchObject({ code: "55000" })
        const delayedStart = releaseStart!
        releaseStart = undefined
        delayedStart()
        await appliedPromise
        const inspected = await dockerRequest(socket, "GET", `/exec/${execId}/json`)
        expect(Reflect.get(inspected as object, "Running")).toBe(true)
        expect(
          (
            await owner.query('SELECT id FROM "ScanExecutionInvocationGuard" WHERE id=$1', [
              guardId,
            ])
          ).rowCount
        ).toBe(1)
      } finally {
        releaseStart?.()
        if (started) {
          proxy.closeAllConnections()
          await new Promise<void>((resolve) => proxy.close(() => resolve()))
        }
        if (containerId) {
          const observed = execFileSync(
            "docker",
            [
              "inspect",
              "--format",
              '{{.Id}}|{{index .Config.Labels "lyrashield.guard-race-fixture"}}',
              containerId,
            ],
            { encoding: "utf8", timeout: 10_000 }
          ).trim()
          if (observed !== `${containerId}|${marker}`)
            throw new Error("fixture container identity changed")
          execFileSync("docker", ["rm", "-f", containerId], { stdio: "ignore", timeout: 30_000 })
        }
        if (guardId) await owner.query('TRUNCATE "ScanExecutionInvocationGuard" CASCADE')
        rmSync(directory, { recursive: true, force: true })
      }
    },
    30_000
  )
})
