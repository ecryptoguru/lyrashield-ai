-- Secure AI App Security score snapshots as first-class workspace data.
-- The original score migration created the table without RLS, which meant a
-- globally-known scan ID could bypass the workspace boundary at the database.

ALTER TABLE "AiSecurityScoreSnapshot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AiSecurityScoreSnapshot" FORCE ROW LEVEL SECURITY;

CREATE POLICY aisecurityscoresnapshot_rls_strict ON "AiSecurityScoreSnapshot"
  FOR ALL USING ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

-- PostgreSQL cannot express this cross-table invariant as a CHECK constraint.
-- Keep it at the database boundary so a future service cannot associate a
-- snapshot with a scan or target from another workspace.
CREATE OR REPLACE FUNCTION app.validate_ai_security_score_snapshot_scope()
RETURNS trigger
LANGUAGE plpgsql
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

CREATE TRIGGER ai_security_score_snapshot_scope_guard
BEFORE INSERT OR UPDATE OF "workspaceId", "targetId", "scanId"
ON "AiSecurityScoreSnapshot"
FOR EACH ROW EXECUTE FUNCTION app.validate_ai_security_score_snapshot_scope();
