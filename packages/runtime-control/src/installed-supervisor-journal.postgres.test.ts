import { createServer } from "node:http"
import { randomBytes, randomUUID, generateKeyPairSync } from "node:crypto"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3"
import pg from "pg"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { loadInstalledSupervisorJournal } from "../../../apps/supervisor/src/installed-journal"
import { createSupervisorHandler } from "../../../apps/supervisor/src/http"
import { SupervisorService } from "../../../apps/supervisor/src/service"
import { DockerRuntimeExecutor } from "../../../apps/supervisor/src/executor"
import type { SupervisorConfig } from "../../../apps/supervisor/src/config"
import {
  createProtectedSupervisorAttemptProofAuthority,
  createProtectedSupervisorReceiptAuthority,
} from "../../db/src/scan-supervisor-receipt-source"
import { createScanDispatchAuthorityBroker } from "../../db/src/scan-dispatch-authority-broker"
import { createScanExecutionActionAuthorityVerifier } from "../../db/src/scan-execution-action-intent"
import { createScanExecutionInvocationGuardWriter } from "../../db/src/scan-execution-invocation-guard"
import {
  preparationFixture,
  preparationInput,
  applyPreparationFixtureMigration,
  installPreparationFixtureRole,
} from "../../db/scripts/tests/scan-preparation-fixture"
import { queueFixtureWorker } from "../../db/scripts/tests/queue-outbox-fixture"
import { installReceiptRole } from "../../db/scripts/tests/supervisor-receipt-fixture"
import { ScanAuthorityContext } from "./authority-context"
import { PostgresDurableScanAuthorityFence } from "./authority-invocation-fence"
import { canonicalJson, sha256Hex } from "./canonical-json"
import { createPublicationRecoverySnapshot } from "../../../ops/controller/journal-seal-publication.mjs"
import { deriveSupervisorToolJournalIdentity } from "./supervisor-tool-identity"

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
let owner: pg.Pool, execution: pg.Pool, mirrorUrl: string, root: string, receiptUrl: string
let broker: ReturnType<typeof createScanDispatchAuthorityBroker>
const queue = queueFixtureWorker()
const objects = new Map<string, { bytes: Buffer; etag: string }>()
const close: (() => Promise<unknown>)[] = []

