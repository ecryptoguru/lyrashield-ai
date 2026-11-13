import { randomBytes } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pg from "pg"
import {
  canonicalJson,
  PostgresAuthorityMirror,
  PostgresDurableScanAuthorityFence,
  type AuthoritySqlPool,
} from "@lyrashield/runtime-control"
import { createSupervisorAuthorityJournal } from "../../../../apps/supervisor/src/authority-journal"
import { SupervisorService } from "../../../../apps/supervisor/src/service"
import { DockerRuntimeExecutor } from "../../../../apps/supervisor/src/executor"
import { createScanExecutionActionAuthorityVerifier } from "../../src/scan-execution-action-intent"
import { createScanExecutionInvocationGuardWriter } from "../../src/scan-execution-invocation-guard"
import { sha256Hex } from "../../src/scan-supervisor-receipt-verifier"
import type { SupervisorReceiptAuthority } from "../../src/scan-supervisor-receipt-ingestion-verifier"
import type { PreparationFixture } from "./scan-preparation-fixture"
import { NativeFixtureObjectStore } from "./supervisor-native-object-store"

export function sqlPool(pool: pg.Pool): AuthoritySqlPool {
  return {
    query: async (text, values) => pool.query(text, values),
    connect: async () => {
      const c = await pool.connect()
      return {
        query: async (text, values) => c.query(text, values),
        release: (destroy) => c.release(destroy),
        on: (event, listener) => c.on(event, listener),
        off: (event, listener) => c.off(event, listener),
      }
    },
  }
}
export async function installNativeMirrorRole(owner: pg.Pool) {
  const exists = await owner.query(
    "SELECT 1 FROM pg_namespace WHERE nspname='lyrashield_authority'"
  )
  if (!exists.rowCount) {
    const source = await readFile(
      new URL("../../../runtime-control/sql/authority-mirror.sql", import.meta.url),
      "utf8"
    )
    await owner.query(source)
  }
  const password = randomBytes(24).toString("hex")
  await owner.query(`CREATE ROLE native_receipt_mirror LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
 GRANT USAGE ON SCHEMA lyrashield_authority TO native_receipt_mirror;
 GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA lyrashield_authority TO native_receipt_mirror;
 GRANT SELECT ON "ScanExecutionInvocationGuard","ScanExecutionInvocationResolution" TO dispatch_prepare_broker;
 GRANT INSERT ON "ScanExecutionInvocationGuard" TO dispatch_prepare_broker;
`)
  const url = new URL(process.env.DISPATCH_PREPARATION_BROKER_DATABASE_URL!)
  url.username = "native_receipt_mirror"
  url.password = password
  return url.toString()
}
export async function nativePreparationJournal(
  owner: pg.Pool,
  f: PreparationFixture,
  receiptUrl: string,
  mirrorUrl: string
) {
  const root = await mkdtemp(join(tmpdir(), "native-receipt-")),
    storeRoot = join(root, "store")
  await mkdir(storeRoot, { mode: 0o700 })
  const raw = (
    await owner.query(
      'SELECT "commandInputJson" FROM "ScanDispatchOutbox" WHERE "operationId"=$1 AND "commandType"=\'PREPARE\'',
      [f.operationId]
    )
  ).rows[0].commandInputJson
  const command = JSON.parse(raw)
  const originalSecret = randomBytes(32).toString("hex"),
    wrapperSecret = randomBytes(32).toString("hex")
  await owner.query(
    "INSERT INTO lyrashield_authority.stream(epoch_id,supervisor_id,active) VALUES($1,$2,true)",
    [f.epochId, f.instanceId]
  )
  const mirrorPool = new pg.Pool({ connectionString: mirrorUrl }),
    nativePool = new pg.Pool({
      connectionString: process.env.DISPATCH_PREPARATION_BROKER_DATABASE_URL,
    })
  const { journal, close } = createSupervisorAuthorityJournal({
    originalPath: join(root, "original"),
    independentPath: join(root, "wrapped"),
    originalSigningSecret: originalSecret,
    signingSecret: wrapperSecret,
    epochId: f.epochId,
    supervisorInstanceId: f.instanceId,
    store: new NativeFixtureObjectStore(storeRoot),
    mirror: new PostgresAuthorityMirror(sqlPool(mirrorPool), f.epochId, f.instanceId),
    authorizeStream: async (stream) =>
      (
        await owner.query(
          'SELECT 1 FROM "ScanAuthorityEpoch" WHERE id=$1 AND "isOpen" AND "closedAt" IS NULL',
          [stream.epochId]
        )
      ).rowCount === 1 && stream.supervisorInstanceId === f.instanceId,
    authorize: async (event, binding) => {
      if (
        event.epochId !== f.epochId ||
        event.operationId !== f.operationId ||
        event.attemptId !== command.attempt.attemptId ||
        canonicalJson(binding) !== canonicalJson(command.attempt)
      )
        return false
      return (
        (
          await owner.query(
            'SELECT 1 FROM "ScanDispatchAttempt" a JOIN "ScanAuthorityEpoch" e ON e.id=a."authorityEpochId" WHERE a."operationId"=$1 AND a."attemptId"=$2 AND a."authorityAcceptedAt" IS NOT NULL AND e."isOpen" AND e."closedAt" IS NULL',
            [f.operationId, command.attempt.attemptId]
          )
        ).rowCount === 1
      )
    },
    authorizeRecovery: async () => {
      throw new Error("fixture recovery requires a separate genuine source proof")
    },
  })
  const verify = createScanExecutionActionAuthorityVerifier({ approvedProviderPolicies: new Map() })
  const fence = new PostgresDurableScanAuthorityFence(
    sqlPool(nativePool),
    verify,
    createScanExecutionInvocationGuardWriter(verify)
  )
  const unavailable = async () => {
    throw new Error("no provider action authorized in metadata fixture")
  }
  const service = new SupervisorService({
    journal,
    executor: new DockerRuntimeExecutor(),
    providerGateway: {
      issueGrant: unavailable,
      findGrantByRequest: unavailable,
      revokeGrant: unavailable,
      inspectGrant: unavailable,
    },
    providerGatewayUrl: "http://127.0.0.1:1",
    policy: {
      allowedImages: new Set(
        command.executors.map((p: { spec: { image: string } }) => p.spec.image)
      ),
      allowedNetworks: new Set(
        command.executors.map((p: { spec: { network: string } }) => p.spec.network)
      ),
      allowedProcessCommands: new Set(),
      allowedCwdRoots: [],
      allowedCgroupRoot: "/unavailable",
    },
    signingSecret: originalSecret,
    admission: "open",
    supervisorInstanceId: f.instanceId,
    authorityFence: fence,
  })
  const streamId = `native-stream-${f.operationId}`
  await owner.query(
    'INSERT INTO "ScanSupervisorJournalStream"(id,"authorityEpochId","supervisorInstanceId","originalKeyHash","wrapperKeyHash","updatedAt") VALUES($1,$2,$3,$4,$5,CURRENT_TIMESTAMP)',
    [streamId, f.epochId, f.instanceId, sha256Hex(originalSecret), sha256Hex(wrapperSecret)]
  )
  const authority: SupervisorReceiptAuthority = {
    connectionString: receiptUrl,
    streamId,
    authorityEpochId: f.epochId,
    supervisorInstanceId: f.instanceId,
    originalSigningSecret: originalSecret,
    originalKeyHash: sha256Hex(originalSecret),
    wrapperSigningSecret: wrapperSecret,
    wrapperKeyHash: sha256Hex(wrapperSecret),
    readJournal: (cursor) => service.readJournal(cursor),
  }
  return {
    service,
    journal,
    command,
    authority,
    cleanup: async () => {
      await close()
      await nativePool.end()
      await mirrorPool.end()
      await rm(root, { recursive: true, force: true })
    },
  }
}
