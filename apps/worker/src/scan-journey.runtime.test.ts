import { randomUUID } from "node:crypto"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { PrismaClient } from "../../../packages/db/src/generated/prisma"
import { createBoundedPgAdapter } from "../../../packages/db/src/pool"
import { assertUserScanSlotRedisFixture } from "./user-scan-slot.fixture"

vi.mock("@lyrashield/security", async (importOriginal) => {
  // The disposable fixture target lives on the loopback; the preflight SSRF
  // guard is exercised by its own unit tests. The surface parser itself runs
  // against the loopback fixture (see the safe-fetch mock below).
  const actual = await importOriginal<typeof import("@lyrashield/security")>()
  return {
    ...actual,
    checkScanUrlSafe: vi.fn(async () => ({ safe: true as const })),
  }
})

vi.mock("../../../packages/security/src/safe-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../packages/security/src/safe-fetch")>()
  return {
    ...actual,
    safeFetchDetailed: vi.fn(async (rawUrl: string) => {
      const response = await fetch(rawUrl)
      const html = await response.text()
      const headers: Record<string, string> = {}
      response.headers.forEach((value, key) => {
        headers[key] = value
      })
      return {
        ok: true as const,
        result: {
          html,
          status: response.status,
          headers,
          finalUrl: rawUrl,
          urlHistory: [rawUrl],
          bodyBytes: Buffer.byteLength(html),
          bodyTruncated: false,
        },
      }
    }),
  }
})

vi.mock("@lyrashield/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@lyrashield/config")>()
  // The worker runs with production-like system credentials here. The
  // admission fixture proves the restricted tenant role separately.
  return {
    ...actual,
    env: {
      ...actual.env,
      LYRASHIELD_LOCAL_EVIDENCE_DIR: journeyEvidenceDir,
    },
  }
})

const journeyEvidenceDir = mkdtempSync(join(tmpdir(), "lyrashield-journey-evidence-"))
const enabled = process.env.SCAN_JOURNEY_RUNTIME_TEST === "1"
let owner: PrismaClient
let db: typeof import("@lyrashield/db")
let integrations: typeof import("@lyrashield/integrations")
const users: string[] = []
const workspaces: string[] = []
let httpFixture: Server
let httpOrigin = ""

async function fixture() {
  const userId = `journey-user-${randomUUID()}`
  users.push(userId)
  await owner.user.create({ data: { id: userId, name: userId, email: `${userId}@example.test` } })
  const workspaceId = `journey-workspace-${randomUUID()}`
  workspaces.push(workspaceId)
  await owner.workspace.create({ data: { id: workspaceId, name: workspaceId, slug: workspaceId } })
  await owner.workspaceMember.create({
    data: { workspaceId, userId, role: "ADMIN", status: "active" },
  })
  const target = await owner.target.create({
    data: {
      workspaceId,
      type: "WEB_APP",
      name: "Journey fixture",
      url: `${httpOrigin}/surface`,
    },
  })
  return { workspaceId, targetId: target.id, createdById: userId } as const
}

async function waitForTerminalScan(scanId: string, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const scan = await owner.scan.findUniqueOrThrow({ where: { id: scanId } })
    if (
      ["COMPLETED", "PARTIAL", "FAILED", "CANCELLED", "STOPPED_BUDGET", "TIMED_OUT"].includes(
        scan.status
      )
    )
      return scan
    if (Date.now() > deadline) throw new Error(`Scan ${scanId} did not reach a terminal state`)
    await new Promise((accept) => setTimeout(accept, 500))
  }
}

if (!enabled)
  console.warn("[scan-journey.runtime] SKIPPED: explicit disposable-service opt-in required")

