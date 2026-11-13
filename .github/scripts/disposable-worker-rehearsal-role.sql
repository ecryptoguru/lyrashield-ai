-- Common restricted role for fresh, disposable worker rehearsal databases.
CREATE ROLE app_runtime_ci LOGIN PASSWORD 'runtime-ci-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
GRANT CONNECT ON DATABASE lyrashield TO app_runtime_ci;
GRANT USAGE ON SCHEMA public, app TO app_runtime_ci;
DO $$ DECLARE item record; BEGIN FOR item IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('PlatformAdminElevation', 'PlatformAdminChallengeLimit', 'PlatformAdminAudit', 'billing_reconciliation_state','ScanAuthorityEpoch','ScanWorkerInstanceGrant','ScanDispatchOperation','ScanQueueOutbox','ScanDispatchAttempt','ScanDispatchOutbox','ScanDispatchStart','ScanSupervisorReceipt','ScanSupervisorJournalStream','ScanSupervisorJournalRecord','ScanExecutionActionIntent','ScanExecutionInvocationGuard','ScanExecutionInvocationResolution','ScanPhysicalExecution','ScanPhysicalExecutionTransition','ScanDispatchReleaseReceipt') LOOP EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO app_runtime_ci', item.tablename); END LOOP; FOR item IN SELECT sequencename FROM pg_sequences WHERE schemaname = 'public' LOOP EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE public.%I TO app_runtime_ci', item.sequencename); END LOOP; END $$;
GRANT EXECUTE ON FUNCTION app.enqueue_artifact_deletion_task(text, text, text) TO app_runtime_ci;
GRANT EXECUTE ON FUNCTION app.enqueue_scan_attachment_deletion_task(text, text, text) TO app_runtime_ci;
ALTER ROLE app_runtime_ci SET timezone TO 'UTC';
ALTER ROLE lyrashield SET timezone TO 'UTC';
ALTER DATABASE lyrashield SET timezone TO 'UTC';
