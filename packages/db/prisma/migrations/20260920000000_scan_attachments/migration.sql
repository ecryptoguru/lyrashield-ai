-- Scan attachments: workspace-scoped supporting files referenced by the
-- immutable scan execution plan. Rows record the stored object's sha256 and
-- encrypted storage URI so scan admission and the worker can prove the exact
-- bytes staged for the engine. Content is untrusted input evidence — never
-- instructions, credentials, scope, or budget.
--
-- Additive and forward-only: one new table, its indexes, and the standard
-- workspace-scoped RLS policy pair. No existing object is altered.

-- CreateTable
CREATE TABLE "ScanAttachment" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mediaType" TEXT NOT NULL,
    "byteLength" INTEGER NOT NULL,
    "checksum" TEXT NOT NULL,
    "storageUri" TEXT NOT NULL,
    "encryptionKeyRef" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "ScanAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ScanAttachment_storageUri_key" ON "ScanAttachment"("storageUri");

-- CreateIndex
CREATE INDEX "ScanAttachment_workspaceId_createdAt_idx" ON "ScanAttachment"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "ScanAttachment_workspaceId_status_idx" ON "ScanAttachment"("workspaceId", "status");

-- AddForeignKey
ALTER TABLE "ScanAttachment"
  ADD CONSTRAINT "ScanAttachment_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Direct workspace-owned table: the same permissive-when-unset /
-- strict-when-bound policy pair as the other workspace-scoped models.
ALTER TABLE "ScanAttachment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ScanAttachment" FORCE ROW LEVEL SECURITY;
CREATE POLICY scanattachment_rls_permissive ON "ScanAttachment"
  FOR ALL USING (app.current_workspace_id() IS NULL);
CREATE POLICY scanattachment_rls_strict ON "ScanAttachment"
  FOR ALL USING ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());
