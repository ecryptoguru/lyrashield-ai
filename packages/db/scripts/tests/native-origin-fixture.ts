import { randomBytes } from "node:crypto"
import pg from "pg"

/** Provision only the already-owned loopback disposable PostgreSQL fixture. */
export async function installNativeOriginFixtureRole(owner: pg.Pool, password48?: string) {
  const runtimeUrl = process.env.DISPATCH_PREPARATION_BROKER_DATABASE_URL
  const { assertDisposableDatabasePair } =
    await import("../../../../.github/scripts/vitest-database-env.mjs")
  const fixtureEnvironment = { ...process.env, DATABASE_URL: owner.options.connectionString }
  assertDisposableDatabasePair({ ...fixtureEnvironment, RLS_RUNTIME_DATABASE_URL: runtimeUrl })
  if (password48 !== undefined && !/^[a-f0-9]{48}$/.test(password48))
    throw new Error("Disposable native reader requires a generated fixture password")
  let readerUrl = process.env.NATIVE_ORIGIN_READER_DATABASE_URL
  if (!readerUrl) {
    if (
      (await owner.query("SELECT 1 FROM pg_roles WHERE rolname='app_native_origin_reader'"))
        .rowCount &&
      !password48
    )
      throw new Error("Disposable native reader credentials are unavailable")
    const password = password48 ?? randomBytes(24).toString("hex")
    if (
      !(await owner.query("SELECT 1 FROM pg_roles WHERE rolname='app_native_origin_reader'"))
        .rowCount
    )
      await owner.query(
        `CREATE ROLE app_native_origin_reader LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT`
      )
    const url = new URL(process.env.DISPATCH_PREPARATION_BROKER_DATABASE_URL!)
    url.username = "app_native_origin_reader"
    url.password = password
    readerUrl = url.toString()
  }
  assertDisposableDatabasePair({ ...fixtureEnvironment, RLS_RUNTIME_DATABASE_URL: readerUrl })
  await owner.query(`
      DO $$ BEGIN EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC,app_native_origin_reader',current_database()); END $$;
      GRANT USAGE ON SCHEMA public,app TO app_native_origin_reader;
      GRANT SELECT ON "Workspace","WorkspaceMember",users,"BillingAccount",agent_connections,agent_operations,delegated_scan_provenance,"Target","Policy","Scan","UserScanSlot","ScanCapacityReservation","ScanAuthorityEpoch","ScanWorkerInstanceGrant","ScanDispatchOperation","ScanDispatchAttempt","ScanDispatchOutbox","ScanPhysicalExecution","ScanDispatchStart","ScanSupervisorReceipt","ScanSupervisorJournalStream","ScanSupervisorJournalRecord","ScanExecutionActionIntent","ScanExecutionInvocationGuard","ScanExecutionInvocationResolution" TO app_native_origin_reader;
      GRANT EXECUTE ON FUNCTION app.scan_native_origin_reader_eligible(),app.require_scan_native_origin_reader(),app.scan_native_executor_origin_gate_held(text),app.read_scan_native_origin_guard(text),app.scan_preparation_context(text),app.scan_preparation_plan_json(jsonb),app.current_workspace_id(),app.current_account_id(),app.check_scan_current_execution_authority(text,timestamp,text),app.scan_policy_digest(text),app.scan_dispatch_scope_digest(text),app.scan_target_snapshot_digest(text),public.digest(bytea,text) TO app_native_origin_reader;
      GRANT EXECUTE ON FUNCTION app.read_scan_native_retained_guard(text),app.read_scan_native_retirement_guard(text) TO app_native_origin_reader;
      GRANT EXECUTE ON FUNCTION app.read_scan_installed_worker_grant(text,integer,text,text,text) TO app_native_origin_reader;
      DO $$ BEGIN
        IF to_regprocedure('app.read_scan_installed_worker_operations(text,integer,text,text,text,text,text)') IS NOT NULL THEN
          GRANT EXECUTE ON FUNCTION app.read_scan_installed_worker_operations(text,integer,text,text,text,text,text) TO app_native_origin_reader;
        END IF;
      END $$;
      DO $$ BEGIN
        IF to_regprocedure('app.read_scan_installed_worker_cleanup_grant(text,integer,text,text,text)') IS NOT NULL THEN
          GRANT EXECUTE ON FUNCTION app.read_scan_installed_worker_cleanup_grant(text,integer,text,text,text),app.read_scan_installed_worker_cleanup_operations(text,integer,text,text,text,text,text) TO app_native_origin_reader;
        END IF;
      END $$;
      GRANT SELECT,INSERT ON "ScanExecutionInvocationGuard" TO dispatch_prepare_broker;
      GRANT SELECT ON "ScanExecutionInvocationResolution" TO dispatch_prepare_broker;
    `)
  const probe = new pg.Pool({ connectionString: readerUrl, max: 1 })
  try {
    const connection = await probe.connect()
    try {
      await connection.query("BEGIN READ ONLY")
      await connection.query("SELECT app.require_scan_native_origin_reader()")
    } finally {
      await connection.query("ROLLBACK")
      connection.release()
    }
  } finally {
    await probe.end()
  }
  return readerUrl
}
