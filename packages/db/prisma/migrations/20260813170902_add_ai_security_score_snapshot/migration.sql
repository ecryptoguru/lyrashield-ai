-- CreateTable
CREATE TABLE "AiSecurityScoreSnapshot" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "scanId" TEXT NOT NULL,
    "modelVersion" TEXT NOT NULL,
    "score" INTEGER,
    "grade" TEXT,
    "breakdown" JSONB NOT NULL,
    "evidenceQuality" JSONB NOT NULL,
    "methodology" TEXT NOT NULL,
    "assessedCount" INTEGER NOT NULL,
    "totalControls" INTEGER NOT NULL,
    "shareEligible" BOOLEAN NOT NULL DEFAULT false,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiSecurityScoreSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AiSecurityScoreSnapshot_scanId_key" ON "AiSecurityScoreSnapshot"("scanId");

-- CreateIndex
CREATE INDEX "AiSecurityScoreSnapshot_workspaceId_idx" ON "AiSecurityScoreSnapshot"("workspaceId");

-- CreateIndex
CREATE INDEX "AiSecurityScoreSnapshot_workspaceId_computedAt_idx" ON "AiSecurityScoreSnapshot"("workspaceId", "computedAt");

-- CreateIndex
CREATE INDEX "AiSecurityScoreSnapshot_workspaceId_targetId_computedAt_idx" ON "AiSecurityScoreSnapshot"("workspaceId", "targetId", "computedAt");

-- CreateIndex
CREATE INDEX "AiSecurityScoreSnapshot_targetId_computedAt_idx" ON "AiSecurityScoreSnapshot"("targetId", "computedAt");

-- AddForeignKey
ALTER TABLE "AiSecurityScoreSnapshot" ADD CONSTRAINT "AiSecurityScoreSnapshot_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiSecurityScoreSnapshot" ADD CONSTRAINT "AiSecurityScoreSnapshot_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "Target"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiSecurityScoreSnapshot" ADD CONSTRAINT "AiSecurityScoreSnapshot_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "Scan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
