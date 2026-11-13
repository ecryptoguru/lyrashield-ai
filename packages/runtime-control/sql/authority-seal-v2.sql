-- Additive function replacement; stored v1 seals remain byte-for-byte unchanged.
BEGIN;
CREATE OR REPLACE FUNCTION lyrashield_authority.append_seal(
  p_epoch text, p_supervisor text, p_previous text, p_next text, p_expected_head text
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE current_stream lyrashield_authority.stream%ROWTYPE;
DECLARE prior jsonb;
DECLARE next_seal jsonb;
DECLARE expected_head jsonb;
DECLARE current_seal text;
DECLARE existing_seal text;
DECLARE previous_stored text;
DECLARE end_record text;
DECLARE next_revision bigint;
DECLARE first_sequence bigint;
DECLARE last_sequence bigint;
BEGIN
  IF octet_length(p_previous) > 16384 OR octet_length(p_next) > 16384
    OR octet_length(p_expected_head) > 4194304 THEN
    RAISE EXCEPTION 'authority seal exceeds limit' USING ERRCODE = '22023';
  END IF;
  next_seal := p_next::jsonb;
  expected_head := p_expected_head::jsonb;
  IF p_previous <> '' THEN prior := p_previous::jsonb; END IF;
  IF jsonb_typeof(next_seal) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'authority seal is malformed' USING ERRCODE = '22023';
  END IF;
  IF (next_seal->>'schema' IS DISTINCT FROM 'lyrashield-journal-seal/1'
      AND next_seal->>'schema' IS DISTINCT FROM 'lyrashield-journal-seal/2')
    OR NOT (next_seal ?& ARRAY['schema','epochId','supervisorInstanceId','revision','firstSequence','lastSequence',
      'previousSealHash','originalPreviousHash','originalLastHash','wrapperPreviousHash','wrapperLastHash',
      'originalSegmentSha256','wrapperSegmentSha256','originalBytes','wrapperBytes','recordCount',
      'independentHeadHash','observedJournalAckHash','sealHash','signature'])
    OR (next_seal->>'schema' = 'lyrashield-journal-seal/1'
      AND (SELECT count(*) FROM jsonb_object_keys(next_seal)) <> 20)
    OR (next_seal->>'schema' = 'lyrashield-journal-seal/2' AND (
      NOT (next_seal ?& ARRAY['originalSegmentStartSequence','originalByteOffset',
        'wrapperSegmentStartSequence','wrapperByteOffset','recoverySnapshotSha256','recoverySnapshotBytes'])
      OR (SELECT count(*) FROM jsonb_object_keys(next_seal)) <> 26))
    OR next_seal->>'epochId' IS DISTINCT FROM p_epoch
    OR next_seal->>'supervisorInstanceId' IS DISTINCT FROM p_supervisor
    OR expected_head->>'schema' IS DISTINCT FROM 'lyrashield-independent-authority-head/1'
    OR expected_head->>'epochId' IS DISTINCT FROM p_epoch
    OR expected_head->>'supervisorInstanceId' IS DISTINCT FROM p_supervisor
    OR EXISTS (SELECT 1 FROM unnest(ARRAY[
      'previousSealHash','originalPreviousHash','originalLastHash','wrapperPreviousHash',
      'wrapperLastHash','originalSegmentSha256','wrapperSegmentSha256','independentHeadHash',
      'observedJournalAckHash','sealHash','signature'
    ]) AS field WHERE COALESCE(next_seal->>field, '') !~ '^[a-f0-9]{64}$')
    OR COALESCE(next_seal->>'independentHeadHash', '') <>
      encode(sha256(convert_to(p_expected_head, 'UTF8')), 'hex') THEN
    RAISE EXCEPTION 'authority seal is malformed' USING ERRCODE = '22023';
  END IF;
  IF next_seal->>'schema' = 'lyrashield-journal-seal/2' THEN
    IF COALESCE(next_seal->>'recoverySnapshotSha256', '') !~ '^[a-f0-9]{64}$'
      OR EXISTS (SELECT 1 FROM unnest(ARRAY['originalSegmentStartSequence','originalByteOffset',
        'wrapperSegmentStartSequence','wrapperByteOffset','recoverySnapshotBytes']) AS field
        WHERE jsonb_typeof(next_seal->field) IS DISTINCT FROM 'number') THEN
      RAISE EXCEPTION 'authority seal v2 positions are malformed' USING ERRCODE = '22023';
    END IF;
    IF (next_seal->>'originalSegmentStartSequence')::numeric NOT BETWEEN 1 AND 9007199254740991
      OR (next_seal->>'wrapperSegmentStartSequence')::numeric NOT BETWEEN 1 AND 9007199254740991
      OR (next_seal->>'originalByteOffset')::numeric NOT BETWEEN 1 AND 67108864
      OR (next_seal->>'wrapperByteOffset')::numeric NOT BETWEEN 1 AND 67108864
      OR (next_seal->>'recoverySnapshotBytes')::numeric NOT BETWEEN 1 AND 1048576
      OR EXISTS (SELECT 1 FROM unnest(ARRAY['originalSegmentStartSequence','originalByteOffset',
        'wrapperSegmentStartSequence','wrapperByteOffset','recoverySnapshotBytes']) AS field
        WHERE (next_seal->>field)::numeric <> trunc((next_seal->>field)::numeric)) THEN
      RAISE EXCEPTION 'authority seal v2 positions are outside limits' USING ERRCODE = '22023';
    END IF;
  END IF;
  next_revision := (next_seal->>'revision')::bigint;
  first_sequence := (next_seal->>'firstSequence')::bigint;
  last_sequence := (next_seal->>'lastSequence')::bigint;
  IF next_seal->>'schema' = 'lyrashield-journal-seal/2' AND (
    (next_seal->>'originalSegmentStartSequence')::numeric > last_sequence
    OR (next_seal->>'wrapperSegmentStartSequence')::numeric > last_sequence
  ) THEN
    RAISE EXCEPTION 'authority seal v2 segment starts after its last record' USING ERRCODE = '22023';
  END IF;
  IF next_revision IS NULL OR next_revision < 1 OR next_revision > 9007199254740991
    OR first_sequence IS NULL OR last_sequence IS NULL OR first_sequence < 1
    OR last_sequence > 9007199254740991 OR last_sequence < first_sequence
    OR last_sequence - first_sequence + 1 > 32
    OR (next_seal->>'recordCount')::bigint IS DISTINCT FROM last_sequence - first_sequence + 1
    OR COALESCE((next_seal->>'originalBytes')::bigint, 0) NOT BETWEEN 1 AND 1048576
    OR COALESCE((next_seal->>'wrapperBytes')::bigint, 0) NOT BETWEEN 1 AND 1048576
    OR (expected_head->>'sequence') IS NULL
    OR last_sequence > (expected_head->>'sequence')::bigint
    OR (last_sequence = (expected_head->>'sequence')::bigint
      AND next_seal->>'wrapperLastHash' IS DISTINCT FROM expected_head->>'recordHash')
    OR next_revision IS DISTINCT FROM COALESCE((prior->>'revision')::bigint, 0) + 1
    OR first_sequence IS DISTINCT FROM COALESCE((prior->>'lastSequence')::bigint, 0) + 1
    OR next_seal->>'previousSealHash' IS DISTINCT FROM COALESCE(prior->>'sealHash', repeat('0',64))
    OR next_seal->>'originalPreviousHash' IS DISTINCT FROM COALESCE(prior->>'originalLastHash', repeat('0',64))
    OR next_seal->>'wrapperPreviousHash' IS DISTINCT FROM COALESCE(prior->>'wrapperLastHash', repeat('0',64)) THEN
    RAISE EXCEPTION 'authority seal binding mismatch' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO current_stream FROM lyrashield_authority.stream
    WHERE epoch_id = p_epoch AND supervisor_id = p_supervisor FOR UPDATE;
  IF NOT FOUND OR NOT current_stream.active THEN
    RAISE EXCEPTION 'authority stream is unavailable' USING ERRCODE = '55000';
  END IF;
  IF current_stream.head_bytes IS DISTINCT FROM p_expected_head THEN RETURN 'conflict'; END IF;
  SELECT record_bytes INTO end_record FROM lyrashield_authority.record
    WHERE epoch_id = p_epoch AND supervisor_id = p_supervisor AND sequence = last_sequence;
  IF end_record IS NULL OR (end_record::jsonb->>'hash') IS DISTINCT FROM next_seal->>'wrapperLastHash'
    OR (end_record::jsonb->>'sequence') IS DISTINCT FROM next_seal->>'lastSequence' THEN
    RETURN 'conflict';
  END IF;
  SELECT seal_bytes INTO current_seal FROM lyrashield_authority.seal_head
    WHERE epoch_id = p_epoch AND supervisor_id = p_supervisor;
  SELECT seal_bytes INTO existing_seal FROM lyrashield_authority.seal
    WHERE epoch_id = p_epoch AND supervisor_id = p_supervisor AND lyrashield_authority.seal.revision = next_revision;
  IF p_previous <> '' THEN
    SELECT seal_bytes INTO previous_stored FROM lyrashield_authority.seal
      WHERE epoch_id = p_epoch AND supervisor_id = p_supervisor AND lyrashield_authority.seal.revision = next_revision - 1;
    IF previous_stored IS DISTINCT FROM p_previous THEN RETURN 'conflict'; END IF;
  END IF;
  IF current_seal = p_next AND existing_seal = p_next THEN RETURN 'written'; END IF;
  IF COALESCE(current_seal, '') <> p_previous OR existing_seal IS NOT NULL THEN RETURN 'conflict'; END IF;
  INSERT INTO lyrashield_authority.seal VALUES (p_epoch, p_supervisor, next_revision, p_next);
  INSERT INTO lyrashield_authority.seal_head VALUES (p_epoch, p_supervisor, p_next)
    ON CONFLICT (epoch_id, supervisor_id) DO UPDATE SET seal_bytes = EXCLUDED.seal_bytes;
  RETURN 'written';
END;
$$;
COMMIT;
