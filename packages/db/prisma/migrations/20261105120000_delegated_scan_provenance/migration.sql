-- The one-time plaintext proof stays in server memory. Persist only a digest so
-- legacy rows remain unproven and a reused idempotency key cannot imply causality.
ALTER TABLE "agent_operations" ADD COLUMN "admissionProofHash" TEXT;

CREATE TABLE "delegated_scan_provenance" (
  "operationId" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "scanId" TEXT NOT NULL,
  "targetId" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "authorizationVersion" INTEGER NOT NULL,
  "operationInputHash" TEXT NOT NULL,
  "scanExecutionPlanHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "delegated_scan_provenance_pkey" PRIMARY KEY ("operationId"),
  CONSTRAINT "delegated_scan_provenance_authorizationVersion_check"
    CHECK ("authorizationVersion" > 0)
);

CREATE UNIQUE INDEX "delegated_scan_provenance_scanId_key"
  ON "delegated_scan_provenance"("scanId");
CREATE INDEX "delegated_scan_provenance_workspaceId_targetId_createdAt_idx"
  ON "delegated_scan_provenance"("workspaceId", "targetId", "createdAt");
CREATE INDEX "delegated_scan_provenance_workspaceId_connectionId_idx"
  ON "delegated_scan_provenance"("workspaceId", "connectionId");

ALTER TABLE "delegated_scan_provenance"
  ADD CONSTRAINT "delegated_scan_provenance_operationId_fkey"
  FOREIGN KEY ("operationId") REFERENCES "agent_operations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "delegated_scan_provenance"
  ADD CONSTRAINT "delegated_scan_provenance_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "delegated_scan_provenance"
  ADD CONSTRAINT "delegated_scan_provenance_scanId_fkey"
  FOREIGN KEY ("scanId") REFERENCES "Scan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "delegated_scan_provenance"
  ADD CONSTRAINT "delegated_scan_provenance_targetId_fkey"
  FOREIGN KEY ("targetId") REFERENCES "Target"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "delegated_scan_provenance"
  ADD CONSTRAINT "delegated_scan_provenance_connectionId_workspaceId_fkey"
  FOREIGN KEY ("connectionId", "workspaceId")
  REFERENCES "agent_connections"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "delegated_scan_provenance" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "delegated_scan_provenance" FORCE ROW LEVEL SECURITY;
CREATE POLICY "delegated_scan_provenance_workspace" ON "delegated_scan_provenance"
  FOR ALL USING ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

-- The app needs INSERT/SELECT only. Reject updates so a later request cannot
-- redirect an existing operation to another scan or target.
CREATE FUNCTION app.reject_delegated_scan_provenance_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'delegated scan provenance is immutable' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER delegated_scan_provenance_immutable
BEFORE UPDATE ON "delegated_scan_provenance"
FOR EACH ROW EXECUTE FUNCTION app.reject_delegated_scan_provenance_update();
