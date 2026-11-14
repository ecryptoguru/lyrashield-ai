import { createHash, randomBytes } from "node:crypto"
import pg from "pg"
import { installPreparationFixtureRole } from "../../../packages/db/scripts/tests/scan-preparation-fixture"
import { installReceiptRole } from "../../../packages/db/scripts/tests/supervisor-receipt-fixture"
import { installNativeMirrorRole } from "../../../packages/db/scripts/tests/supervisor-native-fixture"
import { installLifecycleFixtureRoles } from "../../../packages/db/scripts/tests/scan-lifecycle-fixture"
import { installNativeOriginFixtureRole } from "../../../packages/db/scripts/tests/native-origin-fixture"
import { deriveSupervisorToolJournalIdentity } from "../../../packages/runtime-control/src/supervisor-tool-identity"

// Invoked only by the finite, isolated root fixture launcher. These are actual
// database roles and SQL checks, never substitutes for native guard callbacks.
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 })
try {
  const baseline = await owner.query('SELECT id,epoch,"isOpen" FROM "ScanAuthorityEpoch"')
  if (
    baseline.rows.length !== 1 ||
    baseline.rows[0].id !== "scan-authority-baseline" ||
    baseline.rows[0].epoch !== 1 ||
    baseline.rows[0].isOpen !== false
  )
    throw new Error("Fresh owned fixture required")
  const epoch = baseline.rows[0].epoch + 1
  const epochId = process.env.LYRASHIELD_AUTHORITY_EPOCH_ID!
  if (!/^disposable-[a-f0-9]{32}$/.test(epochId)) throw new Error("Finite fixture scope required")
  await owner.query(
    'INSERT INTO "ScanAuthorityEpoch"(id,epoch,"isOpen","openKey","openedAt","createdAt","updatedAt") VALUES($1,$2,true,\'open\',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)',
    [epochId, epoch]
  )
  await installPreparationFixtureRole(owner)
  const receiptUrl = await installReceiptRole(owner)
  const mirrorUrl = await installNativeMirrorRole(owner)
  const lifecycle = await installLifecycleFixtureRoles(owner)
  const readerPassword = randomBytes(24).toString("hex")
  await installNativeOriginFixtureRole(owner, readerPassword)
  const readerUrl = new URL(process.env.DISPATCH_PREPARATION_BROKER_DATABASE_URL!)
  readerUrl.username = "app_native_origin_reader"
  readerUrl.password = readerPassword
  const workerPassword = randomBytes(24).toString("hex")
  await owner.query(`CREATE ROLE fixture_worker_runtime LOGIN PASSWORD '${workerPassword}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
    GRANT USAGE ON SCHEMA public,app TO fixture_worker_runtime;
    GRANT SELECT ON "Scan","Workspace","Target","Policy","ScanEvent","UserScanSlot","ScanCapacityReservation","BillingAccount","UsageRecord","MinutePack",users TO fixture_worker_runtime;`)
  const workerUrl = new URL(readerUrl)
  workerUrl.username = "fixture_worker_runtime"
  workerUrl.password = workerPassword
  const originalSecret = randomBytes(32).toString("hex")
  const wrapperSecret = randomBytes(32).toString("hex")
  const sha = (value: string) => createHash("sha256").update(value).digest("hex")
  const instanceId = `fixture-supervisor-${epochId.slice(11, 27)}`
  const streamId = `fixture-stream-${epochId.slice(11, 27)}`
  const toolIdentity = deriveSupervisorToolJournalIdentity({
    streamId,
    authorityEpochId: epochId,
    supervisorInstanceId: instanceId,
    originalSigningSecret: originalSecret,
    wrapperSigningSecret: wrapperSecret,
  })
  for (const identity of [
    {
      streamId,
      supervisorInstanceId: instanceId,
      originalKeyHash: sha(originalSecret),
      wrapperKeyHash: sha(wrapperSecret),
    },
    toolIdentity,
  ]) {
    await owner.query(
      'INSERT INTO "ScanSupervisorJournalStream"(id,"authorityEpochId","supervisorInstanceId","originalKeyHash","wrapperKeyHash","updatedAt") VALUES($1,$2,$3,$4,$5,CURRENT_TIMESTAMP)',
      [
        identity.streamId,
        epochId,
        identity.supervisorInstanceId,
        identity.originalKeyHash,
        identity.wrapperKeyHash,
      ]
    )
    await owner.query(
      "INSERT INTO lyrashield_authority.stream(epoch_id,supervisor_id,active) VALUES($1,$2,true)",
      [epochId, identity.supervisorInstanceId]
    )
  }
  // Capture the actual readonly native-origin query after secret provisioning.
  await owner.query("ALTER SYSTEM SET log_statement = 'all'")
  await owner.query("SELECT pg_reload_conf()")
  process.stdout.write(
    JSON.stringify({
      epoch,
      preparationUrl: process.env.DISPATCH_PREPARATION_BROKER_DATABASE_URL,
      receiptUrl,
      mirrorUrl,
      readerUrl: readerUrl.toString(),
      workerUrl: workerUrl.toString(),
      ...lifecycle,
      originalSecret,
      wrapperSecret,
      journalAuthority: {
        streamId,
        authorityEpochId: epochId,
        supervisorInstanceId: instanceId,
        originalKeyHash: sha(originalSecret),
        wrapperKeyHash: sha(wrapperSecret),
        socketPath: "/run/lyrashield/supervisor.sock",
      },
    }) + "\n"
  )
} catch {
  process.stderr.write("Owned disposable database bootstrap failed\n")
  process.exitCode = 1
} finally {
  await owner.end()
}
