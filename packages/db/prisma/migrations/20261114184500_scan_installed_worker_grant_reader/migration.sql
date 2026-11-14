-- Root's installed worker observer supplies only IDs and the credential digest
-- derived from verified protected policy/files. No worker can call this reader.
CREATE FUNCTION app.read_scan_installed_worker_grant(epoch_id TEXT,epoch_number INTEGER,
 worker_instance_id TEXT,worker_grant_id TEXT,credential_digest TEXT)
RETURNS TABLE("expiresAt" TIMESTAMPTZ)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app SET row_security=off AS $$
BEGIN
 IF session_user<>'app_native_origin_reader' OR NOT app.scan_native_origin_reader_eligible()
   OR current_setting('transaction_read_only')<>'on' OR current_setting('transaction_isolation')<>'read committed'
   OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
  RAISE EXCEPTION 'installed worker observation requires restricted READ ONLY root reader' USING ERRCODE='42501';
 END IF;
 RETURN QUERY SELECT g."expiresAt" AT TIME ZONE 'UTC'
 FROM "ScanWorkerInstanceGrant" g JOIN "ScanAuthorityEpoch" e ON e.id=g."authorityEpochId"
 WHERE e.id=epoch_id AND e.epoch=epoch_number AND e."isOpen" AND e."closedAt" IS NULL
   AND g.id=worker_grant_id AND g."instanceId"=worker_instance_id AND g."credentialHash"=credential_digest
   AND credential_digest~'^[a-f0-9]{64}$' AND g."revokedAt" IS NULL
   AND g."issuedAt"<=clock_timestamp() AT TIME ZONE 'UTC' AND g."expiresAt">clock_timestamp() AT TIME ZONE 'UTC';
END $$;
DO $$ DECLARE definition TEXT; original TEXT; replacement TEXT; BEGIN
 SELECT pg_get_functiondef('app.scan_native_origin_reader_eligible()'::regprocedure) INTO definition;
 original := $old$'app.read_scan_native_retirement_guard(text)'::regprocedure))$old$;
 replacement := $new$'app.read_scan_native_retirement_guard(text)'::regprocedure,
       'app.read_scan_installed_worker_grant(text,integer,text,text,text)'::regprocedure))$new$;
 IF position(original IN definition)=0 THEN RAISE EXCEPTION 'unknown native read role closure'; END IF;
 EXECUTE replace(definition,original,replacement);
END $$;
REVOKE ALL ON FUNCTION app.read_scan_installed_worker_grant(TEXT,INTEGER,TEXT,TEXT,TEXT) FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_native_origin_reader') THEN
  GRANT EXECUTE ON FUNCTION app.read_scan_installed_worker_grant(TEXT,INTEGER,TEXT,TEXT,TEXT) TO app_native_origin_reader;
 END IF;
END $$;
