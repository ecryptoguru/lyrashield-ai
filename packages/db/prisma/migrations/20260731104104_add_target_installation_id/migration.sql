-- AlterTable
ALTER TABLE "Target" ADD COLUMN     "installationId" TEXT;

-- CreateIndex
CREATE INDEX "Target_installationId_idx" ON "Target"("installationId");

-- CreateIndex
CREATE INDEX "Target_workspaceId_repoProvider_installationId_idx" ON "Target"("workspaceId", "repoProvider", "installationId");
