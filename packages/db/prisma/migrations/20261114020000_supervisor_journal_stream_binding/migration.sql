-- Native supervisor verifies its pinned stream without reading other tenant journals.
CREATE FUNCTION app.scan_supervisor_journal_stream_matches(
  stream_id TEXT, epoch_id TEXT, supervisor_id TEXT, original_key_hash TEXT, wrapper_key_hash TEXT
) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT original_key_hash ~ '^[a-f0-9]{64}$'
    AND wrapper_key_hash ~ '^[a-f0-9]{64}$'
    AND original_key_hash <> wrapper_key_hash
    AND EXISTS(SELECT 1 FROM public."ScanSupervisorJournalStream" s
      JOIN public."ScanAuthorityEpoch" e ON e.id=s."authorityEpochId"
      WHERE s.id=stream_id AND s."authorityEpochId"=epoch_id AND s."supervisorInstanceId"=supervisor_id
        AND s."originalKeyHash"=original_key_hash AND s."wrapperKeyHash"=wrapper_key_hash);
$$;
REVOKE ALL ON FUNCTION app.scan_supervisor_journal_stream_matches(TEXT,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC;