describe.skipIf(!enabled)(
  "packaged independent supervisor journal with restricted PostgreSQL",
  () => {
    beforeAll(async () => {
      owner = new pg.Pool({ connectionString: process.env.DATABASE_URL })
      execution = new pg.Pool({
        connectionString: process.env.DISPATCH_PREPARATION_BROKER_DATABASE_URL,
      })
      await queue.open()
      await applyPreparationFixtureMigration(owner)
      await installPreparationFixtureRole(owner)
      receiptUrl = await installReceiptRole(owner)
      await owner.query(
        "GRANT EXECUTE ON FUNCTION app.require_scan_dispatch_worker(text,text) TO dispatch_receipt_consumer"
      )
      if (
        !(await owner.query("SELECT 1 FROM pg_namespace WHERE nspname='lyrashield_authority'"))
          .rowCount
      )
        await owner.query(
          await readFile(new URL("../sql/authority-mirror.sql", import.meta.url), "utf8")
        )
      if (
        !(
          await owner.query(
            "SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app' AND p.proname='scan_supervisor_journal_stream_matches'"
          )
        ).rowCount
      )
        await owner.query(
          await readFile(
            new URL(
              "../../db/prisma/migrations/20261114020000_supervisor_journal_stream_binding/migration.sql",
              import.meta.url
            ),
            "utf8"
          )
        )
      const role = `journal_fixture_${randomBytes(8).toString("hex")}`,
        password = randomBytes(24).toString("hex")
      await owner.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
      GRANT USAGE ON SCHEMA lyrashield_authority,app TO ${role};
      GRANT EXECUTE ON FUNCTION lyrashield_authority.read_head(text,text),lyrashield_authority.read_record(text,text,bigint),lyrashield_authority.append_record(text,text,text,text,text) TO ${role};
      GRANT EXECUTE ON FUNCTION app.scan_supervisor_journal_stream_matches(text,text,text,text,text) TO ${role};
      GRANT SELECT ON "ScanExecutionInvocationGuard","ScanExecutionInvocationResolution" TO dispatch_prepare_broker;
      GRANT INSERT ON "ScanExecutionInvocationGuard" TO dispatch_prepare_broker;`)
      const url = new URL(process.env.DISPATCH_PREPARATION_BROKER_DATABASE_URL!)
      url.username = role
      url.password = password
      mirrorUrl = url.toString()
      root = await mkdtemp(join(tmpdir(), "installed-journal-fixture-"))
      broker = createScanDispatchAuthorityBroker({
        connectionString: process.env.DISPATCH_PREPARATION_BROKER_DATABASE_URL!,
        preparationAuthority: "checked-intent-v1",
        compilePreparation: () => ({
          executors: [
            {
              key: "scanner",
              spec: {
                kind: "container",
                image: `fixture@sha256:${"a".repeat(64)}`,
                argv: [],
                env: {},
                network: "fixture",
                cpus: 1,
                memoryMb: 64,
                pidsLimit: 16,
                readOnly: true,
              },
            },
          ],
        }),
      })
      // Genuine SDK and R2 conditional adapter; only its remote transport is synthetic.
      vi.spyOn(S3Client.prototype, "send").mockImplementation((async (
        command: GetObjectCommand | PutObjectCommand
      ) => {
        const key = command.input.Key!,
          current = objects.get(key)
        if (command instanceof GetObjectCommand) {
          if (!current) throw { $metadata: { httpStatusCode: 404 } }
          return {
            $metadata: { httpStatusCode: 200 },
            ETag: current.etag,
            ContentLength: current.bytes.length,
            Body: Readable.from([current.bytes]),
          }
        }
        if (
          (command.input.IfNoneMatch === "*" && current) ||
          (command.input.IfMatch && command.input.IfMatch !== current?.etag)
        )
          throw { $metadata: { httpStatusCode: 412 } }
        objects.set(key, {
          bytes: Buffer.from(command.input.Body as Uint8Array),
          etag: `"etag-${objects.size + 1}"`,
        })
        return { $metadata: { httpStatusCode: 200 } }
      }) as S3Client["send"])
    }, 30000)
    afterAll(async () => {
      for (const finish of close.reverse()) await finish()
      vi.restoreAllMocks()
      await broker?.close()
      await execution?.end()
      await owner?.end()
      await queue.close()
      if (root) await rm(root, { recursive: true, force: true })
    })

    async function fixture() {
      const f = await preparationFixture(owner, 0, "installed-journal")
      const prepared = await broker.prepare(preparationInput(f))
      if (prepared.kind !== "committed") throw new Error("fixture preparation unavailable")
      const raw = (
        await owner.query('SELECT "commandInputJson" FROM "ScanDispatchOutbox" WHERE id=$1', [
          prepared.commandId,
        ])
      ).rows[0].commandInputJson
      const command = JSON.parse(raw),
        original = randomBytes(32).toString("hex"),
        wrapper = randomBytes(32).toString("hex"),
        streamId = `stream-${randomUUID()}`
      await owner.query(
        "INSERT INTO lyrashield_authority.stream(epoch_id,supervisor_id,active) VALUES($1,$2,true)",
        [f.epochId, f.instanceId]
      )
      await owner.query(
        'INSERT INTO "ScanSupervisorJournalStream"(id,"authorityEpochId","supervisorInstanceId","originalKeyHash","wrapperKeyHash","updatedAt") VALUES($1,$2,$3,$4,$5,CURRENT_TIMESTAMP)',
        [streamId, f.epochId, f.instanceId, sha256Hex(original), sha256Hex(wrapper)]
      )
      const config: SupervisorConfig = {
        host: "127.0.0.1",
        port: 8790,
        journalPath: join(root, `${streamId}.original`),
        signingSecret: original,
        supervisorInstanceId: f.instanceId,
        controlToken: randomBytes(32).toString("hex"),
        admission: "closed",
        providerGatewayUrl: "http://127.0.0.1:1",
        providerGatewayControlToken: randomBytes(32).toString("hex"),
        policy: {
          allowedImages: new Set(
            command.executors.map((p: { spec: { image: string } }) => p.spec.image)
          ),
          allowedNetworks: new Set(["fixture"]),
          allowedProcessCommands: new Set(),
          allowedCwdRoots: [],
          allowedCgroupRoot: "/unavailable",
        },
      }
      const identity = createProtectedSupervisorReceiptAuthority({
        connectionString: process.env.DISPATCH_PREPARATION_BROKER_DATABASE_URL!,
        streamId,
        authorityEpochId: f.epochId,
        supervisorInstanceId: f.instanceId,
        originalSigningSecret: original,
        originalKeyHash: sha256Hex(original),
        wrapperSigningSecret: wrapper,
        wrapperKeyHash: sha256Hex(wrapper),
        controlToken: config.controlToken,
        transport: { kind: "unix", socketPath: "/run/fixture-only/supervisor.sock" },
      })
      const context = new ScanAuthorityContext(),
        verify = createScanExecutionActionAuthorityVerifier({ approvedProviderPolicies: new Map() })
      const fence = new PostgresDurableScanAuthorityFence(
        execution,
        verify,
        createScanExecutionInvocationGuardWriter(verify),
        context
      )
      const authority = {
        authorityFence: fence,
        context,
        pool: execution,
        supervisorAuthority: identity,
        close: async () => {},
      }
      const env = {
        LYRASHIELD_SUPERVISOR_RECEIPT_DATABASE_URL: receiptUrl,
        LYRASHIELD_SUPERVISOR_INDEPENDENT_JOURNAL_PATH: join(root, `${streamId}.wrapped`),
        LYRASHIELD_SUPERVISOR_MIRROR_DATABASE_URL: mirrorUrl,
        LYRASHIELD_SUPERVISOR_JOURNAL_STORAGE_JSON: JSON.stringify({
          schema: "lyrashield-supervisor-r2-journal-storage/1",
          accountId: "a".repeat(32),
          bucket: "private-journal-fixture",
          accessKeyId: "b".repeat(32),
          secretAccessKey: "c".repeat(64),
        }),
      }
      const installed = await loadInstalledSupervisorJournal(config, authority, env)
      if (!installed) throw new Error("packaged fixture journal unavailable")
      close.push(installed.close)
      const unavailable = async () => {
        throw new Error("no provider authorized in metadata test")
      }
      const service = new SupervisorService({
        journal: installed.journal,
        executor: new DockerRuntimeExecutor(),
        providerGateway: {
          issueGrant: unavailable,
          findGrantByRequest: unavailable,
          revokeGrant: unavailable,
          inspectGrant: unavailable,
        },
        providerGatewayUrl: config.providerGatewayUrl,
        policy: config.policy,
        signingSecret: original,
        supervisorInstanceId: f.instanceId,
        admission: "open",
        authorityFence: fence,
      })
      await service.initialize()
      const consumer = createScanDispatchAuthorityBroker({
        connectionString: process.env.DISPATCH_PREPARATION_BROKER_DATABASE_URL!,
        receiptAuthority: {
          ...identity,
          connectionString: receiptUrl,
          readJournal: (cursor) => installed.journal.readCursor(cursor),
        },
      })
      close.push(() => consumer.close())
      return { f, prepared, command, installed, config, service, authority, env, consumer }
    }

    it("loads a separately registered independent tool stream through the installed composition", async () => {
      const t = await fixture()
      const controller = t.authority.supervisorAuthority
      const identity = deriveSupervisorToolJournalIdentity({
        streamId: controller.streamId,
        authorityEpochId: controller.authorityEpochId,
        supervisorInstanceId: controller.supervisorInstanceId,
        originalSigningSecret: controller.originalSigningSecret,
        wrapperSigningSecret: controller.wrapperSigningSecret,
      })
      await owner.query(
        'INSERT INTO "ScanSupervisorJournalStream"(id,"authorityEpochId","supervisorInstanceId","originalKeyHash","wrapperKeyHash","updatedAt") VALUES($1,$2,$3,$4,$5,CURRENT_TIMESTAMP)',
        [
          identity.streamId,
          identity.authorityEpochId,
          identity.supervisorInstanceId,
          identity.originalKeyHash,
          identity.wrapperKeyHash,
        ]
      )
      await owner.query(
        "INSERT INTO lyrashield_authority.stream(epoch_id,supervisor_id,active) VALUES($1,$2,true)",
        [identity.authorityEpochId, identity.supervisorInstanceId]
      )
      const tools = await t.installed.createTools()
      expect(await tools.toolJournal.load()).toEqual([])
      const published = await tools.toolJournal.withPublication(async (ports) => ({
        original: await ports.original.load(),
        wrapper: await ports.wrapper.load(),
        stream: ports.independent.streamIdentity(),
      }))
      expect(published).toEqual({
        original: [],
        wrapper: [],
        stream: {
          epochId: identity.authorityEpochId,
          supervisorInstanceId: identity.supervisorInstanceId,
        },
      })
      expect(await t.installed.journal.load()).toEqual([])
    }, 15000)

    it("publishes original metadata through the packaged loader without a recursive native gate", async () => {
      const t = await fixture()
      expect((await t.service.execute(t.command)).status).toBe("PREPARED")
      const scopedControlToken = randomBytes(32).toString("hex")
      const server = createServer(
        createSupervisorHandler(t.service, {
          controlToken: t.config.controlToken,
          scopedControlToken,
          receiptConsumer: t.installed.consumeReceipts,
          admission: "closed",
        })
      )
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
      try {
        const address = server.address()
        if (!address || typeof address === "string") throw new Error("fixture port unavailable")
        const identity = t.authority.supervisorAuthority
        const { publicKey } = generateKeyPairSync("ed25519", {
          publicKeyEncoding: { format: "pem", type: "spki" },
          privateKeyEncoding: { format: "pem", type: "pkcs8" },
        })
        const source = createProtectedSupervisorAttemptProofAuthority({
          streamId: identity.streamId,
          authorityEpochId: identity.authorityEpochId,
          supervisorInstanceId: identity.supervisorInstanceId,
          originalKeyHash: identity.originalKeyHash,
          wrapperKeyHash: identity.wrapperKeyHash,
          attemptProofPublicKey: publicKey,
          controlToken: scopedControlToken,
          transport: { kind: "loopback", port: address.port },
        })
        expect(source).not.toHaveProperty("originalSigningSecret")
        expect(source).not.toHaveProperty("wrapperSigningSecret")
        expect(source).not.toHaveProperty("readJournal")
        expect(await source.consume(t.f.operationId)).toMatchObject({
          operationId: t.f.operationId,
          confirmedSequence: 3,
        })
        const sequenceBefore = (
          await owner.query(
            'SELECT "confirmedSequence" FROM "ScanSupervisorJournalStream" WHERE id=$1',
            [identity.streamId]
          )
        ).rows[0].confirmedSequence
        await expect(
          source.consume(t.f.operationId, "incorrect-worker-credential".repeat(2))
        ).rejects.toMatchObject({ code: "WORKER_GRANT_INVALID" })
        expect(
          (
            await owner.query(
              'SELECT "confirmedSequence" FROM "ScanSupervisorJournalStream" WHERE id=$1',
              [identity.streamId]
            )
          ).rows[0].confirmedSequence
        ).toBe(sequenceBefore)
        const query = new URLSearchParams({
          epochId: t.f.epochId,
          supervisorInstanceId: t.f.instanceId,
          afterSequence: "0",
          afterHash: "0".repeat(64),
          limit: "10",
        })
        const response = await fetch(`http://127.0.0.1:${address.port}/v1/journal?${query}`, {
          headers: { authorization: `Bearer ${t.config.controlToken}` },
        })
        expect(response.status).toBe(200)
        const page = await response.json()
        expect(
          page.records.map(
            (r: { payload: { payload: { payload: { type: string } } } }) =>
              r.payload.payload.payload.type
          )
        ).toEqual(["command_intent", "attempt_prepared", "prepare_invocation_completed"])
        expect(page.snapshotHead.sequence).toBe(3)
        expect(page.hasMore).toBe(false)
        expect((await t.installed.journal.load()).length).toBe(3)
        const snapshot = await t.installed.journal.withPublication(async (ports) => {
          const originals = await ports.original.load(),
            wrappers = await ports.wrapper.load()
          const deadline = performance.now() + 5000
          return createPublicationRecoverySnapshot(
            ports,
            {
              epochId: t.f.epochId,
              supervisorInstanceId: t.f.instanceId,
              lastSequence: 3,
              originalLastHash: originals[2]!.hash,
              wrapperLastHash: wrappers[2]!.hash,
            },
            () => {
              if (performance.now() >= deadline)
                throw new Error("fixture snapshot deadline exceeded")
            }
          )
        })
        expect(JSON.parse(Buffer.from(snapshot.bytes).toString("utf8"))).toMatchObject({
          schema: "lyrashield-supervisor-recovery-snapshot/1",
          sequence: 3,
          epochId: t.f.epochId,
          supervisorInstanceId: t.f.instanceId,
        })
        await t.consumer.consumeSupervisorReceipts(t.f.operationId)
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        )
      }
    }, 15000)

    it("preserves sealed history after grant revocation and rejects fresh live writes", async () => {
      const t = await fixture()
      await t.service.execute(t.command)
      await t.consumer.consumeSupervisorReceipts(t.f.operationId)
      const original = await t.installed.journal.load()
      await owner.query(
        'UPDATE "ScanWorkerInstanceGrant" SET "revokedAt"=CURRENT_TIMESTAMP,"updatedAt"=CURRENT_TIMESTAMP WHERE id=$1',
        [t.f.grantId]
      )
      expect(canonicalJson(await t.installed.journal.load())).toBe(canonicalJson(original))
      await expect(
        t.installed.journal.append({
          type: "attempt_prepared",
          commandId: t.prepared.commandId,
          supervisorInstanceId: t.f.instanceId,
          observedAt: new Date().toISOString(),
          binding: t.command.attempt,
          executors: t.command.executors,
        })
      ).rejects.toThrow()
      // The refused signed original is retained as unresolved, never returned as confirmed.
      await expect(t.installed.journal.load()).rejects.toThrow()
    })

    it("keeps authenticated immutable history readable after its ordinary scan row is deleted", async () => {
      const t = await fixture()
      await t.service.execute(t.command)
      await t.consumer.consumeSupervisorReceipts(t.f.operationId)
      const before = canonicalJson(await t.installed.journal.load())
      await owner.query('DELETE FROM "Scan" WHERE id=$1', [t.f.scanId])
      expect(canonicalJson(await t.installed.journal.load())).toBe(before)
    })

    it("rejects partial installation and shared mirror execution credentials", async () => {
      const t = await fixture()
      await expect(
        loadInstalledSupervisorJournal(t.config, t.authority, {
          LYRASHIELD_SUPERVISOR_INDEPENDENT_JOURNAL_PATH:
            t.env.LYRASHIELD_SUPERVISOR_INDEPENDENT_JOURNAL_PATH,
        })
      ).rejects.toThrow("independent supervisor journal")
      await expect(
        loadInstalledSupervisorJournal(t.config, t.authority, {
          ...t.env,
          LYRASHIELD_SUPERVISOR_MIRROR_DATABASE_URL:
            process.env.DISPATCH_PREPARATION_BROKER_DATABASE_URL,
        })
      ).rejects.toThrow("independent supervisor journal")
      await expect(
        execution.query('SELECT * FROM "ScanSupervisorJournalStream"')
      ).rejects.toMatchObject({ code: "42501" })
      await expect(
        execution.query("SELECT app.scan_supervisor_journal_stream_matches($1,$2,$3,$4,$5)", [
          t.authority.supervisorAuthority.streamId,
          t.f.epochId,
          t.f.instanceId,
          t.authority.supervisorAuthority.originalKeyHash,
          t.authority.supervisorAuthority.wrapperKeyHash,
        ])
      ).rejects.toMatchObject({ code: "42501" })
    })
  }
)
