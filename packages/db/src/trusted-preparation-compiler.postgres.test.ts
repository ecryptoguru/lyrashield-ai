import pg from "pg"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { createScanDispatchAuthorityBroker } from "./scan-dispatch-authority-broker"
import { createTrustedPreparationCompiler } from "./trusted-preparation-compiler"
import { trustedPreparationHostPolicySchema } from "./trusted-preparation-proof"
import { createManagedDisposablePreparationIssuer } from "./managed-disposable-preparation-issuer"
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

const enabled = process.env.LYRA_PREPARATION_MANAGED_DISPOSABLE_PROOF === "1"
const configSchema = z
  .object({
    hostPolicy: trustedPreparationHostPolicySchema,
    fixture: z.object({
      databaseContainer: z.string(),
      providerContainer: z.string(),
      owner: z.string(),
      relayPid: z.number(),
      relayPortFile: z.string(),
      providerRelayPid: z.number(),
      providerRelayPortFile: z.string(),
      database: z.string(),
    }),
    sourceHostPath: z.string().startsWith("/"),
    egressDirectory: z.string().startsWith("/"),
    egressFile: z.string().min(1),
  })
  .strict()
let owner: pg.Pool
let broker: ReturnType<typeof createScanDispatchAuthorityBroker> | undefined
const worker = queueFixtureWorker()
describe.skipIf(!enabled)("actual managed disposable preparation compilation", () => {
  beforeAll(async () => {
    if (
      process.env.SCAN_DISPATCH_AUTHORITY_POSTGRES_TEST !== "1" ||
      process.env.LYRASHIELD_TEST_DB_DISPOSABLE !== "1"
    )
      throw new Error("Disposable PostgreSQL harness is required")
    owner = new pg.Pool({ connectionString: process.env.DATABASE_URL })
    await worker.open()
    await applyPreparationFixtureMigration(owner)
    await installPreparationFixtureRole(owner)
  }, 30000)
  afterAll(async () => {
    await broker?.close()
    await owner?.end()
    await worker.close()
  })
  it("signs actual observed inputs inside the locked broker callback and retains exact approved commands", async () => {
    const configPath = process.env.LYRA_PREPARATION_MANAGED_CONFIG
    if (!configPath?.startsWith("/"))
      throw new Error("Protected disposable compiler configuration is required")
    const config = configSchema.parse(JSON.parse(readFileSync(configPath, "utf8")))
    const issuer = createManagedDisposablePreparationIssuer(config)
    const revision = execFileSync(
      "git",
      ["--no-replace-objects", "-C", config.sourceHostPath, "rev-parse", "HEAD"],
      { encoding: "utf8", timeout: 10000 }
    ).trim()
    if (!/^[a-f0-9]{40}$/.test(revision))
      throw new Error("Exact disposable source revision is required")
    const epoch = await owner.query(
      'SELECT id FROM "ScanAuthorityEpoch" WHERE id=$1 AND "isOpen" AND "openKey" IS NOT NULL',
      [config.hostPolicy.authorityEpochId]
    )
    expect(epoch.rows).toHaveLength(1)
    let lockedCallbacks = 0
    const compiler = createTrustedPreparationCompiler({
      ...issuer,
      hostPolicy: config.hostPolicy,
      readStagingRecord: async (authority) => {
        lockedCallbacks++
        return issuer.readStagingRecord(authority)
      },
    })
    broker = createScanDispatchAuthorityBroker({
      connectionString: process.env.DISPATCH_PREPARATION_BROKER_DATABASE_URL!,
      preparationAuthority: "checked-intent-v1",
      compilePreparation: compiler,
    })
    const f = await preparationFixture(
      owner,
      1,
      "managed-compiler",
      { targetType: "REPO", mode: "SAFE", source: { revision } },
      false,
      "RESERVED",
      { epochId: config.hostPolicy.authorityEpochId }
    )
    const result = await broker.prepare(preparationInput(f))
    if (result.kind !== "committed") throw new Error("Actual managed preparation did not commit")
    const row = (
      await owner.query(
        'SELECT "commandInputJson","commandInputChecksum" FROM "ScanDispatchOutbox" WHERE id=$1',
        [result.commandId]
      )
    ).rows[0]
    const command = readStoredDispatchCommand(row.commandInputJson, row.commandInputChecksum)
    if (!command || command.type !== "PREPARE")
      throw new Error("Exact retained PREPARE descriptor is unavailable")
    expect(lockedCallbacks).toBe(1)
    expect(command.attempt.scanId).toBe(f.scanId)
    expect(command.executors.map((plan) => plan.key)).toEqual(["sandbox", "engine"])
    for (const plan of command.executors) {
      if (plan.spec.kind !== "container")
        throw new Error("Protected container descriptor is required")
      expect(plan.spec.resourceDescriptor?.source?.revision).toBe(revision)
      expect(plan.spec.resourceDescriptor?.issuerKeyHash).toBe(config.hostPolicy.issuerKeyHash)
    }
  }, 120000)
})
