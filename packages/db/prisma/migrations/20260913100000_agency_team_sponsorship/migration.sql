ALTER TABLE "Workspace" ADD COLUMN "agencySponsorAccountId" TEXT;
ALTER TABLE "Scan" ADD COLUMN "sponsorAccountId" TEXT;

CREATE INDEX "Workspace_agencySponsorAccountId_idx" ON "Workspace"("agencySponsorAccountId");
CREATE INDEX "Scan_sponsorAccountId_idx" ON "Scan"("sponsorAccountId");
