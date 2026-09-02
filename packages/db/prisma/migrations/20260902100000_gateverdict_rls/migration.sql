-- GateVerdict RLS — bring the workspace-scoped GateVerdict table in line with
-- the batch-3 RLS backstop (20260705100000_batch3_rls). GateVerdict was added
-- by 20260902000000_gate_verdict and missed the RLS pass — the same miss the
-- ScoreSnapshot table had (20260713010000) — leaving app-level workspaceId
-- predicates as the only tenant barrier. This adds the DB-level backstop.
--
-- Same policy logic as batch 3 / ScoreSnapshot:
--   * permissive: when app.current_workspace_id is NOT set, all rows visible
--     (backward compat for code paths not yet using withWorkspaceRLS).
--   * strict: when app.current_workspace_id IS set, only matching workspaceId.
--
-- GateVerdict has no unauthenticated public read path (unlike ScoreSnapshot's
-- public scorecard): every reader goes through withWorkspaceRLS today, so the
-- permissive policy exists purely as a compatibility escape hatch that matches
-- the established pattern.
--
-- FORCE ROW LEVEL SECURITY matches the child-table standard: the table owner
-- must not silently bypass the policies either.
--
-- The app.current_workspace_id() helper function is created by the batch-3
-- migration; this migration depends on it already existing.

ALTER TABLE "GateVerdict" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "GateVerdict" FORCE ROW LEVEL SECURITY;

CREATE POLICY gateverdict_rls_permissive ON "GateVerdict"
  FOR ALL USING (app.current_workspace_id() IS NULL);
CREATE POLICY gateverdict_rls_strict ON "GateVerdict"
  FOR ALL USING ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());
