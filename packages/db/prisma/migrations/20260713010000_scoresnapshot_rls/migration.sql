-- ScoreSnapshot RLS — bring the workspace-scoped ScoreSnapshot table in line
-- with the batch-3 RLS backstop (20260705100000_batch3_rls). ScoreSnapshot was
-- added by a later migration (20260712130000_lyrashield_scorecards_referrals)
-- and missed the RLS pass, leaving the only workspace-scoped table without a
-- DB-level policy.
--
-- Same policy logic as batch 3:
--   * permissive: when app.current_workspace_id is NOT set, all rows visible
--     (backward compat for code paths not yet using withWorkspaceRLS). This
--     preserves the UNAUTHENTICATED public-scorecard read path, which runs with
--     no workspace context set.
--   * strict: when app.current_workspace_id IS set, only matching workspaceId.
--
-- The app.current_workspace_id() helper function is created by the batch-3
-- migration; this migration depends on it already existing.

ALTER TABLE "ScoreSnapshot" ENABLE ROW LEVEL SECURITY;

CREATE POLICY scoresnapshot_rls_permissive ON "ScoreSnapshot"
  FOR ALL USING (app.current_workspace_id() IS NULL);
CREATE POLICY scoresnapshot_rls_strict ON "ScoreSnapshot"
  FOR ALL USING ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());
