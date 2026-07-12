-- Q3: composite (workspaceId, createdAt) indexes for paginated list queries.
-- CreateIndex
CREATE INDEX "Scan_workspaceId_createdAt_idx" ON "Scan"("workspaceId", "createdAt");
-- CreateIndex
CREATE INDEX "Finding_workspaceId_createdAt_idx" ON "Finding"("workspaceId", "createdAt");
-- CreateIndex
CREATE INDEX "Integration_workspaceId_createdAt_idx" ON "Integration"("workspaceId", "createdAt");
-- CreateIndex
CREATE INDEX "UsageRecord_workspaceId_createdAt_idx" ON "UsageRecord"("workspaceId", "createdAt");
-- CreateIndex
CREATE INDEX "Report_workspaceId_createdAt_idx" ON "Report"("workspaceId", "createdAt");
-- CreateIndex
CREATE INDEX "Notification_workspaceId_createdAt_idx" ON "Notification"("workspaceId", "createdAt");
-- CreateIndex
CREATE INDEX "Invitation_workspaceId_createdAt_idx" ON "Invitation"("workspaceId", "createdAt");

-- S9: give Report.scanId a real foreign key (was an unenforced scalar). On scan
-- deletion the reference is nulled rather than left dangling.
-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "Scan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- S3: protect the immutable, hash-chained audit trail. A hard DELETE of a
-- Workspace cascades through AuditLog/Finding/Evidence and would irreversibly
-- destroy tenant security history. Workspaces are meant to be SOFT-deleted
-- (deletedAt). This BEFORE DELETE trigger blocks any hard delete of a workspace
-- that still has audit history, forcing the soft-delete path. (Not represented
-- in schema.prisma — like the RLS policies — so it does not affect migrate diff.)
CREATE OR REPLACE FUNCTION prevent_workspace_hard_delete()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "AuditLog" WHERE "workspaceId" = OLD.id) THEN
    RAISE EXCEPTION 'Refusing to hard-delete workspace % with audit history; soft-delete it (set "deletedAt") instead', OLD.id
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS workspace_prevent_hard_delete ON "Workspace";
CREATE TRIGGER workspace_prevent_hard_delete
  BEFORE DELETE ON "Workspace"
  FOR EACH ROW EXECUTE FUNCTION prevent_workspace_hard_delete();
