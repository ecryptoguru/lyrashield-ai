-- Scan-detail polling reads scan events by scanId + deletedAt ordered on
-- (createdAt, id), and target-domain status resolves the workspace audit
-- trail by action + resource. Composite indexes cover both.
CREATE INDEX "ScanEvent_scanId_deletedAt_createdAt_id_idx" ON "ScanEvent"("scanId", "deletedAt", "createdAt", "id");
CREATE INDEX "AuditLog_workspaceId_action_resourceType_resourceId_idx" ON "AuditLog"("workspaceId", "action", "resourceType", "resourceId");
