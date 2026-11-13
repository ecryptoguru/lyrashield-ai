-- Install only with a dedicated migration owner in the trusted authority database.
-- No application/worker role owns this schema or receives its privileges.
-- Stream activation requires external signed reconciliation; runtime cannot provision it.
BEGIN;
CREATE SCHEMA lyrashield_authority;
REVOKE ALL ON SCHEMA lyrashield_authority FROM PUBLIC;

CREATE TABLE lyrashield_authority.stream (
  epoch_id text NOT NULL,
  supervisor_id text NOT NULL,
  active boolean NOT NULL DEFAULT false,
  head_bytes text,
  PRIMARY KEY (epoch_id, supervisor_id),
  CHECK (octet_length(head_bytes) <= 4194304)
);
CREATE TABLE lyrashield_authority.record (
  epoch_id text NOT NULL,
  supervisor_id text NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0 AND sequence <= 9007199254740991),
  record_bytes text NOT NULL CHECK (octet_length(record_bytes) <= 4194304),
  PRIMARY KEY (epoch_id, supervisor_id, sequence),
  FOREIGN KEY (epoch_id, supervisor_id) REFERENCES lyrashield_authority.stream
);
REVOKE ALL ON ALL TABLES IN SCHEMA lyrashield_authority FROM PUBLIC;

CREATE FUNCTION lyrashield_authority.read_head(p_epoch text, p_supervisor text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE current_stream lyrashield_authority.stream%ROWTYPE;
BEGIN
  SELECT * INTO current_stream FROM lyrashield_authority.stream
    WHERE epoch_id = p_epoch AND supervisor_id = p_supervisor;
  IF NOT FOUND OR NOT current_stream.active THEN
    RAISE EXCEPTION 'authority stream is unavailable' USING ERRCODE = '55000';
  END IF;
  RETURN current_stream.head_bytes;
END;
$$;

CREATE FUNCTION lyrashield_authority.read_record(p_epoch text, p_supervisor text, p_sequence bigint)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE result text;
BEGIN
  PERFORM lyrashield_authority.read_head(p_epoch, p_supervisor);
  SELECT record_bytes INTO result FROM lyrashield_authority.record
    WHERE epoch_id = p_epoch AND supervisor_id = p_supervisor AND sequence = p_sequence;
  RETURN result;
END;
$$;

CREATE FUNCTION lyrashield_authority.append_record(
  p_epoch text, p_supervisor text, p_previous text, p_head text, p_record text
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE current_stream lyrashield_authority.stream%ROWTYPE;
DECLARE existing_record text;
DECLARE new_head jsonb;
DECLARE new_record jsonb;
DECLARE predecessor jsonb;
DECLARE next_sequence bigint;
BEGIN
  IF octet_length(p_head) > 4194304 OR octet_length(p_record) > 4194304
    OR octet_length(p_previous) > 4194304 THEN
    RAISE EXCEPTION 'authority record exceeds limit' USING ERRCODE = '22023';
  END IF;
  new_head := p_head::jsonb; new_record := p_record::jsonb;
  IF new_head->>'schema' IS DISTINCT FROM 'lyrashield-independent-authority-head/1'
    OR new_record->>'version' IS DISTINCT FROM '1'
    OR jsonb_typeof(new_record->'payload') IS DISTINCT FROM 'object'
    OR EXISTS (SELECT 1 FROM unnest(ARRAY['epochId','operationId','scanId','workspaceId','attemptId','eventId']) AS field
       WHERE COALESCE(new_head->>field, '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
    OR COALESCE(new_head->>'supervisorInstanceId', '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    OR COALESCE(new_head->>'signature', '') !~ '^[a-f0-9]{64}$'
    OR COALESCE(new_record->>'signature', '') !~ '^[a-f0-9]{64}$'
    OR COALESCE(new_head->>'previousHash', '') !~ '^[a-f0-9]{64}$'
    OR COALESCE(new_head->>'recordHash', '') !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'authority record is malformed' USING ERRCODE = '22023';
  END IF;
  next_sequence := (new_head->>'sequence')::bigint;
  IF p_previous <> '' THEN predecessor := p_previous::jsonb; END IF;
  IF (new_head->>'epochId') IS DISTINCT FROM p_epoch
    OR (new_head->>'supervisorInstanceId') IS DISTINCT FROM p_supervisor
    OR (new_record->'payload'->>'epochId') IS DISTINCT FROM p_epoch
    OR next_sequence IS DISTINCT FROM COALESCE((predecessor->>'sequence')::bigint, 0) + 1
    OR (new_head->>'previousHash') IS DISTINCT FROM COALESCE(predecessor->>'recordHash', repeat('0',64))
    OR (new_head->>'sequence') IS DISTINCT FROM (new_record->>'sequence')
    OR (new_head->>'previousHash') IS DISTINCT FROM (new_record->>'previousHash')
    OR (new_head->>'recordHash') IS DISTINCT FROM (new_record->>'hash')
    OR EXISTS (SELECT 1 FROM unnest(ARRAY['epochId','operationId','scanId','workspaceId','attemptId','eventId']) AS field
       WHERE (new_head->>field) IS DISTINCT FROM (new_record->'payload'->>field)) THEN
    RAISE EXCEPTION 'authority append binding mismatch' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO current_stream FROM lyrashield_authority.stream
    WHERE epoch_id = p_epoch AND supervisor_id = p_supervisor FOR UPDATE;
  IF NOT FOUND OR NOT current_stream.active THEN
    RAISE EXCEPTION 'authority stream is unavailable' USING ERRCODE = '55000';
  END IF;
  SELECT record_bytes INTO existing_record FROM lyrashield_authority.record
    WHERE epoch_id = p_epoch AND supervisor_id = p_supervisor AND sequence = next_sequence;
  IF current_stream.head_bytes = p_head AND existing_record = p_record THEN RETURN 'written'; END IF;
  IF COALESCE(current_stream.head_bytes, '') <> p_previous OR existing_record IS NOT NULL THEN
    RETURN 'conflict';
  END IF;
  INSERT INTO lyrashield_authority.record VALUES (p_epoch, p_supervisor, next_sequence, p_record);
  UPDATE lyrashield_authority.stream SET head_bytes = p_head
    WHERE epoch_id = p_epoch AND supervisor_id = p_supervisor;
  RETURN 'written';
END;
$$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA lyrashield_authority FROM PUBLIC;
COMMIT;