describe.skipIf(!enabled)(
  "normal scan admission to worker execution with disposable services",
  () => {
    beforeAll(async () => {
      const { assertDisposableDatabasePair } =
        await import("../../../.github/scripts/vitest-database-env.mjs")
      assertDisposableDatabasePair(process.env)
      const ownerUrl = new URL(process.env.DATABASE_URL!)
      const runtimeUrl = new URL(process.env.RLS_RUNTIME_DATABASE_URL!)
      const redisUrl = new URL(process.env.REDIS_URL!)
      if (
        process.env.LYRASHIELD_TEST_DB_DISPOSABLE !== "1" ||
        ownerUrl.hostname !== "127.0.0.1" ||
        !ownerUrl.pathname.startsWith("/task3_admission_test") ||
        runtimeUrl.host !== ownerUrl.host ||
        runtimeUrl.pathname !== ownerUrl.pathname ||
        redisUrl.hostname !== "127.0.0.1"
      )
        throw new Error("requires same-database task3_admission_test disposable local services")
      await assertUserScanSlotRedisFixture(
        redisUrl.toString(),
        process.env.USER_SCAN_SLOT_REDIS_FIXTURE_ID
      )
      owner = new PrismaClient({ adapter: createBoundedPgAdapter(ownerUrl.toString()) })
      db = await import("@lyrashield/db")
      integrations = await import("@lyrashield/integrations")
      await new Promise<void>((accept) => {
        httpFixture = createServer((req, res) => {
          res.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
          })
          res.end("<!doctype html><title>surface</title><p>journey</p>")
        })
        httpFixture.listen(0, "127.0.0.1", () => accept())
      })
      const address = httpFixture.address() as AddressInfo
      httpOrigin = `http://127.0.0.1:${address.port}`
    }, 60_000)

    afterAll(async () => {
      await new Promise((accept) => httpFixture?.close(accept))
      if (integrations) {
        await integrations.getScanQueue().close()
        const { closeRedis } = await import("../../../packages/integrations/src/redis")
        await closeRedis()
      }
      if (owner) {
        await owner.scan.deleteMany({ where: { workspace: { id: { in: workspaces } } } })
        await owner.workspace.deleteMany({ where: { id: { in: workspaces } } })
        await owner.user.deleteMany({ where: { id: { in: users } } })
        await owner.$disconnect()
      }
      await db?.prisma.$disconnect()
      await db?.getSystemPrisma().$disconnect()
      rmSync(journeyEvidenceDir, { recursive: true, force: true })
    })

    it("executes a SAFE WEB_APP scan from normal admission through the shared queue to a terminal result", async () => {
      const { Worker } = await import("bullmq")
      const input = await fixture()
      const workerId = `journey-worker-${randomUUID()}`
      await integrations.registerScanWorker(workerId)
      // Normal admission: the same createScan the web API calls.
      const scan = await db.createScan({
        workspaceId: input.workspaceId,
        targetId: input.targetId,
        goal: "TEST_APP",
        mode: "SAFE",
        createdById: input.createdById,
      })
      // Ordinary enqueue through the shared queue.
      await integrations.enqueueScan({
        scanId: scan.id,
        workspaceId: input.workspaceId,
        targetId: input.targetId,
        goal: "TEST_APP",
        mode: "SAFE",
      })
      const { createWorkerScanJobProcessor } = await import("./jobs/scan-job-processor")
      const { SCAN_QUEUE_NAME } = await import("@lyrashield/types")
      const worker = new Worker(
        SCAN_QUEUE_NAME,
        createWorkerScanJobProcessor({
          kind: "legacy",
          compatibility: "existing-production-baseline",
        }),
        {
          connection: { url: process.env.REDIS_URL!, maxRetriesPerRequest: null },
          concurrency: 1,
          autorun: true,
        }
      )
      try {
        const terminal = await waitForTerminalScan(scan.id)
        if (!["COMPLETED", "PARTIAL"].includes(terminal.status)) {
          const events = await owner.scanEvent.findMany({
            where: { scanId: scan.id },
            orderBy: { createdAt: "asc" },
          })
          console.log(
            "JOURNEY FAILURE:",
            terminal.status,
            terminal.errorCategory,
            terminal.errorMessage
          )
          for (const event of events)
            console.log("JOURNEY EVENT:", event.stage, event.level, event.message)
          throw new Error(
            "journey failed: " + terminal.errorCategory + ": " + terminal.errorMessage
          )
        }
        const events = await owner.scanEvent.findMany({ where: { scanId: scan.id } })
        expect(events.length).toBeGreaterThan(0)
        // SAFE stays deterministic: the engine subprocess is never dispatched and no
        // provider capacity minutes are metered for the scan.
        const reservation = await owner.scanCapacityReservation.findFirst({
          where: { scanId: scan.id },
        })
        expect(reservation?.chargedMinutes ?? 0).toBe(0)
      } finally {
        await worker.close()
        await integrations.unregisterScanWorker(workerId)
      }
    }, 120_000)

    it("keeps a cancelled scan out of execution and out of provider accounting", async () => {
      const { Worker } = await import("bullmq")
      const input = await fixture()
      const workerId = `journey-worker-${randomUUID()}`
      await integrations.registerScanWorker(workerId)
      const scan = await db.createScan({
        workspaceId: input.workspaceId,
        targetId: input.targetId,
        goal: "TEST_APP",
        mode: "SAFE",
        createdById: input.createdById,
      })
      await integrations.enqueueScan({
        scanId: scan.id,
        workspaceId: input.workspaceId,
        targetId: input.targetId,
        goal: "TEST_APP",
        mode: "SAFE",
      })
      await db.cancelScan(scan.id, input.workspaceId)
      const { createWorkerScanJobProcessor } = await import("./jobs/scan-job-processor")
      const { SCAN_QUEUE_NAME } = await import("@lyrashield/types")
      const worker = new Worker(
        SCAN_QUEUE_NAME,
        createWorkerScanJobProcessor({
          kind: "legacy",
          compatibility: "existing-production-baseline",
        }),
        {
          connection: { url: process.env.REDIS_URL!, maxRetriesPerRequest: null },
          concurrency: 1,
          autorun: true,
        }
      )
      try {
        const terminal = await waitForTerminalScan(scan.id, 60_000)
        expect(terminal.status).toBe("CANCELLED")
        const reservation = await owner.scanCapacityReservation.findFirst({
          where: { scanId: scan.id },
        })
        expect(reservation?.chargedMinutes ?? 0).toBe(0)
      } finally {
        await worker.close()
        await integrations.unregisterScanWorker(workerId)
      }
    }, 90_000)
  }
)
