-- Keep the immutable score-snapshot scope trigger independent of a caller's
-- mutable search_path. All referenced relations live in public.
CREATE OR REPLACE FUNCTION app.validate_ai_security_score_snapshot_scope()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "Scan"
    WHERE "id" = NEW."scanId"
      AND "workspaceId" = NEW."workspaceId"
      AND "targetId" = NEW."targetId"
      AND "deletedAt" IS NULL
  ) THEN
    RAISE EXCEPTION 'AI security score snapshot scan/target/workspace mismatch'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "Target"
    WHERE "id" = NEW."targetId"
      AND "workspaceId" = NEW."workspaceId"
      AND "deletedAt" IS NULL
  ) THEN
    RAISE EXCEPTION 'AI security score snapshot target/workspace mismatch'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;
