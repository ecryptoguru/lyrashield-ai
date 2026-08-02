-- DB-07: fail-closed RLS for child tables that do not carry a workspaceId column.
-- Rows are scoped through the workspaceId of their parent. The Prisma client
-- extension already guards the workspace-scoped tables; this migration adds the
-- database-level backstop for tables that are structurally scoped through FKs.

ALTER TABLE "ScanEvent" FORCE ROW LEVEL SECURITY;
ALTER TABLE "Evidence" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ScanResultManifest" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ScanCoverageReceipt" FORCE ROW LEVEL SECURITY;
ALTER TABLE "FixProposal" FORCE ROW LEVEL SECURITY;
ALTER TABLE "PullRequest" FORCE ROW LEVEL SECURITY;
ALTER TABLE "Ticket" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ScorecardShare" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ScorecardEvent" FORCE ROW LEVEL SECURITY;

-- ScanEvent is scoped through Scan.
CREATE POLICY scanevent_rls_strict ON "ScanEvent"
  FOR ALL USING (EXISTS (SELECT 1 FROM "Scan" WHERE id = "scanId" AND "workspaceId" = app.current_workspace_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM "Scan" WHERE id = "scanId" AND "workspaceId" = app.current_workspace_id()));

-- Evidence is scoped through Finding.
CREATE POLICY evidence_rls_strict ON "Evidence"
  FOR ALL USING (EXISTS (SELECT 1 FROM "Finding" WHERE id = "findingId" AND "workspaceId" = app.current_workspace_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM "Finding" WHERE id = "findingId" AND "workspaceId" = app.current_workspace_id()));

-- ScanResultManifest is scoped through Scan (scanId is unique).
CREATE POLICY scanresultmanifest_rls_strict ON "ScanResultManifest"
  FOR ALL USING (EXISTS (SELECT 1 FROM "Scan" WHERE id = "scanId" AND "workspaceId" = app.current_workspace_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM "Scan" WHERE id = "scanId" AND "workspaceId" = app.current_workspace_id()));

-- ScanCoverageReceipt is scoped through Scan.
CREATE POLICY scancoveragereceipt_rls_strict ON "ScanCoverageReceipt"
  FOR ALL USING (EXISTS (SELECT 1 FROM "Scan" WHERE id = "scanId" AND "workspaceId" = app.current_workspace_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM "Scan" WHERE id = "scanId" AND "workspaceId" = app.current_workspace_id()));

-- FixProposal is scoped through Finding.
CREATE POLICY fixproposal_rls_strict ON "FixProposal"
  FOR ALL USING (EXISTS (SELECT 1 FROM "Finding" WHERE id = "findingId" AND "workspaceId" = app.current_workspace_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM "Finding" WHERE id = "findingId" AND "workspaceId" = app.current_workspace_id()));

-- PullRequest is scoped through FixProposal -> Finding.
CREATE POLICY pullrequest_rls_strict ON "PullRequest"
  FOR ALL USING (
    EXISTS (
      SELECT 1
      FROM "FixProposal" fp
      JOIN "Finding" f ON fp."findingId" = f.id
      WHERE fp.id = "fixProposalId"
        AND f."workspaceId" = app.current_workspace_id()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM "FixProposal" fp
      JOIN "Finding" f ON fp."findingId" = f.id
      WHERE fp.id = "fixProposalId"
        AND f."workspaceId" = app.current_workspace_id()
    )
  );

-- Ticket is scoped through Finding.
CREATE POLICY ticket_rls_strict ON "Ticket"
  FOR ALL USING (EXISTS (SELECT 1 FROM "Finding" WHERE id = "findingId" AND "workspaceId" = app.current_workspace_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM "Finding" WHERE id = "findingId" AND "workspaceId" = app.current_workspace_id()));

-- ScorecardShare is scoped through ScoreSnapshot.
CREATE POLICY scorecardshare_rls_strict ON "ScorecardShare"
  FOR ALL USING (EXISTS (SELECT 1 FROM "ScoreSnapshot" WHERE id = "snapshotId" AND "workspaceId" = app.current_workspace_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM "ScoreSnapshot" WHERE id = "snapshotId" AND "workspaceId" = app.current_workspace_id()));

-- ScorecardEvent is scoped through ScorecardShare -> ScoreSnapshot.
CREATE POLICY scorecardevent_rls_strict ON "ScorecardEvent"
  FOR ALL USING (
    EXISTS (
      SELECT 1
      FROM "ScorecardShare" ss
      JOIN "ScoreSnapshot" s ON ss."snapshotId" = s.id
      WHERE ss.id = "shareId"
        AND s."workspaceId" = app.current_workspace_id()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM "ScorecardShare" ss
      JOIN "ScoreSnapshot" s ON ss."snapshotId" = s.id
      WHERE ss.id = "shareId"
        AND s."workspaceId" = app.current_workspace_id()
    )
  );
